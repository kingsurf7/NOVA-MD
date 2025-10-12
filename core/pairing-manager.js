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
  }

  async initializePairing(userId, userData, phoneNumber = null) {
    try {
      log.info(`🔐 Initialisation pairing pour ${userId}`);
      
      const sessionExists = await fs.pathExists(path.join(__dirname, this.sessionName));
      if (sessionExists) {
        log.info("🧹 Nettoyage de la session existante");
        await fs.emptyDir(path.join(__dirname, this.sessionName));
        await delay(800);
      }

      // Si numéro fourni, l'utiliser directement
      if (phoneNumber) {
        log.info(`📱 Utilisation du numéro fourni pour ${userId}`);
        return await this.startPairingWithPhone(userId, userData, phoneNumber);
      } else {
        return await this.startPairingProcess(userId, userData);
      }
      
    } catch (error) {
      log.error('❌ Erreur initialisation pairing:', error);
      throw error;
    }
  }

  async startPairingProcess(userId, userData) {
    const { state, saveCreds } = await useMultiFileAuthState("./" + this.sessionName);
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const question = (text) => new Promise((resolve) => rl.question(text, resolve));

    try {
      const socket = makeWASocket({
        logger: pino({ level: "silent" }),
        browser: ["Chrome (Linux)", "", ""],
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: false
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

// Dans pairing-manager.js - améliorer startPairingWithPhone
async startPairingWithPhone(userId, userData, phoneNumber) {
    const { state, saveCreds } = await useMultiFileAuthState("./" + this.sessionName);
    
    try {
        const socket = makeWASocket({
            logger: pino({ level: "silent" }),
            browser: ["Ubuntu", "Chrome", "120.0.0.0"],
            auth: state,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            printQRInTerminal: false,
            connectTimeoutMs: 30000
        });

        let pairingCodeSent = false;
        
        const pairingTimeout = setTimeout(async () => {
            if (!pairingCodeSent) {
                try {
                    log.info(`📱 Génération du code pairing pour le numéro: ${phoneNumber.substring(0, 6)}...`);
                    
                    let code = await socket.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    
                    log.success(`🔑 Code de pairing généré pour l'utilisateur ${userId}: ${code}`);
                    
                    // Utiliser le pont HTTP pour envoyer le code
                    const sent = await this.sendPairingCodeViaHTTP(userId, code, phoneNumber);
                    if (sent) {
                        pairingCodeSent = true;
                        
                        // Envoyer des instructions supplémentaires
                        await this.sendMessageViaHTTP(userId, 
                            `📋 *Instructions importantes:*\n\n` +
                            `1. Ouvrez WhatsApp sur votre téléphone\n` +
                            `2. Allez dans *Paramètres* → *Appareils liés* → *Lier un appareil*\n` +
                            `3. Entrez le code: *${code}*\n` +
                            `4. Attendez la confirmation\n\n` +
                            `⏱️ *Ce code expire dans 5 minutes*`
                        );
                    } else {
                        log.error(`❌ Échec envoi pairing à ${userId} via HTTP`);
                    }

                } catch (error) {
                    log.error('❌ Erreur génération code pairing:', error);
                    await this.sendMessageViaHTTP(userId, 
                        "❌ *Erreur lors de la génération du code pairing*\n\n" +
                        "Raisons possibles:\n" +
                        "• Numéro WhatsApp invalide\n" +
                        "• Problème de réseau\n" +
                        "• WhatsApp bloqué temporairement\n\n" +
                        "Réessayez ou utilisez la méthode QR Code"
                    );
                }
            }
        }, 5000); // Augmenter le délai

        socket.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                log.info(`📱 QR généré comme fallback pour ${userId}`);
                // Fallback QR si pairing échoue
                await this.sendQRCodeViaHTTP(userId, qr, `pairing_fallback_${userId}`);
            }
            
            if (connection === "open") {
                clearTimeout(pairingTimeout);
                log.success(`✅ Connexion WhatsApp réussie via pairing pour ${userId}`);
                await this.handleSuccessfulPairing(socket, userId, userData, saveCreds, null);
                
            } else if (connection === "close") {
                clearTimeout(pairingTimeout);
                const reason = lastDisconnect?.error;
                log.error(`❌ Connexion fermée pour ${userId}:`, reason?.message);
                
                if (reason?.output?.statusCode === 401) {
                    await this.sendMessageViaHTTP(userId,
                        "❌ *Échec d'authentification*\n\n" +
                        "Le code de pairing a expiré ou est invalide.\n" +
                        "Réessayez avec /connect"
                    );
                } else {
                    await this.sendMessageViaHTTP(userId,
                        "❌ *Connexion interrompue*\n\n" +
                        "Problème de réseau ou de connexion.\n" +
                        "Réessayez avec /connect"
                    );
                }
            }
        });

        socket.ev.on("creds.update", saveCreds);

        this.activePairings.set(userId, { socket, rl: null, userData });

        return { success: true, method: 'pairing', message: 'Code de pairing généré' };

    } catch (error) {
        log.error('❌ Erreur processus pairing avec phone:', error);
        
        // Informer l'utilisateur de l'erreur
        await this.sendMessageViaHTTP(userId,
            "❌ *Erreur de connexion*\n\n" +
            "Impossible de démarrer le processus de pairing.\n" +
            "Raisons possibles:\n" +
            "• Service WhatsApp temporairement indisponible\n" +
            "• Problème de réseau\n" +
            "• Numéro invalide\n\n" +
            "Réessayez ou contactez le support"
        );
        
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
          // 🔒 NUMÉRO NON LOGGÉ pour la sécurité
          
          // Utiliser le pont HTTP pour envoyer le code
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

  async handleSuccessfulPairing(socket, userId, userData, saveCreds, rl) {
    try {
      const sessionId = `pairing_${userId}_${Date.now()}`;
      const authDir = `./sessions/${sessionId}`;

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
        status: 'connected',
        subscriptionActive: isPayedUser,
        connectionMethod: 'pairing',
        createdAt: new Date(),
        lastActivity: new Date()
      };

      this.sessionManager.sessions.set(sessionId, sessionData);

      await this.supabase
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

      this.activePairings.delete(userId);
      if (rl) rl.close();

      let message = `✅ *Connexion WhatsApp Réussie!*\\n\\n`;
      message += `Méthode: Code de Pairing\\n`;
      message += `Compte: ${socket.user?.name || socket.user?.id}\\n`;
      
      if (sessionData.subscriptionActive) {
        message += `\\n🔐 *SESSION PERMANENTE* - Reste active 30 jours\\n`;
        message += `Vous n'aurez pas à vous reconnecter!`;
      }

      await this.sendMessageViaHTTP(userId, message);
      log.success(`✅ Message de succès pairing envoyé à ${userId}`);

      log.success(`🎯 Session pairing créée: ${sessionId} (${isPayedUser ? 'Payante' : 'Essai'})`);

    } catch (error) {
      log.error('❌ Erreur gestion pairing réussi:', error);
      if (rl) rl.close();
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

  // =========================================================================
  // MÉTHODES PONT HTTP
  // =========================================================================

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
      await fs.emptyDir("./" + this.sessionName);
    } catch (error) {
      log.error('❌ Erreur nettoyage pairing:', error);
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
