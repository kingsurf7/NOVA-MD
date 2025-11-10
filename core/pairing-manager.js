const pino = require("pino");
const path = require("path");
const colors = require("@colors/colors/safe");
const CFonts = require("cfonts");
const fs = require("fs-extra");
const chalk = require("chalk");
const readline = require("readline");
const { exec } = require("child_process");
const http = require("http");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  DisconnectReason,
  PHONENUMBER_MCC,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WA_DEFAULT_EPHEMERAL,
  jidNormalizedUser,
  proto,
  getDevice,
  generateWAMessageFromContent,
  makeInMemoryStore,
  getContentType,
  generateForwardMessageContent,
  downloadContentFromMessage,
  jidDecode
} = require("@whiskeysockets/baileys");
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const log = require('../utils/logger')(module);

class PairingManager {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.sessionName = "pairing-auth";
    this.supabase = createClient(config.supabase.url, config.supabase.key);
    // CLI flag semantics: include --use-pairing-code to activate pairing-code mode
    this.isPairingMode = process.argv.includes("--use-pairing-code");
    this.activePairings = new Map();
    this.nodeApiUrl = process.env.NODE_API_URL || 'http://localhost:3000';
    this.retryCounts = new Map();
    this.pairingTimeouts = new Map();
    this.connectionTimeouts = new Map();
    // simple in-memory "store" shim (kept from original)
    this.store = {
      chats: new Map(),
      contacts: new Map(),
      messages: new Map(),
      bind: function(ev) {
        ev.on('chats.set', ({ chats }) => {
          chats.forEach(chat => this.chats.set(chat.id, chat));
        });
        ev.on('contacts.set', ({ contacts }) => {
          contacts.forEach(contact => this.contacts.set(contact.id, contact));
        });
        ev.on('messages.upsert', ({ messages }) => {
          messages.forEach(message => this.messages.set(message.key.id, message));
        });
      }
    };
  }

  /* ---------------------------
     Helpers pour timeouts / cleanup
     --------------------------- */
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
        try {
          // Baileys socket peut exposer logout() / ws
          if (typeof pairing.socket.logout === 'function') {
            await pairing.socket.logout().catch(() => {});
          }
          if (pairing.socket.ws && typeof pairing.socket.ws.close === 'function') {
            pairing.socket.ws.close();
          }
        } catch (e) {
          log.warn(`⚠️ Erreur lors de la fermeture socket: ${e.message}`);
        }
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
        // note: glob-like patterns removed because fs.pathExists doesn't handle globs
        path.join(process.cwd(), 'sessions'),
      ];

      for (const sessionPath of sessionsToClean) {
        try {
          if (await fs.pathExists(sessionPath)) {
            // if sessions dir exists, remove subfolders matching userId
            if (sessionPath.endsWith('sessions')) {
              const files = await fs.readdir(sessionPath);
              for (const file of files) {
                if (file.includes(userId)) {
                  const full = path.join(sessionPath, file);
                  await fs.remove(full).catch(e => log.warn(`Impossible de supprimer ${full}: ${e.message}`));
                  log.success(`✅ Session nettoyée: ${full}`);
                }
              }
            } else {
              await fs.remove(sessionPath);
              log.success(`✅ Session nettoyée: ${sessionPath}`);
            }
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
              if (typeof sessionData.socket.logout === 'function') await sessionData.socket.logout().catch(() => {});
              if (sessionData.socket.ws) sessionData.socket.ws.close();
            }
            this.sessionManager.sessions.delete(sessionId);
          } catch (error) {
            log.warn(`⚠️ Erreur nettoyage session ${sessionId}: ${error.message}`);
          }
        }
      }

      // Nettoyer les pairings actifs
      await this.cleanupPairing(userId);

    } catch (error) {
      log.error(`❌ Erreur nettoyage forcé sessions: ${error.message}`);
    }
  }

  /* ---------------------------
     Initialisation pairing (choix QR / phone)
     --------------------------- */
  async initializePairing(userId, userData, phoneNumber = null) {
    try {
      log.info(`🔐 Initialisation pairing pour ${userId}`);

      // CRÉER le dossier pairing-auth s'il n'existe pas
      const pairingAuthPath = path.join(process.cwd(), this.sessionName);
      await fs.ensureDir(pairingAuthPath);

      const sessionExists = await fs.pathExists(pairingAuthPath);
      if (sessionExists) {
        log.info("🧹 Nettoyage de la session existante");
        await fs.emptyDir(pairingAuthPath).catch(() => {});
        await delay(500);
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

  /* ---------------------------
     Pairing process via interactive (QR or console)
     --------------------------- */
  async startPairingProcess(userId, userData) {
    const pairingAuthPath = path.join(process.cwd(), this.sessionName);

    let rl; // pour fermer proprement si besoin
    try {
      const authState = await useMultiFileAuthState(pairingAuthPath);

      if (!authState || !authState.state || !authState.saveCreds) {
        throw new Error('Échec de l\'initialisation de l\'état d\'authentification');
      }

      const { state, saveCreds } = authState;

      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (text) => new Promise((resolve) => rl.question(text, resolve));

      const { version } = await fetchLatestBaileysVersion();
      const socket = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false, // we'll send QR via HTTP bridge
        browser: Browsers.ubuntu("Chrome"),
        mobile: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 120000,
        emitOwnEvents: true,
        retryRequestDelayMs: 3000,
        maxRetries: 3,
        fireInitQueries: false,
        linkPreviewImageThumbnailWidth: 0,
        msgRetryCounterCache: new Map(),
        transactionOpts: { maxCommitRetries: 2, delayBeforeRetry: 1500 },
        getMessage: async () => undefined,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        }
      });

      // Bind store to socket
      this.store.bind(socket.ev);

      // Si on est en pairing-mode CLI, on propose la saisie (ou envoie QR)
      if (this.isPairingMode && !socket?.authState?.creds?.registered) {
        // handler: either QR or prompt for phone
        await this.handlePairingCode(socket, userId, userData, question, rl);
      }

      // connection update
      socket.ev.on("connection.update", async (update) => {
        try {
          const { connection, lastDisconnect } = update;

          if (connection === "open") {
            log.success(`✅ Connexion WhatsApp réussie via pairing pour ${userId}`);
            await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, rl);
          } else if (connection === "close") {
            await this.handleConnectionClose(null, lastDisconnect, userId, rl);
          }
        } catch (e) {
          log.error('‼️ Error in connection.update (startPairingProcess):', e?.message || e);
        }
      });

      // save creds when updated
      socket.ev.on("creds.update", saveCreds);

      this.activePairings.set(userId, { socket, rl, userData });

      return { success: true, method: 'pairing' };

    } catch (error) {
      if (rl) try { rl.close(); } catch {}
      log.error('❌ Erreur processus pairing:', error);
      throw error;
    }
  }

  /* ---------------------------
     Pairing via phone (requestPairingCode)
     --------------------------- */
  async startPairingWithPhone(userId, userData, phoneNumber) {
    try {
      log.info(`🔐 [PAIRING] Initialisation pour ${userId} (${phoneNumber})`);

      // 1️⃣ Nettoyage avant toute tentative
      await this.forceCleanupSessions(userId).catch(() => {});

      // 2️⃣ Préparation du dossier de session
      const pairingAuthPath = path.join(process.cwd(), this.sessionName);
      await fs.ensureDir(pairingAuthPath);

      let state, saveCreds;

      try {
        // tentative normale
        const authState = await useMultiFileAuthState(pairingAuthPath);
        if (!authState?.state || !authState?.saveCreds) {
          throw new Error('État d’authentification invalide ou incomplet');
        }
        state = authState.state;
        saveCreds = authState.saveCreds;

        // si pas de creds, réinitialiser proprement
        if (!state?.creds) {
          log.warn(`⚠️ Aucun creds détecté, réinitialisation du dossier de session...`);
          await fs.emptyDir(pairingAuthPath);
          const newAuth = await useMultiFileAuthState(pairingAuthPath);
          if (!newAuth?.state || !newAuth?.saveCreds) throw new Error('Impossible d’initialiser un nouvel état après nettoyage');
          state = newAuth.state;
          saveCreds = newAuth.saveCreds;
        }
      } catch (initErr) {
        // tentative de récupération
        log.error(`💣 Erreur initialisation auth state: ${initErr.message}`);
        await fs.emptyDir(pairingAuthPath).catch(() => {});
        const retryAuth = await useMultiFileAuthState(pairingAuthPath);
        if (!retryAuth?.state || !retryAuth?.saveCreds) {
          throw new Error('Impossible d’initialiser l’état d’authentification après erreur critique');
        }
        state = retryAuth.state;
        saveCreds = retryAuth.saveCreds;
      }

      // Création du socket Baileys optimisé
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        logger: pino({ level: "silent" }),
        syncFullHistory: false,
        browser: Browsers.ubuntu("Chrome"),
        mobile: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 240000,
        defaultQueryTimeoutMs: 240000,
        emitOwnEvents: true,
        retryRequestDelayMs: 3000,
        maxRetries: 3,
        fireInitQueries: false,
        msgRetryCounterCache: new Map(),
        transactionOpts: { maxCommitRetries: 2, delayBeforeRetry: 1500 },
        getMessage: async () => undefined,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => jid?.endsWith('@g.us') || jid?.endsWith('@broadcast')
      });

      this.store.bind(sock.ev);

      let pairingCode = null;
      let pairingSuccess = false;

      // Génération du pairing code
      try {
        log.info(`📱 Génération du code pairing pour ${phoneNumber}...`);
        await delay(8000);

        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');

        // vérifier la propriété de registered de façon sûre
        const registered = !!sock?.authState?.creds?.registered;

        if (!registered) {
          pairingCode = await sock.requestPairingCode(cleanNumber);
          if (!pairingCode) throw new Error("Aucun code retourné par WhatsApp");

          // format esthétique
          pairingCode = pairingCode.replace(/(.{4})/g, '$1-').replace(/-$/, '');
          log.success(`✅ Code généré: ${pairingCode}`);

          // Envoi du code via ton backend / pont
          await this.sendPairingCodeViaHTTP(userId, pairingCode, cleanNumber).catch(e => log.warn('sendPairingCodeViaHTTP failed', e));
          await this.sendMessageViaHTTP(userId,
            `🔑 *Code de Pairing généré !*\n\n` +
            `📱 Pour: ${cleanNumber}\n` +
            `🧩 Code: *${pairingCode}*\n\n` +
            `👉 Ouvrez WhatsApp > Paramètres > Appareils liés > Lier un appareil.\n` +
            `Entrez le code immédiatement.\n\n` +
            `⏱️ Valide 5 minutes.`).catch(() => {});
        } else {
          log.info('✅ Déjà enregistré, connexion directe');
          pairingSuccess = true;
        }
      } catch (err) {
        log.error(`❌ Erreur génération code: ${err?.message || err}`);
        if (String(err?.message || '').includes('too many attempts')) {
          throw new Error('Trop de tentatives. Attendez 10 min avant de réessayer.');
        } else if (String(err?.message || '').includes('invalid')) {
          throw new Error('Numéro de téléphone invalide.');
        } else {
          throw new Error('Service WhatsApp temporairement indisponible.');
        }
      }

      // connection.update: gérer open/close/connecting
      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        
        const connectionInfo = { 
          connection, 
          hasQR: !!qr,
          isNewLogin,
          error: lastDisconnect?.error?.message,
          statusCode: lastDisconnect?.error?.output?.statusCode
        };
        
        log.info(`🔌 [PAIRING] ${userId} - Connection update:`, connectionInfo);
        try {
          const { connection, lastDisconnect } = update;

          switch (connection) {
            case "open":
              log.success(`🎉 Pairing réussi pour ${userId}`);
              pairingSuccess = true;

              // clear safety timeout if any
              const t = this.connectionTimeouts.get(userId);
              if (t) {
                clearTimeout(t);
                this.connectionTimeouts.delete(userId);
              }

              await this.handleSuccessfulPairing(sock, userId, userData, saveCreds, null).catch(e => log.error('handleSuccessfulPairing error', e));
              break;

            case "close":
              if (!pairingSuccess) {
                const reason = lastDisconnect?.error?.message || "Connexion fermée";
                log.error(`❌ Pairing échoué: ${reason}`);
                await this.sendMessageViaHTTP(userId,
                  `❌ *Échec de connexion pairing*\n\n` +
                  `Raison: ${reason}\n\n` +
                  `💡 Réessayez avec la méthode *QR Code* ou vérifiez votre Internet.`).catch(() => {});
                await this.cleanupPairing(userId);
              }
              break;

            case "connecting":
              log.info(`🔄 Connexion en cours pour ${userId}...`);
              break;
          }
        } catch (e) {
          log.error('connection.update handler error:', e);
        }
      });

      // sauvegarde creds
      sock.ev.on("creds.update", saveCreds);

      // Safety timeout (3 minutes) — conserve la référence dans pairingTimeouts
      const safetyTimeout = setTimeout(async () => {
        if (!pairingSuccess) {
          log.warn(`⏰ Timeout global du pairing pour ${userId}`);
          await this.sendMessageViaHTTP(userId,
            `⏰ *Le code n'a pas été utilisé à temps.*\n\n` +
            `Veuillez relancer /connect et choisir *QR Code* (plus rapide).`).catch(() => {});
          await this.cleanupPairing(userId);
        }
      }, 3 * 100 * 1000);

      this.pairingTimeouts.set(userId, safetyTimeout);

      // Storing active pairing
      this.activePairings.set(userId, {
        socket: sock,
        userData,
        phoneNumber,
        pairingCode,
        safetyTimeout,
      });

      return {
        success: true,
        method: "pairing",
        pairingCode,
        message: "Code pairing généré et (si possible) envoyé avec succès",
      };

    } catch (error) {
      log.error(`💥 ERREUR CRITIQUE pairing: ${error?.message || error}`);
      await this.cleanupPairing(userId).catch(() => {});
      await this.sendMessageViaHTTP(userId,
        `❌ *Erreur lors du pairing*\n\n${String(error?.message || error)}\n\n` +
        `🎯 Essayez à nouveau ou utilisez la méthode *QR Code*.`).catch(() => {});
      throw error;
    }
  }

  /* ---------------------------
     Après pairing réussi: copie et création session
     --------------------------- */
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
          await fs.copy(sourcePath, targetPath).catch(e => log.warn('copy auth file failed', e?.message));
        }
        log.info(`✅ Fichiers d'authentification copiés vers ${authDir}`);
      }

      const access = await this.sessionManager.authManager.checkUserAccess(userId).catch(() => ({ hasAccess: false }));
      const isPayedUser = !!access.hasAccess;

      const sessionData = {
        socket: socket,
        userId,
        userData,
        authDir,
        saveCreds,
        status: 'connected',
        subscriptionActive: isPayedUser,
        connectionMethod: 'pairing',
        createdAt: new Date(),
        lastActivity: new Date(),
        store: this.store
      };

      this.sessionManager.sessions.set(sessionId, sessionData);

      this.setupCompleteSocketEvents(socket, sessionId, userId);

      // Persist session metadata in Supabase (best-effort)
      try {
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
      } catch (e) {
        log.warn('Supabase insert failed:', e?.message || e);
      }

      // Nettoyage des temporaires et timeouts
      this.retryCounts.delete(userId);
      this.activePairings.delete(userId);
      this.cleanupUserTimeouts(userId);

      if (rl) {
        try { rl.close(); } catch {}
      }

      // Message de bienvenue
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
        if (socket.user && socket.user.id) {
          await socket.sendMessage(socket.user.id, { text: whatsappMessage }).catch(e => log.warn('welcome send failed', e?.message));
          log.success(`✅ Message de bienvenue envoyé sur WhatsApp à ${userId}`);
        } else {
          log.warn(`⚠️ Impossible d'envoyer le message WhatsApp: user.id non défini`);
        }
      } catch (whatsappError) {
        log.error(`❌ Erreur envoi message WhatsApp: ${whatsappError?.message || whatsappError}`);
      }

      // Envoi message via HTTP (pont)
      await this.sendMessageViaHTTP(userId,
        `✅ *Connexion WhatsApp réussie via Pairing!*\\n\\nVotre session est maintenant active.`).catch(() => {});

      log.success(`🎯 Session pairing créée: ${sessionId}`);

    } catch (error) {
      log.error('❌ Erreur gestion pairing réussi:', error);
      if (rl) try { rl.close(); } catch {}
    }
  }

  /* ---------------------------
     Attach events to a live socket
     --------------------------- */
  setupCompleteSocketEvents(socket, sessionId, userId) {
    const sessionManager = this.sessionManager;

    socket.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        if (connection === "open") {
          log.success(`✅ Connexion WhatsApp maintenue pour ${userId}`);
          await sessionManager.updateSessionStatus(sessionId, 'connected').catch(() => {});
        }
        if (connection === "close") {
          log.warn(`🔌 Connexion fermée pour ${userId}`);
          await sessionManager.handleConnectionClose(sessionId, lastDisconnect).catch(() => {});
        }
      } catch (e) {
        log.warn('connection.update (setupComplete) error', e?.message || e);
      }
    });

    socket.ev.on("creds.update", async (creds) => {
      try {
        const session = sessionManager.sessions.get(sessionId);
        if (session && session.saveCreds) {
          await session.saveCreds().catch(() => {});
        }
        await sessionManager.updateSessionActivity(sessionId).catch(() => {});
      } catch (e) {
        log.warn('creds.update handler error', e);
      }
    });

    socket.ev.on("messages.upsert", async (m) => {
      try {
        log.info(`📨 Message reçu pour ${userId}: ${m.messages?.length} messages`);
        await sessionManager.handleIncomingMessage(m, sessionId).catch(e => log.warn('handleIncomingMessage failed', e?.message));
      } catch (e) {
        log.warn('messages.upsert handler error', e);
      }
    });

    socket.ev.on("messages.update", async (updates) => {
      await sessionManager.updateSessionActivity(sessionId).catch(() => {});
    });

    socket.ev.on("contacts.update", async (updates) => {
      await sessionManager.updateSessionActivity(sessionId).catch(() => {});
    });

    socket.ev.on("groups.update", async (updates) => {
      await sessionManager.updateSessionActivity(sessionId).catch(() => {});
    });

    socket.ev.process(async (events) => {
      try {
        if (events['messaging-history.set']) {
          log.info(`📚 Historique des messages chargé pour ${userId}`);
        }
        if (events['chats.upsert']) await sessionManager.updateSessionActivity(sessionId).catch(() => {});
      } catch (e) { /* ignore */ }
    });
  }

  /* ---------------------------
     Prompt console pairing code (used by startPairingProcess)
     --------------------------- */
  async handlePairingCode(socket, userId, userData, question, rl) {
    try {
      // On propose le choix : saisir numéro (requestPairingCode) ou récupérer QR
      // Ici on demande le numéro
      let phoneNumber = await question(
        chalk.bgBlack(chalk.greenBright(`📱 Entrez votre numéro WhatsApp (ex: 237612345678) ou laissez vide pour QR : `))
      );

      phoneNumber = (phoneNumber || '').toString().trim();

      if (!phoneNumber) {
        // si vide -> on attend le QR (socket.emit génère qr dans connection.update)
        log.info('ℹ️ Mode QR activé (attente du QR dans connection.update)');
        return;
      }

      phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

      if (!Object.keys(PHONENUMBER_MCC).some((v) => phoneNumber.startsWith(v))) {
        log.warn("❌ Code pays invalide, réessayez");
        phoneNumber = await question(
          chalk.bgBlack(chalk.greenBright(`📱 Entrez votre numéro WhatsApp (ex: 237612345678) : `))
        );
        phoneNumber = (phoneNumber || '').replace(/[^0-9]/g, "");
      }

      // Attendre que le socket soit prêt puis requestPairingCode
      await delay(1500);

      try {
        let code = await socket.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;

        log.success(`🔑 Code de pairing généré pour l'utilisateur ${userId}: ${code}`);

        await this.sendPairingCodeViaHTTP(userId, code, phoneNumber).catch(() => {});
        console.log(chalk.black(chalk.bgGreen(`✅ Code de Pairing : `)), chalk.black(chalk.white(code)));
      } catch (err) {
        log.error('❌ Erreur génération code pairing:', err?.message || err);
        await this.sendMessageViaHTTP(userId, "❌ Erreur lors de la génération du code. Réessayez.").catch(() => {});
      }

    } catch (error) {
      log.error('❌ Erreur gestion pairing code:', error);
      try { if (rl) rl.close(); } catch {}
    }
  }

  /* ---------------------------
     Gestion fermeture connexion pairing initiée
     --------------------------- */
  async handleConnectionClose(sessionId, lastDisconnect, userId, rl) {
    const pairing = this.activePairings.get(userId);

    if (lastDisconnect?.error?.output?.statusCode !== 401) {
      log.info("🔄 Tentative de reconnexion pairing...");
      await this.cleanup().catch(() => {});
      await this.sendMessageViaHTTP(userId, "🔌 Connexion interrompue. Reconnexion en cours...").catch(() => {});
    } else {
      log.error("❌ Pairing échoué - erreur d'authentification");
      await this.sendMessageViaHTTP(userId, "❌ Échec de connexion. Réessayez avec /connect.").catch(() => {});
    }

    if (pairing) {
      try { if (pairing.rl) pairing.rl.close(); } catch {}
      try {
        if (pairing.socket) {
          if (typeof pairing.socket.logout === 'function') await pairing.socket.logout().catch(() => {});
          if (pairing.socket.ws) pairing.socket.ws.close();
        }
      } catch (e) { /* ignore */ }
      this.activePairings.delete(userId);
    }
  }

  /* ---------------------------
     Helpers HTTP (pont vers ton backend)
     --------------------------- */
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

      const result = await response.json().catch(() => ({}));

      if (result.success) {
        log.success(`✅ Code pairing envoyé à ${userId} via pont HTTP`);
        return true;
      } else {
        log.error(`❌ Échec envoi pairing à ${userId}:`, result.error || 'no-details');
        return false;
      }

    } catch (error) {
      log.error(`❌ Erreur envoi pairing à ${userId} via HTTP:`, error.message || error);
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

      const result = await response.json().catch(() => ({}));

      if (result.success) {
        log.success(`✅ QR code envoyé à ${userId} via pont HTTP`);
        return true;
      } else {
        log.error(`❌ Échec envoi QR à ${userId}:`, result.error || 'no-details');
        return false;
      }

    } catch (error) {
      log.error(`❌ Erreur envoi QR à ${userId} via HTTP:`, error.message || error);
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

      const result = await response.json().catch(() => ({}));

      if (result.success) {
        log.success(`✅ Message envoyé à ${userId} via pont HTTP`);
        return true;
      } else {
        log.error(`❌ Échec envoi message à ${userId}:`, result.error || 'no-details');
        return false;
      }

    } catch (error) {
      log.error(`❌ Erreur envoi message à ${userId} via HTTP:`, error.message || error);
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

  /* ---------------------------
     Mode autonome pour tester depuis la console
     --------------------------- */
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
