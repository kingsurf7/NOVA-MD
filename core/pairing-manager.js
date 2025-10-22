const pino = require("pino");
const path = require("path");
const colors = require("@colors/colors/safe");
const CFonts = require("cfonts");
const fs = require("fs-extra");
const chalk = require("chalk");
const readline = require("readline");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  PHONENUMBER_MCC,
  Browsers
} = require("@whiskeysockets/baileys");
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const log = require('../utils/logger')(module);

class PairingManager {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.sessionName = "pairing-auth";
    this.supabase = createClient(config.supabase.url, config.supabase.key);
    this.isPairingMode = process.argv.includes("--use-pairing-code");
    this.activePairings = new Map();
    this.nodeApiUrl = process.env.NODE_API_URL || 'http://localhost:3000';
    this.retryCounts = new Map();
    this.pairingTimeouts = new Map();
    this.connectionTimeouts = new Map();
  }

  async initializePairing(userId, userData, phoneNumber = null) {
    try {
      log.info(`🔐 Initialisation pairing pour ${userId}`);
      
      // CRÉER le dossier pairing-auth s'il n'existe pas
      const pairingAuthPath = path.join(process.cwd(), this.sessionName);
      await fs.ensureDir(pairingAuthPath);
      
      const sessionExists = await fs.pathExists(pairingAuthPath);
      if (sessionExists) {
        log.info("🧹 Nettoyage de la session existante");
        await fs.emptyDir(pairingAuthPath);
        await delay(2000);
      }

      this.retryCounts.set(userId, 0);
      this.cleanupUserTimeouts(userId);

      if (phoneNumber) {
        log.info(`📱 Utilisation du numéro fourni pour ${userId}: ${phoneNumber}`);
        return await this.startPairingWithPhone(userId, userData, phoneNumber);
      } else {
        return await this.startPairingProcess(userId, userData);
      }
      
    } catch (error) {
      log.error('❌ Erreur initialisation pairing:', error);
      throw error;
    }
  }

  cleanupUserTimeouts(userId) {
    const pairingTimeout = this.pairingTimeouts.get(userId);
    const connectionTimeout = this.connectionTimeouts.get(userId);
    
    if (pairingTimeout) {
      clearTimeout(pairingTimeout);
      this.pairingTimeouts.delete(userId);
    }
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      this.connectionTimeouts.delete(userId);
    }
  }

  async startPairingProcess(userId, userData) {
    // UTILISER le chemin absolu
    const pairingAuthPath = path.join(process.cwd(), this.sessionName);
    const { state, saveCreds } = await useMultiFileAuthState(pairingAuthPath);
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const question = (text) => new Promise((resolve) => rl.question(text, resolve));

    try {
      const socket = makeWASocket({
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 300000,
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
        mobile: false
      });

      if (this.isPairingMode && !socket.authState.creds.registered) {
        await this.handlePairingCode(socket, userId, userData, question, rl);
      }

      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === "open") {
          log.success(`✅ Connexion WhatsApp réussie via pairing pour ${userId}`);
          await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, rl);
          
        } else if (connection === "close") {
          await this.handleConnectionClose(null, lastDisconnect, userId, rl);
        }
      });

      socket.ev.on("creds.update", saveCreds);

      this.activePairings.set(userId, { socket, rl, userData });

      return { success: true, method: 'pairing' };

    } catch (error) {
      rl.close();
      log.error('❌ Erreur processus pairing:', error);
      throw error;
    }
  }

  async startPairingWithPhone(userId, userData, phoneNumber) {
     
    // NETTOYER COMPLÈTEMENT les sessions existantes
    const pairingAuthPath = path.join(process.cwd(), this.sessionName);
    const sessionsPath = path.join(process.cwd(), 'sessions'); 
    
    try {
        // Supprimer complètement les dossiers de session existants
        if (await fs.pathExists(pairingAuthPath)) {
            await fs.remove(pairingAuthPath);
        }
        
        // Nettoyer les anciennes sessions pour cet utilisateur
        if (await fs.pathExists(sessionsPath)) {
            const sessionDirs = await fs.readdir(sessionsPath);
            for (const dir of sessionDirs) {
                if (dir.includes(userId.toString())) {
                    await fs.remove(path.join(sessionsPath, dir));
                }
            }
        }
        
        // Recréer le dossier d'authentification
        await fs.ensureDir(pairingAuthPath);
        } catch (cleanupError) {
        log.warn(`⚠️ Erreur nettoyage sessions: ${cleanupError.message}`);
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(pairingAuthPath);
    
    try {
      const socket = makeWASocket({
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        connectTimeoutMs: 300000,
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 5000,
        maxRetries: 5,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        fireInitQueries: true,
        mobile: false,
        appStateMacVerification: {
          patch: true,
          snapshot: false
        },
        transactionOpts: {
          maxCommitRetries: 3,
          delayBeforeRetry: 2000
        },
        getMessage: async () => undefined, 
        msgRetryCounterCache: new Map(),
        messageResendCache: new Map() 
      });

      let pairingCodeSent = false;
      let pairingSuccess = false;
      let pairingCode = null;
      
      const currentRetryCount = this.retryCounts.get(userId) || 0;
      
      const pairingTimeout = setTimeout(async () => {
        if (!pairingCodeSent && currentRetryCount < 3) {
          try {
            log.info(`📱 Génération du code pairing pour le numéro: ${phoneNumber}`);
            
            pairingCode = await socket.requestPairingCode(phoneNumber);
            pairingCode = pairingCode?.match(/.{1,4}/g)?.join("-") || pairingCode;
            
            if (!pairingCode) {
              throw new Error('Aucun code pairing généré');
            }
            
            log.success(`🔑 Code de pairing généré pour ${userId}: ${pairingCode}`);
            
            const sent = await this.sendPairingCodeViaHTTP(userId, pairingCode, phoneNumber);
            if (sent) {
              pairingCodeSent = true;
              
              const connectionTimeout = setTimeout(async () => {
                if (!pairingSuccess) {
                  log.warn(`⏰ Timeout de connexion pairing pour ${userId}`);
                  await this.sendMessageViaHTTP(userId,
                    "⏰ *Timeout de connexion*\n\n" +
                    "Le code de pairing n'a pas été utilisé dans les 10 minutes.\n\n" +
                    "Le code a expiré. Veuillez:\n" +
                    "1. Redémarrer le processus avec /connect\n" +
                    "2. Choisir à nouveau 'Pairing Code'\n" +
                    "3. Entrer votre numéro\n" +
                    "4. Utiliser le nouveau code immédiatement\n\n" +
                    "Ou utilisez la méthode QR Code pour une connexion plus rapide."
                  );
                  await this.cleanupPairing(userId);
                }
              }, 600000);

              this.connectionTimeouts.set(userId, connectionTimeout);

              log.info(`✅ Code pairing ${pairingCode} envoyé à ${userId}`);
              
      
              
            } else {
              throw new Error('Échec envoi du code pairing');
            }

          } catch (error) {
            log.error('❌ Erreur génération code pairing:', error);
            
            const retryCount = currentRetryCount + 1;
            this.retryCounts.set(userId, retryCount);
            
            if (retryCount < 3) {
              log.info(`🔄 Tentative ${retryCount}/3 de pairing pour ${userId}`);
              await this.sendMessageViaHTTP(userId,
                `🔄 *Tentative ${retryCount}/3 en cours...*\n\n` +
                `Problème temporaire avec WhatsApp. Nouvelle tentative automatique...`
              );
              
              setTimeout(() => {
                this.startPairingWithPhone(userId, userData, phoneNumber);
              }, 10000);
              return;
            }
            
            await this.sendMessageViaHTTP(userId, 
              "❌ *Impossible de générer un code pairing*\n\n" +
              "Après 3 tentatives, le service WhatsApp ne répond pas.\n\n" +
              "Causes possibles:\n" +
              "• Service WhatsApp temporairement saturé\n" +
              "• Problème réseau avec les serveurs WhatsApp\n" +
              "• Restrictions régionales temporaires\n\n" +
              "Solutions recommandées:\n" +
              "• Utilisez la méthode *QR Code* (plus stable)\n" +
              "• Réessayez dans 10-15 minutes\n" +
              "• Contactez le support si le problème persiste"
            );
            
            await this.cleanupPairing(userId);
          }
        }
      }, 10000);

      this.pairingTimeouts.set(userId, pairingTimeout);

      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        
        const connectionInfo = { 
          connection, 
          hasQR: !!qr,
          isNewLogin,
          error: lastDisconnect?.error?.message,
          statusCode: lastDisconnect?.error?.output?.statusCode
        };
        
        log.info(`🔌 [PAIRING] ${userId} - Connection update:`, connectionInfo);

        if (qr) {
          log.info(`⚠️ QR ignoré pour ${userId} (mode pairing actif)`);
          return;
        }
        
        if (connection === "open") {
          this.cleanupUserTimeouts(userId);
          pairingSuccess = true;
          log.success(`🎉 CONNEXION RÉUSSIE via pairing pour ${userId}`);
          await delay(2000);
          await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, null);
          
        } else if (connection === "close") {
          this.cleanupUserTimeouts(userId);
          const reason = lastDisconnect?.error;
          const statusCode = reason?.output?.statusCode;
          
          log.error(`❌ Connexion fermée pour ${userId}:`, {
            message: reason?.message,
            statusCode: statusCode,
            pairingCode: pairingCode
          });
          
          if (!pairingSuccess) {
            let errorMessage = "❌ *Échec de connexion pairing*\n\n";
            
            if (statusCode === 515 || reason?.message?.includes('Stream Errored')) {
              errorMessage += "Problème de connexion réseau avec WhatsApp.\n\n";
              errorMessage += "C'est temporaire - souvent dû à:\n";
              errorMessage += "• Surcharge des serveurs WhatsApp\n";
              errorMessage += "• Problèmes réseau temporaires\n";
              errorMessage += "• Maintenance des serveurs\n\n";
              errorMessage += "🔄 *Reconnexion automatique en cours...*";
              
              const retryCount = currentRetryCount + 1;
              if (retryCount < 2) {
                this.retryCounts.set(userId, retryCount);
                setTimeout(() => {
                  log.info(`🔄 Reconnexion automatique ${retryCount}/2 pour ${userId}`);
                  this.startPairingWithPhone(userId, userData, phoneNumber);
                }, 10000);
                return;
              }
            } else if (statusCode === 401) {
              errorMessage += "Le code de pairing a expiré ou est invalide.\n";
            } else if (reason?.message?.includes('refs attempts ended')) {
              errorMessage += "Trop de tentatives. WhatsApp a bloqué temporairement.\n";
            } else {
              errorMessage += "Problème de connexion inattendu.\n";
            }
            
            errorMessage += "\n🎯 *Solutions recommandées:*\n";
            errorMessage += "• Utilisez la méthode *QR Code* (plus fiable)\n";
            errorMessage += "• Réessayez dans 5-10 minutes\n";
            errorMessage += "• Vérifiez votre connexion Internet\n";
            errorMessage += "• Contactez le support si besoin";
            
            await this.sendMessageViaHTTP(userId, errorMessage);
          }
          
          await this.cleanupPairing(userId);
        } else if (connection === "connecting") {
          log.info(`🔄 Connexion en cours pour ${userId}...`);
        }
      });

      socket.ev.on("creds.update", saveCreds);

      socket.ev.process(async (events) => {
        if (events['connection.update']) {
          const update = events['connection.update'];
          if (update.lastDisconnect?.error) {
            log.warn(`⚠️ Erreur connexion ${userId}:`, update.lastDisconnect.error.message);
          }
        }
      });

      this.activePairings.set(userId, { socket, rl: null, userData, phoneNumber });

      return { 
        success: true, 
        method: 'pairing', 
        message: 'Processus pairing démarré',
        phoneNumber: phoneNumber,
        retryCount: currentRetryCount
      };

    } catch (error) {
      log.error('❌ Erreur critique processus pairing:', error);
      
      await this.cleanupPairing(userId);
      
      await this.sendMessageViaHTTP(userId,
        "❌ *Erreur critique de connexion*\n\n" +
        "Impossible d'établir la connexion avec WhatsApp.\n\n" +
        "Veuillez:\n" +
        "• Utiliser la méthode QR Code\n" +
        "• Réessayer plus tard\n" +
        "• Contacter le support si le problème persiste"
      );
      
      throw error;
    }
  }

  async handleSuccessfulPairing(socket, userId, userData, saveCreds, rl) {
    try {
        const sessionId = `pairing_${userId}_${Date.now()}`;
        const authDir = path.join(process.cwd(), 'sessions', sessionId);
        
        await fs.ensureDir(authDir);

        const pairingAuthPath = path.join(process.cwd(), this.sessionName);
        
        if (await fs.pathExists(pairingAuthPath)) {
            const files = await fs.readdir(pairingAuthPath);
            for (const file of files) {
                const sourcePath = path.join(pairingAuthPath, file);
                const targetPath = path.join(authDir, file);
                await fs.copy(sourcePath, targetPath);
            }
            log.info(`✅ Fichiers d'authentification copiés vers ${authDir}`);
        }

        const access = await this.sessionManager.authManager.checkUserAccess(userId);
        const isPayedUser = access.hasAccess;

        // CRÉATION COMPLÈTE DE LA SESSION
        const sessionData = {
            socket: socket,
            userId: userId,
            userData: userData,
            authDir: authDir,
            saveCreds: saveCreds,
            status: 'connected',
            subscriptionActive: isPayedUser,
            connectionMethod: 'pairing',
            createdAt: new Date(),
            lastActivity: new Date()
        };

        // AJOUTER LA SESSION AU SESSION MANAGER
        this.sessionManager.sessions.set(sessionId, sessionData);

        // CONFIGURER LES ÉVÉNEMENTS DU SOCKET COMPLÈTEMENT
        this.setupCompleteSocketEvents(socket, sessionId, userId);

        await this.sessionManager.supabase
            .from('whatsapp_sessions')
            .insert([{
                session_id: sessionId,
                user_id: userId,
                user_data: userData,
                status: 'connected',
                subscription_active: isPayedUser,
                connection_method: 'pairing',
                created_at: new Date().toISOString(),
                connected_at: new Date().toISOString(),
                last_activity: new Date().toISOString()
            }]);

        // Nettoyer
        this.retryCounts.delete(userId);
        this.activePairings.delete(userId);
        if (rl) rl.close();

        // Message de bienvenue sur WhatsApp
        let whatsappMessage = `🎉 *CONNEXION WHATSAPP RÉUSSIE!*\n\n`;
        whatsappMessage += `✅ Méthode: Code de Pairing\n`;
        whatsappMessage += `👤 Compte: ${socket.user?.name || socket.user?.id || 'Utilisateur'}\n`;
        
        if (isPayedUser) {
            whatsappMessage += `📱 Statut: Session PERMANENTE\n\n`;
            whatsappMessage += `💎 *ABONNEMENT ACTIF*\n`;
            whatsappMessage += `📅 Jours restants: ${access.daysLeft || '30'}\n`;
            whatsappMessage += `🔐 Session maintenue automatiquement\n\n`;
        } else {
            whatsappMessage += `📱 Statut: Session d'essai\n\n`;
        }
        
        whatsappMessage += `🤖 *Votre bot NOVA-MD est maintenant opérationnel!*\n`;
        whatsappMessage += `Utilisez *!help* pour voir les commandes disponibles.`;

        try {
            // ENVOYER le message sur WhatsApp
            if (socket.user && socket.user.id) {
                await socket.sendMessage(socket.user.id, { text: whatsappMessage });
                log.success(`✅ Message de bienvenue envoyé sur WhatsApp à ${userId}`);
            } else {
                log.warn(`⚠️ Impossible d'envoyer le message WhatsApp: user.id non défini`);
            }
        } catch (whatsappError) {
            log.error(`❌ Erreur envoi message WhatsApp: ${whatsappError.message}`);
        }

        // Message sur Telegram
        await this.sendMessageViaHTTP(userId, 
            `✅ *Connexion WhatsApp réussie via Pairing!*\n\n` +
            `Votre session est maintenant active.\n` +
            `Allez sur WhatsApp et tapez *!help* pour voir les commandes.`
        );

        log.success(`🎯 Session pairing créée: ${sessionId}`);

    } catch (error) {
        log.error('❌ Erreur gestion pairing réussi:', error);
        if (rl) rl.close();
    }
}
  
async forceCleanupSessions(userId) {
    try {
        log.info(`🧹 Nettoyage forcé des sessions pour ${userId}`);
        
        const sessionsToClean = [
            path.join(process.cwd(), this.sessionName),
            path.join(process.cwd(), 'sessions', `pairing_${userId}_*`),
            path.join(process.cwd(), 'sessions', `qr_${userId}_*`)
        ];
        
        for (const sessionPath of sessionsToClean) {
            try {
                if (await fs.pathExists(sessionPath)) {
                    await fs.remove(sessionPath);
                    log.success(`✅ Session nettoyée: ${sessionPath}`);
                }
            } catch (error) {
                log.warn(`⚠️ Impossible de nettoyer ${sessionPath}: ${error.message}`);
            }
        }
        
        // Nettoyer également les sessions actives
        for (const [sessionId, sessionData] of this.sessionManager.sessions) {
            if (sessionData.userId === userId) {
                try {
                    if (sessionData.socket) {
                        await sessionData.socket.end();
                    }
                    this.sessionManager.sessions.delete(sessionId);
                } catch (error) {
                    log.warn(`⚠️ Erreur nettoyage session ${sessionId}: ${error.message}`);
                }
            }
        }
        
        // Nettoyer les pairings actifs
        this.cleanupPairing(userId);
        
    } catch (error) {
        log.error(`❌ Erreur nettoyage forcé sessions: ${error.message}`);
    }
}
  
// AJOUTER cette méthode pour configurer complètement les événements du socket
setupCompleteSocketEvents(socket, sessionId, userId) {
    const sessionManager = this.sessionManager;
    
    // Événement de mise à jour de connexion
    socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection === "open") {
            log.success(`✅ Connexion WhatsApp maintenue pour ${userId}`);
            await sessionManager.updateSessionStatus(sessionId, 'connected');
        }
        
        if (connection === "close") {
            log.warn(`🔌 Connexion fermée pour ${userId}`);
            await sessionManager.handleConnectionClose(sessionId, lastDisconnect);
        }
    });

    // Événement de mise à jour des credentials
    socket.ev.on("creds.update", async (creds) => {
        const session = sessionManager.sessions.get(sessionId);
        if (session && session.saveCreds) {
            await session.saveCreds();
        }
        await sessionManager.updateSessionActivity(sessionId);
    });

    // Événement de réception de messages
    socket.ev.on("messages.upsert", async (m) => {
        log.info(`📨 Message reçu pour ${userId}: ${m.messages?.length} messages`);
        await sessionManager.handleIncomingMessage(m, sessionId);
    });

    // Événement de mise à jour de messages
    socket.ev.on("messages.update", async (updates) => {
        await sessionManager.updateSessionActivity(sessionId);
    });

    // Événement de mise à jour des contacts
    socket.ev.on("contacts.update", async (updates) => {
        await sessionManager.updateSessionActivity(sessionId);
    });

    // Événement de mise à jour des groupes
    socket.ev.on("groups.update", async (updates) => {
        await sessionManager.updateSessionActivity(sessionId);
    });

    // Traitement des autres événements
    socket.ev.process(async (events) => {
        if (events['messaging-history.set']) {
            log.info(`📚 Historique des messages chargé pour ${userId}`);
        }
        
        if (events['chats.upsert']) {
            await sessionManager.updateSessionActivity(sessionId);
        }
        
        if (events['presence.update']) {
            // Ignorer les mises à jour de présence
        }
    });
  }
  
  // ... (les autres méthodes restent inchangées)

  async handlePairingCode(socket, userId, userData, question, rl) {
    try {
      let phoneNumber = await question(
        chalk.bgBlack(chalk.greenBright(`📱 Entrez votre numéro WhatsApp (ex: 237612345678) : `))
      );
      
      phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

      if (!Object.keys(PHONENUMBER_MCC).some((v) => phoneNumber.startsWith(v))) {
        log.warn("❌ Code pays invalide, réessayez");
        phoneNumber = await question(
          chalk.bgBlack(chalk.greenBright(`📱 Entrez votre numéro WhatsApp : `))
        );
        phoneNumber = phoneNumber.replace(/[^0-9]/g, "");
      }

      setTimeout(async () => {
        try {
          let code = await socket.requestPairingCode(phoneNumber);
          code = code?.match(/.{1,4}/g)?.join("-") || code;
          
          log.success(`🔑 Code de pairing généré pour l'utilisateur ${userId}: ${code}`);
          
          await this.sendPairingCodeViaHTTP(userId, code, phoneNumber);

          console.log(
            chalk.black(chalk.bgGreen(`✅ Code de Pairing : `)),
            chalk.black(chalk.white(code)),
          );

        } catch (error) {
          log.error('❌ Erreur génération code pairing:', error);
          await this.sendMessageViaHTTP(userId, "❌ Erreur lors de la génération du code. Réessayez.");
        }
      }, 3000);

    } catch (error) {
      log.error('❌ Erreur gestion pairing code:', error);
      rl.close();
    }
  }

  async handleConnectionClose(sessionId, lastDisconnect, userId, rl) {
    const pairing = this.activePairings.get(userId);
    
    if (lastDisconnect?.error?.output?.statusCode !== 401) {
      log.info("🔄 Tentative de reconnexion pairing...");
      await this.cleanup();
      
      await this.sendMessageViaHTTP(userId, "🔌 Connexion interrompue. Reconnexion en cours...");
    } else {
      log.error("❌ Pairing échoué - erreur d'authentification");
      await this.sendMessageViaHTTP(userId, "❌ Échec de connexion. Réessayez avec /connect.");
    }

    if (pairing) {
      if (pairing.rl) pairing.rl.close();
      this.activePairings.delete(userId);
    }
  }

  async sendPairingCodeViaHTTP(userId, pairingCode, phoneNumber) {
    try {
      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          pairing_code: pairingCode,
          phone_number: phoneNumber
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        log.success(`✅ Code pairing envoyé à ${userId} via pont HTTP`);
        return true;
      } else {
        log.error(`❌ Échec envoi pairing à ${userId}:`, result.error);
        return false;
      }
      
    } catch (error) {
      log.error(`❌ Erreur envoi pairing à ${userId} via HTTP:`, error.message);
      return false;
    }
  }

  async sendQRCodeViaHTTP(userId, qrCode, sessionId) {
    try {
      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          qr_code: qrCode,
          session_id: sessionId
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        log.success(`✅ QR code envoyé à ${userId} via pont HTTP`);
        return true;
      } else {
        log.error(`❌ Échec envoi QR à ${userId}:`, result.error);
        return false;
      }
      
    } catch (error) {
      log.error(`❌ Erreur envoi QR à ${userId} via HTTP:`, error.message);
      return false;
    }
  }

  async sendMessageViaHTTP(userId, message) {
    try {
      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          message: message
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        log.success(`✅ Message envoyé à ${userId} via pont HTTP`);
        return true;
      } else {
        log.error(`❌ Échec envoi message à ${userId}:`, result.error);
        return false;
      }
      
    } catch (error) {
      log.error(`❌ Erreur envoi message à ${userId} via HTTP:`, error.message);
      return false;
    }
  }

  async getPairingStatus(userId) {
    try {
      const { data, error } = await this.supabase
        .from('pairing_codes')
        .select('*')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      return data;
    } catch (error) {
      return null;
    }
  }

  async cleanup() {
    try {
      const pairingAuthPath = path.join(process.cwd(), this.sessionName);
      if (await fs.pathExists(pairingAuthPath)) {
        await fs.emptyDir(pairingAuthPath);
      }
    } catch (error) {
      log.error('❌ Erreur nettoyage pairing:', error);
    }
  }

  async cleanupPairing(userId) {
    try {
      this.cleanupUserTimeouts(userId);
      
      const pairing = this.activePairings.get(userId);
      if (pairing && pairing.socket) {
        await pairing.socket.end();
      }
      this.activePairings.delete(userId);
      this.retryCounts.delete(userId);
      await this.cleanup();
      log.info(`🧹 Pairing nettoyé pour ${userId}`);
    } catch (error) {
      log.error(`❌ Erreur nettoyage pairing ${userId}:`, error);
    }
  }

  async standalonePairing() {
    if (!this.isPairingMode) {
      console.log(chalk.red("❌ Utilisez --use-pairing-code pour le mode pairing"));
      process.exit(1);
    }

    CFonts.say("NOVA-MD Pairing", {
      font: "tiny",
      align: "center",
      colors: ["system"],
    });
    
    CFonts.say(
      "Connexion WhatsApp via Code de Pairing\\nPowered by NOVA-MD Premium\\n",
      {
        colors: ["system"],
        font: "console",
        align: "center",
      },
    );

    const userId = 'standalone_' + Date.now();
    const userData = { name: 'Standalone User' };

    try {
      await this.initializePairing(userId, userData);
    } catch (error) {
      console.error('❌ Erreur pairing autonome:', error);
      process.exit(1);
    }
  }
}

module.exports = PairingManager;
