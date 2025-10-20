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
  Browsers,
} = require("@whiskeysockets/baileys");

const { createClient } = require("@supabase/supabase-js");
const config = require("../config");
const log = require("../utils/logger")(module);

class PairingManager {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.sessionName = "pairing-auth";
    this.supabase = createClient(config.supabase.url, config.supabase.key);
    this.isPairingMode = process.argv.includes("--use-pairing-code");
    this.activePairings = new Map();
    this.nodeApiUrl = process.env.NODE_API_URL || "http://localhost:3000";
    this.retryCounts = new Map();
  }

  async initializePairing(userId, userData, phoneNumber = null) {
    try {
      log.info(`🔐 Initialisation pairing pour ${userId}`);

      // NETTOYAGE COMPLET de la session précédente
      const sessionPath = path.join(__dirname, this.sessionName);
      if (await fs.pathExists(sessionPath)) {
        log.info("🧹 Nettoyage de la session existante");
        await fs.emptyDir(sessionPath);
        await delay(2000);
      }

      // Réinitialiser le compteur de tentatives
      this.retryCounts.set(userId, 0);

      // Si numéro fourni, l'utiliser directement
      if (phoneNumber) {
        log.info(`📱 Utilisation du numéro fourni pour ${userId}`);
        return await this.startPairingWithPhone(userId, userData, phoneNumber);
      } else {
        return await this.startPairingProcess(userId, userData);
      }
    } catch (error) {
      log.error("❌ Erreur initialisation pairing:", error);
      throw error;
    }
  }

  async startPairingWithPhone(userId, userData, phoneNumber) {
    try {
      // NETTOYAGE PRÉALABLE COMPLET
      const sessionPath = path.join(__dirname, this.sessionName);
      if (await fs.pathExists(sessionPath)) {
        await fs.emptyDir(sessionPath);
        await delay(1000);
      }

      const { state, saveCreds } = await useMultiFileAuthState("./" + this.sessionName);
      const { version } = await fetchLatestBaileysVersion();

      // CONFIGURATION OPTIMISÉE POUR PAIRING
      const socket = makeWASocket({
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        connectTimeoutMs: 570000, // Augmenté à 5 minutes
        defaultQueryTimeoutMs: 120000,
        keepAliveIntervalMs: 60000,
        retryRequestDelayMs: 5000,
        maxRetries: 4, // Plus de tentatives
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        fireInitQueries: false,
        mobile: false,
        appStateMacVerification: {
          patch: false,
          snapshot: false
        },
        transactionOpts: {
          maxCommitRetries: 3,
          delayBeforeRetry: 2000
        },
        getMessage: async () => undefined
      });

      let pairingCodeSent = false;
      let pairingSuccess = false;
      let connectionTimeout;
      let pairingCode = null;
      const currentRetryCount = this.retryCounts.get(userId) || 0;

      // Timeout pour générer le code pairing (réduit)
      const pairingTimeout = setTimeout(async () => {
        if (!pairingCodeSent && currentRetryCount < 3) {
          try {
            log.info(`📱 Génération du code pairing pour le numéro: ${phoneNumber}`);

            // Attendre que la connexion soit prête
            await delay(2000);

            // Générer le code pairing (peut lancer des erreurs si socket pas prêt)
            pairingCode = await socket.requestPairingCode(phoneNumber.trim());

            if (!pairingCode) throw new Error("Aucun code pairing généré");

            // Formater le code
            pairingCode = pairingCode.match(/.{1,4}/g)?.join("-") || pairingCode;

            log.success(`🔑 Code de pairing généré pour ${userId}: ${pairingCode}`);

            // Utiliser le pont HTTP pour envoyer le code
            const sent = await this.sendPairingCodeViaHTTP(userId, pairingCode, phoneNumber);
            if (sent) {
              pairingCodeSent = true;

              // Démarrer un timeout de connexion
              connectionTimeout = setTimeout(async () => {
                if (!pairingSuccess) {
                  log.warn(`⏰ Timeout de connexion pairing pour ${userId}`);
                  await this.sendMessageViaHTTP(
                    userId,
                    "⏰ *Timeout de connexion*\n\n" +
                      "Le code de pairing n'a pas été utilisé dans les 5 minutes.\n\n" +
                      "Veuillez redémarrer le processus avec /connect"
                  );
                  await this.cleanupPairing(userId);
                }
              }, 600000); // 8 minutes

              log.info(`✅ Code pairing ${pairingCode} envoyé à ${userId}`);
            } else {
              throw new Error("Échec envoi du code pairing");
            }
          } catch (error) {
            log.error("❌ Erreur génération code pairing:", error);

            const retryCount = currentRetryCount + 1;
            this.retryCounts.set(userId, retryCount);

            if (retryCount < 3) {
              log.info(`🔄 Tentative ${retryCount}/3 de pairing pour ${userId}`);
              await this.sendMessageViaHTTP(
                userId,
                `🔄 *Tentative de reconnexion ${retryCount}/3 en cours...*\n\n` + `Nouvelle tentative automatique...`
              );

              //réessayer 
              setTimeout(() => {
                this.startPairingWithPhone(userId, userData, phoneNumber).catch((e) =>
                  log.error("retry error:", e)
                );
              }, 4000);
              return;
            }

            // Échec final après 3 tentatives
            await this.sendMessageViaHTTP(
              userId,
              "❌ **Impossible de générer un code pairing**\n\n" +
                "Après 3 tentatives, le service WhatsApp ne répond pas.\n\n" +
                "Solutions recommandées:\n" +
                "• Utilisez la méthode **QR Code**\n" +
                "• Vérifiez votre numéro et réessayez\n" +
                "• Réessayez dans 10-15 minutes"
            );

            await this.cleanupPairing(userId);
          }
        }
      }, 4000); // Réduit à 4 secondes

      // Gestion des événements de connexion
      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;

        const connectionInfo = {
          connection,
          hasQR: !!qr,
          isNewLogin,
          error: lastDisconnect?.error?.message,
          statusCode: lastDisconnect?.error?.output?.statusCode,
        };

        log.info(`🔌 [PAIRING] ${userId} - Connection update:`, connectionInfo);

        // Ignorer les événements QR en mode pairing
        if (qr) {
          log.info(`⚠️ QR ignoré pour ${userId} (mode pairing actif)`);
          return;
        }

        if (connection === "open") {
          clearTimeout(pairingTimeout);
          clearTimeout(connectionTimeout);
          pairingSuccess = true;
          log.success(`🎉 CONNEXION RÉUSSIE via pairing pour ${userId}`);
          await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, null);
        } else if (connection === "close") {
          clearTimeout(pairingTimeout);
          clearTimeout(connectionTimeout);
          const reason = lastDisconnect?.error;
          const statusCode = reason?.output?.statusCode;

          log.error("❌ Connexion fermée pour", userId, {
            message: reason?.message,
            statusCode,
            pairingCode,
          });

          if (!pairingSuccess) {
            let errorMessage = "❌ *Échec de connexion pairing*\n\n";

            if (statusCode === 401) {
              errorMessage += "WhatsApp a refusé l'authentification.\n\n";
              errorMessage += "Causes possibles:\n";
              errorMessage += "• Numéro déjà utilisé sur un autre appareil\n";
              errorMessage += "• Session expirée ou corrompue\n";
              errorMessage += "• Restrictions de sécurité WhatsApp\n\n";
            } else if (statusCode === 428) {
              errorMessage += "Connexion interrompue par WhatsApp.\n\n";
            } else {
              errorMessage += "Problème de connexion réseau.\n\n";
            }

            errorMessage += "🎯 *Solution recommandée:*\n";
            errorMessage += "• Utilisez la méthode *QR Code* (plus stable)\n";
            errorMessage += "• Vérifiez votre connexion internet\n";
            errorMessage += "• Réessayez dans 10 minutes";

            await this.sendMessageViaHTTP(userId, errorMessage);
          }

          await this.cleanupPairing(userId);
        } else if (connection === "connecting") {
          log.info(`🔄 Connexion en cours pour ${userId}...`);
        }
      });

      socket.ev.on("creds.update", saveCreds);

      this.activePairings.set(userId, { socket, rl: null, userData, phoneNumber });

      return {
        success: true,
        method: "pairing",
        message: "Processus pairing démarré",
        phoneNumber: phoneNumber,
        retryCount: currentRetryCount,
      };
    } catch (error) {
      log.error("❌ Erreur critique processus pairing:", error);
      await this.cleanupPairing(userId);

      await this.sendMessageViaHTTP(
        userId,
        "❌ *Erreur critique de connexion*\n\n" + "Impossible d'établir la connexion avec WhatsApp.\n\n" + "Veuillez utiliser la méthode QR Code qui est plus fiable."
      );

      throw error;
    }
  }

  async startPairingProcess(userId, userData) {
    const { state, saveCreds } = await useMultiFileAuthState("./" + this.sessionName);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (text) =>
      new Promise((resolve) => {
        rl.question(text, resolve);
      });

    try {
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 90000,
        keepAliveIntervalMs: 30000,
        mobile: false,
        fireInitQueries: true,
      });

      if (this.isPairingMode && !socket.authState?.creds?.registered) {
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

      return { success: true, method: "pairing" };
    } catch (error) {
      rl.close();
      log.error("❌ Erreur processus pairing:", error);
      throw error;
    }
  }

  async handlePairingCode(socket, userId, userData, question, rl) {
    try {
      let phoneNumber = await question(
        chalk.bgBlack(chalk.greenBright(`📱 Entrez votre numéro WhatsApp (ex: 237612345678) : `))
      );

      phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

      if (!Object.keys(PHONENUMBER_MCC).some((v) => phoneNumber.startsWith(v))) {
        log.warn("❌ Code pays invalide, réessayez");
        phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`📱 Entrez votre numéro WhatsApp : `)));
        phoneNumber = phoneNumber.replace(/[^0-9]/g, "");
      }

      setTimeout(async () => {
        try {
          let code = await socket.requestPairingCode(phoneNumber);
          code = code?.match(/.{1,4}/g)?.join("-") || code;

          log.success(`🔑 Code de pairing généré pour l'utilisateur ${userId}: ${code}`);

          // Utiliser le pont HTTP pour envoyer le code
          await this.sendPairingCodeViaHTTP(userId, code, phoneNumber);

          console.log(chalk.black(chalk.bgGreen(`✅ Code de Pairing : `)), chalk.black(chalk.white(code)));
        } catch (error) {
          log.error("❌ Erreur génération code pairing:", error);
          await this.sendMessageViaHTTP(userId, "❌ Erreur lors de la génération du code. Réessayez.");
        }
      }, 2000);
    } catch (error) {
      log.error("❌ Erreur gestion pairing code:", error);
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

  async handleSuccessfulPairing(socket, userId, userData, saveCreds, rl) {
    try {
      const sessionId = `pairing_${userId}_${Date.now()}`;
      const authDir = `./sessions/${sessionId}`;

      // Copier les credentials vers le dossier de session permanente
      await fs.copy(path.join(__dirname, this.sessionName), authDir);
      await this.cleanup();

      const access = await this.sessionManager.authManager.checkUserAccess(userId);
      const isPayedUser = access.hasAccess;

      const sessionData = {
        socket: socket,
        userId: userId,
        userData: userData,
        authDir: authDir,
        saveCreds: saveCreds,
        status: "connected",
        subscriptionActive: isPayedUser,
        connectionMethod: "pairing",
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      this.sessionManager.sessions.set(sessionId, sessionData);

      await this.sessionManager.supabase.from("whatsapp_sessions").insert([
        {
          session_id: sessionId,
          user_id: userId,
          user_data: userData,
          status: "connected",
          subscription_active: isPayedUser,
          connection_method: "pairing",
          created_at: new Date().toISOString(),
          connected_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
        },
      ]);

      // Nettoyer le compteur de tentatives
      this.retryCounts.delete(userId);
      this.activePairings.delete(userId);
      if (rl) rl.close();

      const message =
        `🎉 *CONNEXION WHATSAPP RÉUSSIE!*\n\n` +
        `✅ Méthode: Code de Pairing\n` +
        `👤 Compte: ${socket.user?.name || socket.user?.id}\n` +
        `📱 Statut: Session ${isPayedUser ? "PERMANENTE" : "essai"}\n\n` +
        `🤖 Votre bot NOVA-MD est maintenant opérationnel!\n` +
        `Utilisez !help sur WhatsApp pour voir les commandes.`;

      await this.sendMessageViaHTTP(userId, message);
      log.success(`✅ Message de succès envoyé à ${userId}`);
      log.success(`🎯 Session pairing créée: ${sessionId}`);
    } catch (error) {
      log.error("❌ Erreur gestion pairing réussi:", error);
      if (rl) rl.close();
    }
  }

  // =========================================================================
  // MÉTHODES PONT HTTP
  // =========================================================================

  async sendPairingCodeViaHTTP(userId, pairingCode, phoneNumber) {
    try {
      if (!fetch) throw new Error("fetch is not available in this environment");

      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, pairing_code: pairingCode, phone_number: phoneNumber }),
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
      log.error(`❌ Erreur envoi pairing à ${userId} via HTTP:`, error.message || error);
      return false;
    }
  }

  async sendQRCodeViaHTTP(userId, qrCode, sessionId) {
    try {
      if (!fetch) throw new Error("fetch is not available in this environment");

      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, qr_code: qrCode, session_id: sessionId }),
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
      log.error(`❌ Erreur envoi QR à ${userId} via HTTP:`, error.message || error);
      return false;
    }
  }

  async sendMessageViaHTTP(userId, message) {
    try {
      if (!fetch) throw new Error("fetch is not available in this environment");

      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, message }),
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
      log.error(`❌ Erreur envoi message à ${userId} via HTTP:`, error.message || error);
      return false;
    }
  }

  async getPairingStatus(userId) {
    try {
      const { data, error } = await this.supabase
        .from("pairing_codes")
        .select("*")
        .eq("user_id", userId)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      return data;
    } catch (error) {
      return null;
    }
  }

  async cleanup() {
    try {
      const sessionPath = path.join(__dirname, this.sessionName);
      if (await fs.pathExists(sessionPath)) {
        await fs.emptyDir(sessionPath);
      }
    } catch (error) {
      log.error("❌ Erreur nettoyage pairing:", error);
    }
  }

  async cleanupPairing(userId) {
    try {
      const pairing = this.activePairings.get(userId);
      if (pairing && pairing.socket) {
        try {
          if (typeof pairing.socket.end === "function") pairing.socket.end();
        } catch (e) {
          log.warn("Erreur lors de l'arrêt du socket:", e);
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

    CFonts.say("Connexion WhatsApp via Code de Pairing\nPowered by NOVA-MD Premium\n", {
      colors: ["system"],
      font: "console",
      align: "center",
    });

    const userId = "standalone_" + Date.now();
    const userData = { name: "Standalone User" };

    try {
      await this.initializePairing(userId, userData);
    } catch (error) {
      console.error("❌ Erreur pairing autonome:", error);
      process.exit(1);
    }
  }
}

module.exports = PairingManager; 
