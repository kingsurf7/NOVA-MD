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
  }

  async initializePairing(userId, userData, phoneNumber = null) {
    try {
      log.info(`🔐 Initialisation pairing pour ${userId}`);

      // Nettoyage complet
      await this.cleanupSession();
      await delay(1000);

      if (phoneNumber) {
        log.info(`📱 Utilisation du numéro fourni: ${phoneNumber}`);
        return await this.startWhatsAppPairing(userId, userData, phoneNumber);
      } else {
        return await this.startInteractivePairing(userId, userData);
      }
    } catch (error) {
      log.error("❌ Erreur initialisation pairing:", error);
      await this.sendMessageViaHTTP(
        userId, 
        "❌ *Erreur d'initialisation*\nImpossible de démarrer le processus de pairing."
      );
      throw error;
    }
  }

  async startWhatsAppPairing(userId, userData, phoneNumber) {
    let socket = null;

    try {
      // Nettoyage préalable
      await this.cleanupSession();
      await delay(1000);

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionName);

      // Configuration simple et stable pour WhatsApp
      socket = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        defaultQueryTimeoutMs: 30000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        mobile: false,
        fireInitQueries: true,
      });

      let pairingCompleted = false;
      let connectionTimeout;

      // Timeout de connexion
      connectionTimeout = setTimeout(async () => {
        if (!pairingCompleted) {
          log.warn(`⏰ Timeout de connexion pairing pour ${userId}`);
          await this.sendMessageViaHTTP(
            userId,
            "⏰ *Délai dépassé*\n\nLa connexion n'a pas abouti dans le délai imparti.\nUtilisez /connect pour recommencer."
          );
          await this.cleanupPairing(userId);
        }
      }, 300000); // 5 minutes

      // Événements de connexion
      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        log.info(`🔌 [WHATSAPP] ${userId} - Statut: ${connection}`);

        if (connection === "open") {
          clearTimeout(connectionTimeout);
          pairingCompleted = true;
          
          log.success(`🎉 CONNEXION RÉUSSIE pour ${userId}`);
          await this.sendMessageViaHTTP(
            userId,
            "✅ *Connexion établie!*\nFinalisation de l'authentification..."
          );
          
          await this.handleSuccessfulConnection(socket, userId, userData, saveCreds);
          
        } else if (connection === "close") {
          clearTimeout(connectionTimeout);
          
          if (!pairingCompleted) {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            log.error(`❌ Connexion fermée: ${statusCode}`);

            let errorMsg = "❌ *Échec de connexion*\n\n";
            
            if (statusCode === 401) {
              errorMsg += "WhatsApp a refusé la connexion.\n";
              errorMsg += "• Vérifiez que le numéro est correct\n";
              errorMsg += "• Le numéro peut être déjà connecté\n";
            } else {
              errorMsg += "Problème de réseau ou de connexion.\n";
            }
            
            errorMsg += "\nUtilisez /connect pour réessayer.";
            await this.sendMessageViaHTTP(userId, errorMsg);
          }
          
          await this.cleanupPairing(userId);
        } else if (connection === "connecting") {
          log.info(`🔄 Connexion en cours pour ${userId}...`);
          // Démarrer le pairing une fois en état "connecting"
          setTimeout(async () => {
            try {
              await this.initiateWhatsAppPairing(socket, userId, phoneNumber);
            } catch (error) {
              log.error("❌ Échec initiation pairing:", error);
            }
          }, 2000);
        }
      });

      // Gestion des credentials
      socket.ev.on("creds.update", saveCreds);

      this.activePairings.set(userId, { socket, userData, phoneNumber });

      return {
        success: true,
        method: "whatsapp-pairing",
        message: "Processus WhatsApp pairing démarré",
        phoneNumber: phoneNumber,
      };

    } catch (error) {
      log.error("❌ Erreur WhatsApp pairing:", error);
      await this.cleanupPairing(userId);
      throw error;
    }
  }

  async initiateWhatsAppPairing(socket, userId, phoneNumber) {
    try {
      log.info(`📱 Lancement du pairing WhatsApp pour: ${phoneNumber}`);
      
      // Formatage du numéro
      const formattedNumber = phoneNumber.replace(/[^0-9]/g, "").trim();
      
      if (!formattedNumber || formattedNumber.length < 8) {
        throw new Error("Numéro de téléphone invalide");
      }

      // Appel principal pour le pairing WhatsApp
      // Cette méthode envoie une notification push au téléphone
      await socket.requestPairingCode(formattedNumber);

      log.success(`📲 Notification WhatsApp envoyée à ${formattedNumber}`);

      // Message à l'utilisateur
      const message = this.createPairingMessage(formattedNumber);
      await this.sendPairingNotificationViaHTTP(userId, formattedNumber, message);

      log.info(`✅ Notification pairing envoyée à ${userId}`);

    } catch (error) {
      log.error("❌ Erreur pairing WhatsApp:", error);
      
      let userMessage = "❌ *Erreur de connexion*\n\n";
      
      if (error.message?.includes("rate limit") || error.message?.includes("too many attempts")) {
        userMessage += "Trop de tentatives. Veuillez attendre 10 minutes.\n";
      } else if (error.message?.includes("invalid phone number")) {
        userMessage += "Numéro invalide. Format: 237612345678\n";
      } else if (error.message?.includes("not registered")) {
        userMessage += "Numéro non enregistré sur WhatsApp.\n";
      } else {
        userMessage += "Problème temporaire. Réessayez.\n";
      }
      
      userMessage += "\nUtilisez /connect pour réessayer.";
      await this.sendMessageViaHTTP(userId, userMessage);
      
      throw error;
    }
  }

  createPairingMessage(phoneNumber) {
    return `
📱 *CONNEXION WHATSAPP*

Pour le numéro: *${phoneNumber}*

🔔 *Une notification a été envoyée sur votre téléphone*

📲 *Instructions:*
1. Ouvrez WhatsApp sur votre téléphone
2. Allez dans *Paramètres* → *Appareils connectés* → *Connecter un appareil*
3. Recherchez la notification et appuyez sur *"Connexion"*

⏰ La notification expire dans 5 minutes.

⚠️ *Ne confirmez que si vous êtes à l'origine de cette demande!*
    `.trim();
  }

  async startInteractivePairing(userId, userData) {
    try {
      await this.cleanupSession();

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionName);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const question = (text) => new Promise((resolve) => rl.question(text, resolve));

      const socket = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: 120000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      // Demander le numéro
      console.log(chalk.green("\n🔐 CONNEXION WHATSAPP DESKTOP"));
      let phoneNumber = await question(
        chalk.blue("📱 Entrez votre numéro WhatsApp (ex: 237612345678): ")
      );

      phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

      if (!phoneNumber || phoneNumber.length < 8) {
        console.log(chalk.red("❌ Numéro invalide"));
        rl.close();
        throw new Error("Numéro invalide");
      }

      console.log(chalk.yellow("🔄 Connexion en cours..."));

      // Gestion de la connexion
      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          console.log(chalk.green("✅ Connexion WhatsApp réussie!"));
          await this.handleSuccessfulConnection(socket, userId, userData, saveCreds, rl);
        } else if (connection === "close") {
          console.log(chalk.red("❌ Connexion fermée"));
          if (lastDisconnect?.error) {
            console.log(chalk.red("Erreur:", lastDisconnect.error.message));
          }
          rl.close();
        } else if (connection === "connecting") {
          // Démarrer le pairing quand la connexion est en cours
          setTimeout(async () => {
            try {
              console.log(chalk.blue("📲 Envoi de la notification WhatsApp..."));
              await socket.requestPairingCode(phoneNumber);
              console.log(chalk.green("✅ Notification envoyée!"));
              console.log(chalk.cyan("📱 Vérifiez les notifications sur votre téléphone"));
            } catch (error) {
              console.log(chalk.red("❌ Erreur:", error.message));
            }
          }, 3000);
        }
      });

      socket.ev.on("creds.update", saveCreds);

      this.activePairings.set(userId, { socket, rl, userData });

      return { success: true, method: "interactive-pairing" };

    } catch (error) {
      log.error("❌ Erreur pairing interactif:", error);
      throw error;
    }
  }

  async handleSuccessfulConnection(socket, userId, userData, saveCreds, rl = null) {
    try {
      const sessionId = `pairing_${userId}_${Date.now()}`;
      const authDir = path.join(process.cwd(), "sessions", sessionId);

      // Sauvegarder la session
      await fs.ensureDir(authDir);
      const sourcePath = path.join(process.cwd(), this.sessionName);
      if (await fs.pathExists(sourcePath)) {
        await fs.copy(sourcePath, authDir);
      }

      await this.cleanupSession();

      // Vérifier l'accès utilisateur
      const access = await this.sessionManager.authManager.checkUserAccess(userId);
      const isPayedUser = access.hasAccess;

      // Créer la session
      const sessionData = {
        socket: socket,
        userId: userId,
        userData: userData,
        authDir: authDir,
        saveCreds: saveCreds,
        status: "connected",
        subscriptionActive: isPayedUser,
        connectionMethod: "whatsapp-pairing",
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      this.sessionManager.sessions.set(sessionId, sessionData);

      // Sauvegarder en base
      if (this.sessionManager.supabase) {
        await this.sessionManager.supabase.from("whatsapp_sessions").insert([
          {
            session_id: sessionId,
            user_id: userId,
            user_data: userData,
            status: "connected",
            subscription_active: isPayedUser,
            connection_method: "whatsapp-pairing",
            created_at: new Date().toISOString(),
            connected_at: new Date().toISOString(),
            last_activity: new Date().toISOString(),
          },
        ]);
      }

      // Nettoyer
      this.activePairings.delete(userId);
      if (rl) rl.close();

      // Message de succès
      const successMessage = `
🎉 *CONNEXION RÉUSSIE!*

✅ Connecté avec succès
📱 Méthode: Notification WhatsApp
⭐ Statut: ${isPayedUser ? "Premium" : "Essai"}

🤖 Votre assistant NOVA-MD est maintenant actif!
Utilisez !menu pour voir les commandes.
      `.trim();

      await this.sendMessageViaHTTP(userId, successMessage);
      log.success(`✅ Session WhatsApp créée: ${sessionId}`);

    } catch (error) {
      log.error("❌ Erreur finalisation connexion:", error);
      if (rl) rl.close();
    }
  }

  // =========================================================================
  // MÉTHODES UTILITAIRES
  // =========================================================================

  async cleanupSession() {
    try {
      const sessionPath = path.join(process.cwd(), this.sessionName);
      if (await fs.pathExists(sessionPath)) {
        await fs.remove(sessionPath);
        log.info("🧹 Session temporaire nettoyée");
      }
    } catch (error) {
      log.error("❌ Erreur nettoyage session:", error);
    }
  }

  async cleanupPairing(userId) {
    try {
      const pairing = this.activePairings.get(userId);
      if (pairing) {
        if (pairing.socket) {
          try {
            pairing.socket.ev.removeAllListeners();
            if (typeof pairing.socket.end === "function") {
              pairing.socket.end();
            }
          } catch (e) {
            log.warn("Erreur fermeture socket:", e);
          }
        }
        if (pairing.rl) {
          pairing.rl.close();
        }
      }
      this.activePairings.delete(userId);
      await this.cleanupSession();
      log.info(`🧹 Pairing nettoyé pour ${userId}`);
    } catch (error) {
      log.error(`❌ Erreur nettoyage pairing ${userId}:`, error);
    }
  }

  // =========================================================================
  // MÉTHODES PONT HTTP
  // =========================================================================

  async sendPairingNotificationViaHTTP(userId, phoneNumber, message) {
    try {
      if (!global.fetch) {
        log.info(`📱 [FALLBACK] Pairing notification pour ${userId}`);
        console.log("\n" + message + "\n");
        return true;
      }

      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          user_id: userId, 
          phone_number: phoneNumber,
          message: message,
          type: "whatsapp_notification"
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          log.success(`✅ Notification pairing envoyée à ${userId}`);
          return true;
        }
      }

      // Fallback aux logs
      log.info(`📱 [FALLBACK] Pairing notification pour ${userId}`);
      console.log("\n" + message + "\n");
      return true;

    } catch (error) {
      log.warn(`⚠️ Échec envoi HTTP, fallback logs`);
      log.info(`📱 Notification pairing pour ${userId}`);
      console.log("\n" + message + "\n");
      return true;
    }
  }

  async sendMessageViaHTTP(userId, message) {
    try {
      if (!global.fetch) {
        log.info(`📱 [FALLBACK] Message pour ${userId}: ${message}`);
        return true;
      }

      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, message }),
      });

      if (response.ok) {
        const result = await response.json();
        return result.success || true;
      }

      return false;

    } catch (error) {
      log.warn(`⚠️ Échec envoi message à ${userId}`);
      log.info(`📱 Message pour ${userId}: ${message}`);
      return true;
    }
  }

  async standalonePairing() {
    if (!this.isPairingMode) {
      console.log(chalk.red("❌ Utilisez --use-pairing-code pour le mode pairing"));
      process.exit(1);
    }

    CFonts.say("WHATSAPP PAIRING", {
      font: "tiny",
      align: "center",
      colors: ["green", "blue"],
    });

    console.log(chalk.green("🔐 Connexion WhatsApp Desktop"));
    console.log(chalk.blue("Identique à WhatsApp Web/Desktop\n"));

    const userId = "standalone_" + Date.now();
    const userData = { name: "Standalone User" };

    try {
      await this.startInteractivePairing(userId, userData);
    } catch (error) {
      console.error("❌ Erreur pairing autonome:", error);
      process.exit(1);
    }
  }
}

module.exports = PairingManager;
