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
    try {
      log.info(`🔐 DÉBUT pairing pour ${userId} avec ${phoneNumber}`);
      
      // NETTOYAGE COMPLET avant de commencer
      await this.forceCleanupSessions(userId);
      
      const pairingAuthPath = path.join(process.cwd(), this.sessionName);
      await fs.ensureDir(pairingAuthPath);
      
      const { state, saveCreds } = await useMultiFileAuthState(pairingAuthPath);
      
      const socket = makeWASocket({
        logger: pino({ level: "fatal" }),
        browser: Browsers.ubuntu('Chrome'),
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        connectTimeoutMs: 360000,
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 5000,
        maxRetries: 3,
        fireInitQueries: false,
        mobile: false,
        appStateMacVerification: {
          patch: true,
          snapshot: false, 
        },
        getMessage: async () => undefined,
        authTimeoutMs: 60000,
            // Configuration WebSocket améliorée
        wsOptions: {
            headers: {
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
    		 }
      });

      let pairingSuccess = false;
      
      // GÉNÉRATION IMMÉDIATE DU CODE
      await delay(2000);
      
      let pairingCode;
      try {
        pairingCode = await socket.requestPairingCode(phoneNumber);
        pairingCode = pairingCode?.match(/.{1,4}/g)?.join("-") || pairingCode;
        
        if (!pairingCode) {
          throw new Error('Aucun code pairing généré');
        }
        
        log.success(`🔑 Code pairing généré: ${pairingCode}`);
        
      } catch (codeError) {
        log.error(`❌ Erreur génération code: ${codeError.message}`);
        throw new Error(`Impossible de générer le code pairing: ${codeError.message}`);
      }

      // ENVOI DU CODE
      const sent = await this.sendPairingCodeViaHTTP(userId, pairingCode, phoneNumber);
      if (!sent) {
        throw new Error('Échec envoi du code pairing');
      }

      await this.sendMessageViaHTTP(userId,
        `🔐 *Code de Pairing Généré!*\n\n` +
        `📱 Pour: ${phoneNumber}\n` +
        `🔑 Votre code: *${pairingCode}*\n\n` +
        `*Instructions CRITIQUES:*\n` +
        `1. Ouvrez WhatsApp MAINTENANT\n` +
        `2. Paramètres → Appareils liés\n` +
        `3. "Lier un appareil"\n` +
        `4. Entrez le code *IMMÉDIATEMENT*\n` +
        `5. Ne quittez pas cette conversation\n\n` +
        `⏱️ *Code valable 3 minutes*`
      );

      // CONFIGURATION DES ÉVÉNEMENTS
      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        log.info(`🔌 [PAIRING] ${userId} - Connection: ${connection}, QR: ${!!qr}`);
        
        if (qr) {
          log.warn(`⚠️ QR reçu - pairing peut échouer pour ${userId}`);
          return;
        }
        
        if (connection === "open") {
          pairingSuccess = true;
          log.success(`🎉 CONNEXION RÉUSSIE pairing pour ${userId}`);
          
          await delay(1000);
          
          await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, null);
          
        } else if (connection === "close") {
          log.error(`❌ Connexion fermée: ${lastDisconnect?.error?.message}`);
          
          if (!pairingSuccess) {
            await this.sendMessageViaHTTP(userId,
              "❌ *Échec connexion pairing*\n\n" +
              "Le code n'a pas fonctionné.\n\n" +
              "Causes:\n" +
              "• Code expiré (trop lent)\n" + 
              "• Numéro incorrect\n" +
              "• Problème WhatsApp\n\n" +
              "🎯 *Solution:*\n" +
              "Utilisez la méthode *QR Code* → plus fiable"
            );
          }
          
          await this.cleanupPairing(userId);
        }
      });

      socket.ev.on("creds.update", saveCreds);

      // TIMEOUT DE SÉCURITÉ
      const safetyTimeout = setTimeout(async () => {
        if (!pairingSuccess) {
          log.warn(`⏰ Timeout pairing pour ${userId}`);
          await this.sendMessageViaHTTP(userId,
            "⏰ *Temps écoulé*\n\n" +
            "Le code pairing a expiré.\n\n" +
            "Veuillez:\n" +
            "1. Redémarrer avec /connect\n" + 
            "2. Choisir *QR Code*\n" +
            "3. Scanner rapidement\n\n" +
            "Le QR Code est plus rapide et fiable! 📱"
          );
          await this.cleanupPairing(userId);
        }
      }, 365000);

      this.connectionTimeouts.set(userId, safetyTimeout);
      this.activePairings.set(userId, { socket, userData, phoneNumber });

      return { 
        success: true, 
        method: 'pairing',
        pairingCode: pairingCode,
        message: 'Code pairing envoyé - utilisez-le rapidement'
      };

    } catch (error) {
      log.error(`❌ ERREUR CRITIQUE pairing: ${error.message}`);
      
      await this.cleanupPairing(userId);
      
      await this.sendMessageViaHTTP(userId,
        "❌ *Erreur pairing*\n\n" +
        "Impossible de générer le code.\n\n" +
        "Utilisez la méthode *QR Code* à la place:\n" +
        "1. /connect\n" +
        "2. QR Code\n" +
        "3. Scanner avec WhatsApp\n\n" +
        "✅ Plus rapide et fiable!"
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

        // CONFIGURER LES ÉVÉNEMENTS DU SOCKET
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
        let whatsappMessage = `🎉 *CONNEXION WHATSAPP RÉUSSIE!*\\n\\n`;
        whatsappMessage += `✅ Méthode: Code de Pairing\\n`;
        whatsappMessage += `👤 Compte: ${socket.user?.name || socket.user?.id || 'Utilisateur'}\\n`;
        
        if (isPayedUser) {
            whatsappMessage += `📱 Statut: Session PERMANENTE\\n\\n`;
            whatsappMessage += `💎 *ABONNEMENT ACTIF*\\n`;
            whatsappMessage += `📅 Jours restants: ${access.daysLeft || '30'}\\n`;
            whatsappMessage += `🔐 Session maintenue automatiquement\\n\\n`;
        } else {
            whatsappMessage += `📱 Statut: Session d'essai\\n\\n`;
        }
        
        whatsappMessage += `🤖 *Votre bot NOVA-MD est maintenant opérationnel!*\\n`;
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
            `✅ *Connexion WhatsApp réussie via Pairing!*\\n\\n` +
            `Votre session est maintenant active.\\n` +
            `Allez sur WhatsApp et tapez *!help* pour voir les commandes.`
        );

        log.success(`🎯 Session pairing créée: ${sessionId}`);

    } catch (error) {
        log.error('❌ Erreur gestion pairing réussi:', error);
        if (rl) rl.close();
    }
  }

  // CONFIGURATION COMPLÈTE DES ÉVÉNEMENTS SOCKET
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
