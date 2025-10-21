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
    this.pairingAttempts = new Map();
  }

  async initializePairing(userId, userData, phoneNumber = null) {
    try {
      log.info(`🔐 Initialisation pairing pour ${userId}`);

      // Nettoyage complet
      await this.cleanupSession();
      await delay(2000);

      // Réinitialiser les tentatives
      this.pairingAttempts.set(userId, 0);

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
      // Nettoyage préalable complet
      await this.cleanupSession();
      await delay(2000);

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionName);

      // Configuration SIMPLIFIÉE et stable
      socket = makeWASocket({
        logger: pino({ level: "error" }), // Seulement les erreurs
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 180000,
        keepAliveIntervalMs: 60000,
        defaultQueryTimeoutMs: 30000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        mobile: false,
        fireInitQueries: true,
        retryRequestDelayMs: 2000,
        maxRetries: 1,
        // Désactiver les optimisations problématiques
        appStateMacVerification: {
          patch: false,
          snapshot: false
        },
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined
      });

      let pairingCompleted = false;
      let connectionTimeout;

      // Timeout de connexion globale
      connectionTimeout = setTimeout(async () => {
        if (!pairingCompleted) {
          log.warn(`⏰ Timeout de connexion pour ${userId}`);
          await this.sendMessageViaHTTP(
            userId,
            "⏰ *Délai dépassé*\n\nLa connexion n'a pas abouti.\nUtilisez /connect pour recommencer."
          );
          await this.cleanupPairing(userId);
        }
      }, 300000); // 3 minutes

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
            "✅ *Connexion établie!*\nFinalisation en cours..."
          );
          
          await delay(1000);
          await this.handleSuccessfulConnection(socket, userId, userData, saveCreds);
          
        } else if (connection === "close") {
          clearTimeout(connectionTimeout);
          
          if (!pairingCompleted) {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            log.error(`❌ Connexion fermée: ${statusCode} - ${errorMessage}`);

            let userMsg = "❌ *Échec de connexion*\n\n";
            
            if (statusCode === 428) {
              userMsg += "WhatsApp a bloqué la connexion pour sécurité.\n";
              userMsg += "• Attendez 10-15 minutes\n";
              userMsg += "• Utilisez le QR Code à la place\n";
            } else if (statusCode === 429) {
              userMsg += "Trop de tentatives.\n";
              userMsg += "Attendez 1 heure puis réessayez.\n";
            } else if (statusCode === 401) {
              userMsg += "Authentification refusée.\n";
              userMsg += "Numéro peut-être déjà connecté.\n";
            } else {
              userMsg += "Problème réseau temporaire.\n";
            }
            
            userMsg += "\nUtilisez /connect pour réessayer plus tard.";
            await this.sendMessageViaHTTP(userId, userMsg);
          }
          
          await this.cleanupPairing(userId);
        } else if (connection === "connecting") {
          log.info(`🔄 Connexion en cours pour ${userId}...`);
          
          // Attendre que le socket soit vraiment prêt avant de tenter le pairing
          setTimeout(async () => {
            try {
              const attempts = this.pairingAttempts.get(userId) || 0;
              if (attempts === 0) {
                await this.initiateWhatsAppPairing(socket, userId, phoneNumber);
              }
            } catch (error) {
              log.error("❌ Échec initiation pairing:", error.message);
            }
          }, 5000); // Attendre 5 secondes que la connexion soit stable
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
      log.error("❌ Erreur création socket pairing:", error);
      await this.cleanupPairing(userId);
      throw error;
    }
  }

  async initiateWhatsAppPairing(socket, userId, phoneNumber) {
    const attempts = this.pairingAttempts.get(userId) || 0;
    
    if (attempts >= 2) {
      log.warn(`🚫 Trop de tentatives pairing pour ${userId}`);
      await this.sendMessageViaHTTP(
        userId,
        "🚫 *Trop de tentatives*\n\nVeuillez attendre 15 minutes ou utiliser le QR Code."
      );
      return;
    }

    try {
      log.info(`📱 Tentative pairing ${attempts + 1}/2 pour: ${phoneNumber}`);
      
      // Formatage du numéro
      const formattedNumber = phoneNumber.replace(/[^0-9]/g, "").trim();
      
      if (!formattedNumber || formattedNumber.length < 8) {
        throw new Error("Numéro de téléphone invalide");
      }

      // Attendre un peu avant de faire la requête
      await delay(3000);

      // Tenter le pairing avec timeout
      const pairingPromise = socket.requestPairingCode(formattedNumber);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout pairing")), 15000)
      );

      const pairingCode = await Promise.race([pairingPromise, timeoutPromise]);

      if (!pairingCode) {
        throw new Error("Aucun code de pairing généré");
      }

      log.success(`🔑 Code pairing généré pour ${userId}: ${pairingCode}`);

      // Message à l'utilisateur
      const message = this.createPairingMessage(formattedNumber, pairingCode);
      await this.sendPairingNotificationViaHTTP(userId, formattedNumber, pairingCode, message);

      log.info(`✅ Notification pairing envoyée à ${userId}`);

      // Incrémenter les tentatives réussies
      this.pairingAttempts.set(userId, attempts + 1);

    } catch (error) {
      log.error("❌ Erreur pairing WhatsApp:", error);
      
      // Incrémenter les tentatives échouées
      this.pairingAttempts.set(userId, attempts + 1);

      let userMessage = "❌ *Erreur de connexion*\n\n";
      
      if (error.output?.statusCode === 428) {
        userMessage += "🔒 *WhatsApp a bloqué la connexion*\n\n";
        userMessage += "Pour des raisons de sécurité, WhatsApp limite les connexions rapides.\n\n";
        userMessage += "🎯 *Solutions:*\n";
        userMessage += "• Utilisez la méthode **QR Code** (recommandé)\n";
        userMessage += "• Attendez 15-20 minutes\n";
        userMessage += "• Vérifiez votre connexion internet\n";
      } else if (error.message?.includes("Timeout")) {
        userMessage += "⏰ *Délai dépassé*\n\n";
        userMessage += "WhatsApp ne répond pas.\n";
        userMessage += "Essayez avec le QR Code.\n";
      } else if (error.message?.includes("rate limit")) {
        userMessage += "🚫 *Trop de tentatives*\n\n";
        userMessage += "Attendez 1 heure avant de réessayer.\n";
      } else {
        userMessage += "🔧 *Problème technique*\n\n";
        userMessage += "Réessayez ou utilisez le QR Code.\n";
      }
      
      userMessage += "\nUtilisez `/connect qr` pour le QR Code.";
      await this.sendMessageViaHTTP(userId, userMessage);
      
      throw error;
    }
  }

  createPairingMessage(phoneNumber, pairingCode = null) {
    if (pairingCode) {
      // Mode avec code (fallback)
      return `
📱 *CONNEXION WHATSAPP*

Pour le numéro: *${phoneNumber}*

🔢 *Votre code de connexion:*
╔═══════════════╗
║ ${pairingCode}   ║
╚═══════════════╝

📲 *Instructions:*
1. Ouvrez WhatsApp → Paramètres → Appareils connectés
2. Appuyez sur *"Connecter un appareil"*
3. Tapez le code ci-dessus

⏰ Code valable 5 minutes.

⚠️ *Ne partagez jamais ce code!*
      `.trim();
    } else {
      // Mode notification standard
      return `
📱 *CONNEXION WHATSAPP*

Pour le numéro: *${phoneNumber}*

🔔 *Une notification a été envoyée sur votre téléphone*

📲 *Instructions:*
1. Ouvrez WhatsApp sur votre téléphone
2. Recherchez *"WhatsApp Web veut se connecter"*
3. Appuyez sur *"Connexion"* pour confirmer

⏰ Notification valable 5 minutes.

⚠️ *Ne confirmez que si vous êtes à l'origine de cette demande!*
      `.trim();
    }
  }

  async startInteractivePairing(userId, userData) {
    try {
      await this.cleanupSession();
      await delay(1000);

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
        connectTimeoutMs: 60000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        mobile: false,
      });

      console.log(chalk.green("\n🔐 CONNEXION WHATSAPP DESKTOP"));
      console.log(chalk.yellow("⚠️  Si ça échoue, utilisez plutôt le QR Code\n"));

      let phoneNumber = await question(
        chalk.blue("📱 Entrez votre numéro WhatsApp (ex: 237612345678): ")
      );

      phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

      if (!phoneNumber || phoneNumber.length < 8) {
        console.log(chalk.red("❌ Numéro invalide"));
        rl.close();
        throw new Error("Numéro invalide");
      }

      console.log(chalk.yellow("🔄 Initialisation en cours..."));

      let pairingAttempted = false;

      // Gestion de la connexion
      socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          console.log(chalk.green("✅ Connexion WhatsApp réussie!"));
          await this.handleSuccessfulConnection(socket, userId, userData, saveCreds, rl);
        } else if (connection === "close") {
          console.log(chalk.red("❌ Connexion fermée"));
          if (lastDisconnect?.error) {
            console.log(chalk.red("Détails:", lastDisconnect.error.message));
          }
          rl.close();
        } else if (connection === "connecting" && !pairingAttempted) {
          pairingAttempted = true;
          
          setTimeout(async () => {
            try {
              console.log(chalk.blue("📲 Tentative d'envoi de notification..."));
              const code = await socket.requestPairingCode(phoneNumber);
              console.log(chalk.green("✅ Notification envoyée!"));
              if (code) {
                console.log(chalk.cyan(`🔢 Code: ${code}`));
              }
              console.log(chalk.yellow("📱 Vérifiez les notifications sur votre téléphone"));
            } catch (error) {
              console.log(chalk.red("❌ Échec envoi notification:"));
              console.log(chalk.red(error.message));
              console.log(chalk.yellow("\n💡 Conseil: Utilisez la méthode QR Code"));
            }
          }, 4000);
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
      this.pairingAttempts.delete(userId);
      if (rl) rl.close();

      // Message de succès
      const successMessage = `
🎉 *CONNEXION RÉUSSIE!*

✅ Connecté avec succès à WhatsApp
📱 Méthode: Pairing
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
      this.pairingAttempts.delete(userId);
      await this.cleanupSession();
      log.info(`🧹 Pairing nettoyé pour ${userId}`);
    } catch (error) {
      log.error(`❌ Erreur nettoyage pairing ${userId}:`, error);
    }
  }

  // =========================================================================
  // MÉTHODES PONT HTTP
  // =========================================================================

  async sendPairingNotificationViaHTTP(userId, phoneNumber, pairingCode, message) {
    try {
      if (!global.fetch) {
        log.info(`📱 [FALLBACK] Pairing pour ${userId}: ${pairingCode}`);
        console.log("\n" + message + "\n");
        return true;
      }

      const response = await fetch(`${this.nodeApiUrl}/api/bot/send-pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          user_id: userId, 
          phone_number: phoneNumber,
          pairing_code: pairingCode,
          message: message
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          log.success(`✅ Notification pairing envoyée à ${userId}`);
          return true;
        }
      }

      // Fallback
      log.info(`📱 [FALLBACK] Pairing pour ${userId}: ${pairingCode}`);
      console.log("\n" + message + "\n");
      return true;

    } catch (error) {
      log.warn(`⚠️ Échec envoi HTTP, fallback logs`);
      log.info(`📱 Pairing pour ${userId}: ${pairingCode}`);
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
}

module.exports = PairingManager;
