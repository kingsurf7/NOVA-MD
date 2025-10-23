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
  DisconnectReason, 
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
        
        // CONFIGURATION CRITIQUE POUR LA STABILITÉ
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 2000,
        maxRetries: 2,
        
        // OPTIMISATIONS DE STABILITÉ
        emitOwnEvents: true,
        generateHighQualityLinkPreview: false,
        fireInitQueries: true,
        mobile: false,
        
        // CONFIGURATION RÉSEAU AMÉLIORÉE
        txnTimeoutMs: 10000,
        qrTimeout: 60000,
        
        // OPTIMISATION MÉMOIRE
        msgRetryCounterCache: new Map(),
        messageResendCache: new Map(),
        
        getMessage: async () => undefined,
        
        // DÉSACTIVER LES FONCTIONNALITÉS NON ESSENTIELLES
        shouldIgnoreJid: (jid) => jid.endsWith('@broadcast'),
        linkPreviewImageThumbnailWidth: 64,
        
        // CONFIGURATION WEBSOCKET AMÉLIORÉE
        wsOptions: {
          headers: {
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        }
      });

      // VARIABLES DE CONTRÔLE
      let pairingCodeSent = false;
      let pairingSuccess = false;
      let pairingCode = null;
      let codeGenerationInProgress = false;
      
      const currentRetryCount = this.retryCounts.get(userId) || 0;
      
      // FONCTION AMÉLIORÉE DE GÉNÉRATION DE CODE
      const generatePairingCode = async () => {
        if (codeGenerationInProgress || pairingCodeSent) {
          log.info(`⏳ Génération de code déjà en cours ou code déjà envoyé pour ${userId}`);
          return;
        }
        
        codeGenerationInProgress = true;
        
        try {
          log.info(`📱 Génération du code pairing pour le numéro: ${phoneNumber}`);
          
          // AJOUTER UN TIMEOUT POUR LA GÉNÉRATION DU CODE
          const pairingPromise = socket.requestPairingCode(phoneNumber);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout génération code pairing')), 30000)
          );
          
          pairingCode = await Promise.race([pairingPromise, timeoutPromise]);
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
                  "⏰ *Code de pairing expiré*\n\n" +
                  "Le code n'a pas été utilisé dans les 15 minutes.\n\n" +
                  "*Que faire?*\n" +
                  "• Redémarrez avec /connect\n" +
                  "• Utilisez la méthode **QR Code**\n" +
                  "• Le QR Code est souvent plus rapide et stable"
                );
                await this.cleanupPairing(userId);
              }
            }, 900000);

            this.connectionTimeouts.set(userId, connectionTimeout);
            log.info(`✅ Code pairing ${pairingCode} envoyé à ${userId}`);
          } else {
            throw new Error('Échec envoi du code pairing');
          }
        } catch (error) {
          log.error('❌ Erreur génération code pairing:', error);
          codeGenerationInProgress = false;
          
          const retryCount = currentRetryCount + 1;
          this.retryCounts.set(userId, retryCount);
          
          if (retryCount < 2) {
            log.info(`🔄 Tentative ${retryCount}/2 de pairing pour ${userId}`);
            await this.sendMessageViaHTTP(userId,
              `🔄 *Tentative ${retryCount}/2 en cours...*\n\n` +
              `Problème temporaire. Nouvelle tentative automatique...`
            );
            
            setTimeout(() => {
              this.startPairingWithPhone(userId, userData, phoneNumber);
            }, 10000);
            return;
          }
          
          await this.sendMessageViaHTTP(userId, 
            "❌ *Impossible de se connecter via Pairing*\n\n" +
            "Le service WhatsApp rencontre des difficultés techniques.\n\n" +
            "🎯 *Solution recommandée:*\n" +
            "Utilisez la méthode **QR Code** à la place:\n" +
            "1. Allez dans /connect\n" + 
            "2. Choisissez 'QR Code'\n" +
            "3. Scannez le QR avec WhatsApp\n\n" +
            "Le QR Code est généralement plus rapide et fiable!"
          );
          
          await this.cleanupPairing(userId);
        }
      };

      // DÉMARRER LA GÉNÉRATION APRÈS UN DÉLAI CONTRÔLÉ
      const pairingTimeout = setTimeout(() => {
        if (!pairingCodeSent && !codeGenerationInProgress) {
          generatePairingCode();
        }
      }, 5000);

      this.pairingTimeouts.set(userId, pairingTimeout);

      // GESTION AMÉLIORÉE DES ÉVÉNEMENTS DE CONNEXION
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
          
          if (!pairingCodeSent && !codeGenerationInProgress) {
            log.info(`🔄 QR détecté, déclenchement génération code pairing...`);
            setTimeout(() => generatePairingCode(), 2000);
          }
          return;
        }
        
        if (connection === "open") {
          this.cleanupUserTimeouts(userId);
          pairingSuccess = true;
          codeGenerationInProgress = false;
          
          log.success(`🎉 CONNEXION RÉUSSIE via pairing pour ${userId}`);
          
          // ATTENDRE que la connexion soit stable
          await delay(3000);
          
          await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, null);
          
        } else if (connection === "close") {
          const reason = lastDisconnect?.error;
          const statusCode = reason?.output?.statusCode;
          
          log.error(`❌ Connexion fermée pour ${userId}:`, {
            message: reason?.message,
            statusCode: statusCode,
            pairingCode: pairingCode
          });
          
          // GESTION DES ERREURS DE STREAM
          if (reason?.message?.includes('Stream Errored') || statusCode === 515) {
            const recoveryInProgress = await this.handleStreamError(userId, reason, phoneNumber);
            if (recoveryInProgress) {
              return;
            }
          }
          
          if (!pairingSuccess) {
            let errorMessage = "❌ *Échec de connexion pairing*\n\n";
            
            if (statusCode === 515 || reason?.message?.includes('Stream Errored')) {
              errorMessage += "⚠️ *Problème de connexion réseau*\n\n";
              errorMessage += "WhatsApp a rencontré un problème technique.\n\n";
              errorMessage += "*Solutions recommandées:*\n";
              errorMessage += "• Utilisez la méthode **QR Code** (plus stable)\n";
              errorMessage += "• Réessayez dans 2-3 minutes\n";
              errorMessage += "• Vérifiez votre connexion Internet\n";
            } else if (statusCode === 401) {
              errorMessage += "🔑 *Code de pairing expiré ou invalide*\n\n";
              errorMessage += "Le code a expiré ou a déjà été utilisé.\n\n";
              errorMessage += "*Solution:*\n";
              errorMessage += "• Redémarrez avec /connect\n";
              errorMessage += "• Générez un nouveau code\n";
            } else {
              errorMessage += "❌ *Erreur de connexion inattendue*\n\n";
              errorMessage += "Problème technique avec WhatsApp.\n\n";
              errorMessage += "*Solution:*\n";
              errorMessage += "• Utilisez la méthode QR Code\n";
              errorMessage += "• Réessayez plus tard\n";
            }
            
            await this.sendMessageViaHTTP(userId, errorMessage);
          }
          
          this.cleanupUserTimeouts(userId);
          await this.cleanupPairing(userId);
        } else if (connection === "connecting") {
          log.info(`🔄 Connexion en cours pour ${userId}...`);
        }
      });

      socket.ev.on("creds.update", saveCreds);

      this.activePairings.set(userId, { 
        socket, 
        rl: null, 
        userData, 
        phoneNumber,
        pairingCodeSent,
        codeGenerationInProgress 
      });

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

  async handleStreamError(userId, error, phoneNumber) {
    try {
      log.error(`🌊 Erreur stream pour ${userId}:`, error.message);
      
      // Analyser le type d'erreur
      if (error.message.includes('Stream Errored') || error.message.includes('restart required')) {
        log.info(`🔄 Stream error détecté - tentative de récupération...`);
        
        // Attendre un moment avant de réessayer
        await delay(5000);
        
        // Nettoyer complètement avant de recommencer
        await this.forceCleanupSessions(userId);
        
        // Réessayer avec une nouvelle session
        const retryCount = this.retryCounts.get(userId) || 0;
        if (retryCount < 2) {
          this.retryCounts.set(userId, retryCount + 1);
          
          log.info(`🔄 Tentative de récupération ${retryCount + 1}/2 pour ${userId}`);
          
          await this.sendMessageViaHTTP(userId,
            `🔄 *Problème de connexion détecté*\n\n` +
            `Réparation automatique en cours...\n` +
            `Tentative ${retryCount + 1}/2`
          );
          
          // Relancer le processus avec un délai
          setTimeout(async () => {
            try {
              await this.startPairingWithPhone(userId, {}, phoneNumber);
            } catch (retryError) {
              log.error(`❌ Échec récupération pour ${userId}:`, retryError);
            }
          }, 8000);
          
          return true;
        }
      }
      
      return false;
      
    } catch (handleError) {
      log.error(`❌ Erreur gestion stream error:`, handleError);
      return false;
    }
  }

  async recommendQRCode(userId) {
    await this.sendMessageViaHTTP(userId,
      "💡 *Conseil NOVA-MD*\n\n" +
      "La méthode **QR Code** est souvent plus rapide et stable que le Pairing Code.\n\n" +
      "*Avantages du QR Code:*\n" +
      "• Connexion instantanée\n" + 
      "• Plus fiable\n" +
      "• Moins de problèmes techniques\n" +
      "• Supporté par tous les devices\n\n" +
      "Essayez la méthode QR Code avec /connect !"
    );
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

  // CONFIGURATION COMPLÈTE DES ÉVÉNEMENTS DU SOCKET
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
      log.info(`🧹 Nettoyage complet du pairing pour ${userId}`);
      
      // Nettoyer tous les timeouts
      this.cleanupUserTimeouts(userId);
      
      // Nettoyer les compteurs de tentative
      this.retryCounts.delete(userId);
      
      // Fermer le socket s'il existe
      const pairing = this.activePairings.get(userId);
      if (pairing) {
        if (pairing.socket) {
          try {
            await pairing.socket.end();
            log.info(`🔌 Socket fermé pour ${userId}`);
          } catch (socketError) {
            log.warn(`⚠️ Erreur fermeture socket: ${socketError.message}`);
          }
        }
        
        if (pairing.rl) {
          pairing.rl.close();
        }
      }
      
      // Supprimer de la map active
      this.activePairings.delete(userId);
      
      // Nettoyer les fichiers temporaires
      await this.cleanup();
      
      log.success(`✅ Pairing complètement nettoyé pour ${userId}`);
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
