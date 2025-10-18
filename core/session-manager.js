const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const P = require("pino");
const config = require('../config');
const AuthManager = require('./auth-manager');
const PairingManager = require('./pairing-manager');
const TrialManager = require('./trial-manager');
const log = require('../utils/logger')(module);

class SessionManager {
    constructor() {
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.authManager = new AuthManager();
        this.trialManager = new TrialManager();
        this.pairingManager = new PairingManager(this);
        this.sessions = new Map();
        this.userSettings = new Map();
        this.telegramBot = null;
        this.nodeApiUrl = process.env.NODE_API_URL || 'http://localhost:3000';
        
        this.loadUserSettings();
        this.setupSessionMaintenance();
    }

    setTelegramBot(bot) {
        this.telegramBot = bot;
        this.pairingManager.sessionManager.telegramBot = bot;
        log.success('✅ Bot Telegram configuré dans SessionManager');
    }

    async loadUserSettings() {
        try {
            const { data, error } = await this.supabase
                .from('user_settings')
                .select('*');
                
            if (!error && data) {
                for (const setting of data) {
                    this.userSettings.set(setting.user_id, setting);
                }
                log.success(`✅ ${data.length} paramètres utilisateur chargés`);
            }
        } catch (error) {
            log.error('❌ Erreur chargement paramètres utilisateur:', error);
        }
    }

    async saveUserSetting(userId, setting) {
        try {
            const existing = this.userSettings.get(userId) || {};
            const newSetting = { ...existing, ...setting, user_id: userId, updated_at: new Date().toISOString() };
            
            const { error } = await this.supabase
                .from('user_settings')
                .upsert(newSetting, { onConflict: 'user_id' });
                
            if (error) throw error;
            
            this.userSettings.set(userId, newSetting);
            log.info(`⚙️ Paramètres sauvegardés pour ${userId}`);
            return { success: true };
        } catch (error) {
            log.error('❌ Erreur sauvegarde paramètre:', error);
            return { success: false, error: error.message };
        }
    }

    getUserSetting(userId) {
        return this.userSettings.get(userId) || {
            user_id: userId,
            silent_mode: false,
            private_mode: false,
            allowed_users: [],
            created_at: new Date().toISOString()
        };
    }

    async createSession(userId, userData, method = 'qr') {
        try {
            const access = await this.authManager.checkUserAccess(userId);
            const trial = await this.trialManager.checkTrialAccess(userId);
            
            const hasAccess = access.hasAccess || trial.hasTrial;
            
            if (!hasAccess) {
                // Créer un essai automatique pour les nouveaux utilisateurs
                const newTrial = await this.trialManager.createTrialSession(userId, userData);
                if (!newTrial.success) {
                    throw new Error(`Accès refusé. ${newTrial.error}`);
                }
            }

            const isTrial = !access.hasAccess;
            
            if (hasAccess && !isTrial) {
                const existingSession = await this.getUserActiveSession(userId);
                if (existingSession && existingSession.status === 'connected') {
                    log.info(`🔄 Session existante réutilisée pour ${userId} (${isTrial ? 'Essai' : 'Payant'})`);
                    await this.updateSessionActivity(existingSession.session_id);
                    
                    return {
                        sessionId: existingSession.session_id,
                        method: existingSession.connection_method || 'qr',
                        existing: true,
                        persistent: !isTrial,
                        isTrial: isTrial
                    };
                }
            }

            if (method === 'pairing') {
                log.info(`🔐 Création session pairing pour ${userId} (${isTrial ? 'Essai' : 'Payant'})`);
                return await this.pairingManager.initializePairing(userId, userData);
            } else {
                log.info(`📱 Création session QR pour ${userId} (${isTrial ? 'Essai' : 'Payant'})`);
                return await this.createQRSession(userId, userData, !isTrial);
            }
            
        } catch (error) {
            log.error('❌ Erreur création session:', error);
            throw error;
        }
    }

    async createSessionWithPhone(userId, userData, method, phoneNumber) {
        try {
            const access = await this.authManager.checkUserAccess(userId);
            const trial = await this.trialManager.checkTrialAccess(userId);
            
            const hasAccess = access.hasAccess || trial.hasTrial;
            
            if (!hasAccess) {
                const newTrial = await this.trialManager.createTrialSession(userId, userData);
                if (!newTrial.success) {
                    throw new Error(`Accès refusé. ${newTrial.error}`);
                }
            }

            const isTrial = !access.hasAccess;
            
            if (method === 'pairing' && phoneNumber) {
                log.info(`🔐 Tentative de connexion pairing pour ${userId} avec ${phoneNumber}`);
                
                // VALIDATION CORRIGÉE : 8-15 chiffres
                const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                if (!cleanNumber || cleanNumber.length < 8 || cleanNumber.length > 15) {
                    throw new Error(`Numéro invalide: ${cleanNumber.length} chiffres (attendu: 8-15 chiffres)`);
                }
                
                // 🔒 Le numéro est passé mais ne sera pas sauvegardé
                const result = await this.pairingManager.initializePairing(userId, userData, cleanNumber);
                
                if (result.success) {
                    return result;
                } else {
                    throw new Error('Échec du processus pairing');
                }
            } else {
                throw new Error('Méthode ou numéro invalide');
            }
            
        } catch (error) {
            log.error('❌ Erreur création session avec phone:', error);
            
            // Informer l'utilisateur de l'échec
            await this.sendMessage(userId,
                `❌ *Échec de la connexion pairing*\n\n` +
                `Erreur: ${error.message}\n\n` +
                `Vous pouvez:\n` +
                `• Vérifier votre numéro et réessayer\n` +
                `• Utiliser la méthode QR Code\n` +
                `• Contacter le support si le problème persiste`
            );
            
            throw error;
        }
    }

    async createQRSession(userId, userData, isPayedUser = false) {
        try {
            await this.sendMessage(userId, "🔄 Création de votre session WhatsApp...");

            const sessionId = `qr_${userId}_${Date.now()}`;
            const authDir = `./sessions/${sessionId}`;

            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            
            // CONFIGURATION AMÉLIORÉE - Timeouts augmentés
            const sock = makeWASocket({
                auth: state,
                logger: P({ level: "silent" }),
                browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
                printQRInTerminal: false,
                syncFullHistory: false,
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: true,
                emitOwnEvents: true,
                defaultQueryTimeoutMs: 180000, // Augmenté à 2 minutes
                connectTimeoutMs: 450000, // Augmenté à 2 minutes
                keepAliveIntervalMs: 30000, // Ping toutes les 30 secondes
                maxRetries: 5, // Plus de tentatives
                retryDelayMs: 5000, // Délai entre les tentatives
                fireInitQueries: true,
                mobile: false
            });

            this.sessions.set(sessionId, {
                socket: sock,
                userId: userId,
                userData: userData,
                authDir: authDir,
                saveCreds: saveCreds,
                status: 'connecting',
                subscriptionActive: isPayedUser,
                connectionMethod: 'qr',
                createdAt: new Date(),
                lastActivity: new Date(),
                qrGenerated: false
            });

            await this.supabase
                .from('whatsapp_sessions')
                .insert([{
                    session_id: sessionId,
                    user_id: userId,
                    user_data: userData,
                    status: 'connecting',
                    subscription_active: isPayedUser,
                    connection_method: 'qr',
                    created_at: new Date().toISOString(),
                    last_activity: new Date().toISOString()
                }]);

            this.setupSocketEvents(sock, sessionId, userId);
            
            return { 
                sessionId: sessionId, 
                method: 'qr',
                persistent: isPayedUser
            };
        } catch (error) {
            log.error('❌ Erreur création session QR:', error);
            throw error;
        }
    }

    setupSocketEvents(sock, sessionId, userId) {
        let qrTimeout;
        let connectionTimeout;

        sock.ev.on("connection.update", async (update) => {
            const { connection, qr, lastDisconnect, isNewLogin, isOnline } = update;

            log.info(`🔌 [WHATSAPP] ${userId} - Connection update:`, {
                connection,
                hasQR: !!qr,
                isNewLogin,
                isOnline
            });

            // Nettoyer les timeouts précédents
            if (qrTimeout) clearTimeout(qrTimeout);
            if (connectionTimeout) clearTimeout(connectionTimeout);

            if (qr) {
                log.info(`📱 QR généré pour ${userId} (${qr.length} caractères)`);
                await this.updateSessionStatus(sessionId, 'qr_generated', { qr_code: qr });
                
                const session = this.sessions.get(sessionId);
                if (session) {
                    session.qrGenerated = true;
                    session.qrTimestamp = Date.now();
                }

                // Timeout QR augmenté à 5 minutes
                qrTimeout = setTimeout(async () => {
                    const session = this.sessions.get(sessionId);
                    if (session && session.status === 'qr_generated') {
                        log.warn(`⏰ QR Timeout pour ${userId}`);
                        await this.sendMessage(userId, 
                            "⏰ *QR Code expiré*\n\n" +
                            "Le QR code a expiré après 5 minutes.\n\n" +
                            "Veuillez:\n" +
                            "• Redémarrer la connexion avec /connect\n" +
                            "• Scanner le nouveau QR code rapidement\n" +
                            "• Utiliser la méthode Pairing Code si le problème persiste"
                        );
                        await this.disconnectSession(sessionId);
                    }
                }, 300000); // 5 minutes

                // Utiliser la nouvelle méthode d'envoi QR via pont HTTP
                await this.sendQRCode(userId, qr, sessionId);
            }

            if (connection === "open") {
                log.success(`✅ Session connectée: ${userId}`);
                await this.handleConnectionSuccess(sock, sessionId, userId);
            }

            if (connection === "close") {
                log.warn(`🔌 Connexion fermée pour ${userId}:`, lastDisconnect?.error?.message);
                await this.handleConnectionClose(sessionId, lastDisconnect);
            }
            
            if (isNewLogin) {
                log.info(`🔄 Nouvelle connexion détectée pour ${userId}`);
            }

            // Timeout de connexion général augmenté à 10 minutes
            if (connection === "connecting" && !qr) {
                connectionTimeout = setTimeout(async () => {
                    const session = this.sessions.get(sessionId);
                    if (session && session.status !== 'connected') {
                        log.warn(`⏰ Connexion timeout pour ${userId}`);
                        await this.sendMessage(userId,
                            "⏰ *Timeout de connexion*\n\n" +
                            "La connexion a pris trop de temps.\n\n" +
                            "Causes possibles:\n" +
                            "• Problème réseau\n" +
                            "• Serveurs WhatsApp surchargés\n" +
                            "• Blocage temporaire\n\n" +
                            "Veuillez réessayer dans 2-3 minutes."
                        );
                        await this.disconnectSession(sessionId);
                    }
                }, 600000); // 10 minutes
            }
        });

        sock.ev.on("creds.update", async (creds) => {
            log.info(`🔑 Mise à jour credentials pour ${userId}`);
            const session = this.sessions.get(sessionId);
            if (session) {
                await session.saveCreds();
                await this.updateSessionActivity(sessionId);
            }
        });

        sock.ev.on("messages.upsert", async (m) => {
            log.info(`📨 Message reçu pour ${userId}: ${m.messages?.length} messages`);
            await this.handleIncomingMessage(m, sessionId);
        });

        sock.ev.on("messages.update", async (updates) => {
            await this.updateSessionActivity(sessionId);
        });

        sock.ev.on("contacts.update", async (updates) => {
            await this.updateSessionActivity(sessionId);
        });
    }

    async handleConnectionSuccess(sock, sessionId, userId) {
        try {
            const user = sock.user;
            const session = this.sessions.get(sessionId);
            
            if (!session) {
                log.error(`❌ Session non trouvée: ${sessionId}`);
                return;
            }

            await this.updateSessionStatus(sessionId, 'connected', { 
                user_id: user.id,
                user_name: user.name,
                connected_at: new Date().toISOString()
            });

            let message = `✅ *Connexion WhatsApp Réussie!*\\n\\n`;
            message += `Utilisateur: ${user.name || user.id}\\n`;
            message += `Méthode: ${session.connectionMethod === 'pairing' ? 'Code Pairing' : 'QR Code'}\\n`;
            
            if (session.subscriptionActive) {
                const access = await this.authManager.checkUserAccess(userId);
                message += `💎 *Abonnement ${access.plan}* - ${access.daysLeft} jours restants\\n`;
                message += `\\n🔐 *SESSION PERMANENTE* - Reste active jusqu'au ${access.endDate}`;
            }
            
            message += `\\n\\nVous pouvez maintenant utiliser le bot!`;

            await this.sendMessage(userId, message);
            log.success(`✅ Message de connexion envoyé à ${userId}`);

            log.success(`🎯 Session ${sessionId} complètement initialisée`);

        } catch (error) {
            log.error('❌ Erreur connexion réussie:', error);
        }
    }

    async handleIncomingMessage(m, sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && m.messages) {
            await this.updateSessionActivity(sessionId);
            
            for (const message of m.messages) {
                if (!message.key.fromMe) {
                    await this.handleWhatsAppMessage(message, sessionId);
                }
            }
        }
    }

    async handleWhatsAppMessage(message, sessionId) {
        try {
            const session = this.sessions.get(sessionId);
            if (!session) return;

            const text = message.message?.conversation || 
                        message.message?.extendedTextMessage?.text || '';
            const sender = message.key.remoteJid;
            const userSettings = this.getUserSetting(session.userId);
            
            if (userSettings.private_mode) {
                const allowedUsers = userSettings.allowed_users || [];
                const senderNumber = sender.split('@')[0];
                
                if (!allowedUsers.includes(senderNumber) && !allowedUsers.includes('all')) {
                    if (userSettings.silent_mode) {
                        return;
                    } else {
                        await session.socket.sendMessage(sender, {
                            text: "❌ *Accès refusé*\n\nVous n'êtes pas autorisé à utiliser ce bot.\n\nContactez le propriétaire pour obtenir l'accès."
                        });
                    }
                    return;
                }
            }

            if (text.startsWith('!')) {
                await this.handleWhatsAppCommand(text, message, sessionId, userSettings);
            }

        } catch (error) {
            log.error('❌ Erreur traitement message WhatsApp:', error);
        }
    }

    async handleWhatsAppCommand(commandText, message, sessionId, userSettings) {
        const session = this.sessions.get(sessionId);
        const sender = message.key.remoteJid;
        
        try {
            const args = commandText.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            
            if (command === 'silent') {
                await this.handleSilentCommand(args, sender, session, userSettings);
                return;
            }
            
            if (command === 'private') {
                await this.handlePrivateCommand(args, sender, session, userSettings);
                return;
            }
            
            if (command === 'settings') {
                await this.handleSettingsCommand(sender, session, userSettings);
                return;
            }
            
            if (command === 'help') {
                await this.handleHelpCommand(sender, session, userSettings);
                return;
            }

            await this.executeWhatsAppCommand(command, args, message, sessionId, userSettings);
            
        } catch (error) {
            log.error('❌ Erreur commande WhatsApp:', error);
        }
    }

    async handleSilentCommand(args, sender, session, userSettings) {
        const newSilentMode = !userSettings.silent_mode;
        
        await this.saveUserSetting(session.userId, {
            silent_mode: newSilentMode
        });
        
        const responseText = newSilentMode ?
            "🔇 *Mode silencieux activé*\n\nToutes les commandes sont maintenant invisibles pour les autres.\nSeul vous verrez les résultats." :
            "🔊 *Mode silencieux désactivé*\n\nLes commandes sont maintenant visibles par tous.";
            
        await this.sendMessageWithMode(sender, session, responseText, userSettings);
    }

    async handlePrivateCommand(args, sender, session, userSettings) {
        const newPrivateMode = !userSettings.private_mode;
        let responseText = "";
        
        if (newPrivateMode && args.length > 0) {
            const users = args.map(u => u.replace('+', '').replace(/\D/g, ''));
            await this.saveUserSetting(session.userId, {
                private_mode: true,
                allowed_users: users
            });
            responseText = `🔒 *Mode privé activé*\n\nUtilisateurs autorisés: ${users.join(', ')}\n\nSeules ces personnes peuvent utiliser le bot.`;
        } else if (newPrivateMode) {
            await this.saveUserSetting(session.userId, {
                private_mode: true,
                allowed_users: ['all']
            });
            responseText = "🔒 *Mode privé activé*\n\nTout le monde peut utiliser le bot pour le moment.\nUtilisez `!private +237612345678 +237698765432` pour restreindre à des numéros spécifiques.";
        } else {
            await this.saveUserSetting(session.userId, {
                private_mode: false,
                allowed_users: []
            });
            responseText = "🔓 *Mode privé désactivé*\n\nTout le monde peut maintenant utiliser le bot.";
        }
        
        await this.sendMessageWithMode(sender, session, responseText, userSettings);
    }

    async handleSettingsCommand(sender, session, userSettings) {
        const settingsText = `⚙️ *Paramètres de votre bot*

🔇 Mode silencieux: ${userSettings.silent_mode ? '✅ Activé' : '❌ Désactivé'}
🔒 Mode privé: ${userSettings.private_mode ? '✅ Activé' : '❌ Désactivé'}

${userSettings.private_mode ? `👥 Utilisateurs autorisés: ${userSettings.allowed_users?.join(', ') || 'Tout le monde'}` : ''}

*Commandes disponibles:*
!silent - Activer/désactiver le mode silencieux
!private - Gérer l'accès au bot
!private +237612345678 - Autoriser un numéro spécifique
!private all - Autoriser tout le monde
!settings - Voir ces paramètres
!help - Voir toutes les commandes`;

        await this.sendMessageWithMode(sender, session, settingsText, userSettings);
    }

    async handleHelpCommand(sender, session, userSettings) {
        const helpText = `🤖 *Commandes NOVA-MD WhatsApp*

⚙️ *Commandes de configuration:*
!silent - Rendre les commandes invisibles
!private - Contrôler qui peut utiliser le bot
!settings - Voir les paramètres
!help - Afficher cette aide

📊 *Commandes d'information:*
!status - Statut de votre session
!info - Informations du bot

🔧 *Commandes utilitaires:*
!ping - Tester la connexion
!time - Heure actuelle

*Astuce:* Utilisez \`!silent\` pour que seul vous voyez les réponses.`;

        await this.sendMessageWithMode(sender, session, helpText, userSettings);
    }

    async executeWhatsAppCommand(command, args, message, sessionId, userSettings) {
        const session = this.sessions.get(sessionId);
        const sender = message.key.remoteJid;
        
        switch (command) {
            case 'status':
                const statusText = `📊 *Statut de votre session*

🔐 Type: ${session.subscriptionActive ? 'Session permanente' : 'Session essai'}
📱 Connecté depuis: ${Math.round((Date.now() - session.createdAt) / (1000 * 60 * 60 * 24))} jours
⚙️ Mode silencieux: ${userSettings.silent_mode ? '✅ Activé' : '❌ Désactivé'}
🔒 Accès restreint: ${userSettings.private_mode ? '✅ Activé' : '❌ Désactivé'}

💡 Utilisez \`!settings\` pour modifier les paramètres.`;
                await this.sendMessageWithMode(sender, session, statusText, userSettings);
                break;
                
            case 'info':
                const infoText = `🤖 *NOVA-MD Premium*

Version: ${config.bot.version}
Sessions: ✅ Persistantes
Support: ${config.bot.support_contact}

*Fonctionnalités:*
• Sessions WhatsApp permanentes
• Mode silencieux
• Contrôle d'accès
• Commandes audio avancées
• Support 24/7`;
                await this.sendMessageWithMode(sender, session, infoText, userSettings);
                break;
                
            case 'ping':
                const start = Date.now();
                await this.sendMessageWithMode(sender, session, "🏓 *Pong!*", userSettings);
                const latency = Date.now() - start;
                await this.sendMessageWithMode(sender, session, `🏓 *Pong!*\nLatence: ${latency}ms`, userSettings);
                break;
                
            case 'time':
                const now = new Date();
                const timeText = `🕐 *Heure actuelle*

Date: ${now.toLocaleDateString('fr-FR')}
Heure: ${now.toLocaleTimeString('fr-FR')}
Fuseau: UTC+1 (Afrique/Douala)`;
                await this.sendMessageWithMode(sender, session, timeText, userSettings);
                break;
                
            default:
                if (!userSettings.silent_mode) {
                    await session.socket.sendMessage(sender, {
                        text: "❌ *Commande inconnue*\n\nUtilisez `!help` pour voir les commandes disponibles."
                    });
                }
                break;
        }
    }

    async sendMessageWithMode(sender, session, text, userSettings) {
        try {
            if (userSettings.silent_mode) {
                await session.socket.sendMessage(sender, { text: text });
            } else {
                await session.socket.sendMessage(sender, { text: text });
            }
        } catch (error) {
            log.error('❌ Erreur envoi message WhatsApp:', error);
        }
    }

    // =========================================================================
    // MÉTHODES PONT HTTP - Communication avec Telegram via API
    // =========================================================================

    async sendQRCode(userId, qrCode, sessionId) {
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

    async sendPairingCode(userId, pairingCode, phoneNumber) {
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

    async sendMessage(userId, message) {
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

    // =========================================================================
    // Méthodes de gestion des sessions
    // =========================================================================

    async updateSessionStatus(sessionId, status, data = {}) {
        try {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.status = status;
                session.lastActivity = new Date();
            }

            const updateData = {
                status: status,
                updated_at: new Date().toISOString(),
                last_activity: new Date().toISOString(),
                ...data
            };

            await this.supabase
                .from('whatsapp_sessions')
                .update(updateData)
                .eq('session_id', sessionId);

        } catch (error) {
            log.error('❌ Erreur mise à jour statut:', error);
        }
    }

    async updateSessionActivity(sessionId) {
        try {
            const session = this.sessions.get(sessionId);
            if (session) {
                session.lastActivity = new Date();
            }

            await this.supabase
                .from('whatsapp_sessions')
                .update({ 
                    last_activity: new Date().toISOString()
                })
                .eq('session_id', sessionId);

        } catch (error) {
            log.error('❌ Erreur mise à jour activité session:', error);
        }
    }

    async handleConnectionClose(sessionId, lastDisconnect) {
        try {
            const session = this.sessions.get(sessionId);
            const reason = lastDisconnect?.error;
            
            const disconnectData = {
                status: 'disconnected',
                disconnected_at: new Date().toISOString(),
                disconnect_reason: reason?.message || 'Unknown'
            };

            if (reason?.output?.statusCode === 401 && session?.subscriptionActive) {
                log.warn(`🔌 Session expirée pour utilisateur payant: ${sessionId}`);
                disconnectData.disconnect_reason = 'Session expired - Will attempt reconnect';
                
                setTimeout(() => {
                    this.attemptReconnect(sessionId, session);
                }, 5000);
            }

            await this.updateSessionStatus(sessionId, 'disconnected', disconnectData);
            
            if (session) {
                let message = '❌ *Déconnexion WhatsApp*\n\n';
                
                if (reason?.output?.statusCode === 401) {
                    if (session.subscriptionActive) {
                        message += 'Session expirée. Reconnexion automatique en cours...';
                    } else {
                        message += 'Session essai expirée. Utilisez /connect pour vous reconnecter.';
                    }
                } else {
                    message += 'Problème de connexion. ';
                    if (session.subscriptionActive) {
                        message += 'Reconnexion automatique en cours...';
                    } else {
                        message += 'Réessayez avec /connect.';
                    }
                }

                try {
                    await this.sendMessage(session.userId, message);
                } catch (error) {
                    log.error(`❌ Erreur envoi message déconnexion à ${session.userId}:`, error);
                }
            }

            if (!session?.subscriptionActive) {
                this.sessions.delete(sessionId);
            }

            log.info(`🔌 Session déconnectée: ${sessionId} - ${disconnectData.disconnect_reason}`);

        } catch (error) {
            log.error('❌ Erreur gestion déconnexion:', error);
        }
    }

    async attemptReconnect(sessionId, session) {
        try {
            log.info(`🔄 Tentative de reconnexion pour ${sessionId}`);
            
            try {
                await this.sendMessage(
                    session.userId,
                    "🔄 *Reconnexion automatique en cours...*"
                );
            } catch (error) {
                log.error(`❌ Erreur envoi message reconnexion à ${session.userId}:`, error);
            }

            await this.createSession(session.userId, session.userData, session.connectionMethod);
            
        } catch (error) {
            log.error(`❌ Échec reconnexion ${sessionId}:`, error);
            
            try {
                await this.sendMessage(
                    session.userId,
                    "❌ *Échec reconnexion automatique*\n\nUtilisez /connect pour vous reconnecter manuellement."
                );
            } catch (error) {
                log.error(`❌ Erreur envoi message échec reconnexion à ${session.userId}:`, error);
            }
        }
    }

    async disconnectSession(sessionId) {
        try {
            const session = this.sessions.get(sessionId);
            if (session && session.socket) {
                await session.socket.logout();
                await session.socket.end();
            }
            
            await this.updateSessionStatus(sessionId, 'disconnected', {
                disconnected_at: new Date().toISOString(),
                disconnect_reason: 'manual'
            });
            
            this.sessions.delete(sessionId);
            
            log.info(`🔌 Session déconnectée manuellement: ${sessionId}`);
        } catch (error) {
            log.error('❌ Erreur déconnexion session:', error);
        }
    }

    async getUserSession(userId) {
        try {
            const { data, error } = await this.supabase
                .from('whatsapp_sessions')
                .select('*')
                .eq('user_id', userId)
                .eq('status', 'connected')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            return data;
        } catch (error) {
            return null;
        }
    }

    async getUserActiveSession(userId) {
        try {
            const { data, error } = await this.supabase
                .from('whatsapp_sessions')
                .select('*')
                .eq('user_id', userId)
                .eq('status', 'connected')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            return data;
        } catch (error) {
            return null;
        }
    }

    async getActiveSessions() {
        try {
            const { data, error } = await this.supabase
                .from('whatsapp_sessions')
                .select('*')
                .eq('status', 'connected');

            return data || [];
        } catch (error) {
            return [];
        }
    }

    getActiveSessionsCount() {
        let connectedCount = 0;
        for (const [sessionId, sessionData] of this.sessions) {
            if (sessionData.status === 'connected') {
                connectedCount++;
            }
        }
        return connectedCount;
    }

    getSessionsHealth() {
        const health = {
            total: this.sessions.size,
            connected: 0,
            connecting: 0,
            disconnected: 0,
            healthySessions: []
        };

        for (const [sessionId, sessionData] of this.sessions) {
            health[sessionData.status]++;
            
            if (sessionData.status === 'connected') {
                health.healthySessions.push({
                    sessionId,
                    userId: sessionData.userId,
                    connectionMethod: sessionData.connectionMethod,
                    subscriptionActive: sessionData.subscriptionActive,
                    lastActivity: sessionData.lastActivity
                });
            }
        }

        return health;
    }

    async getSessionStats() {
        try {
            const { data: totalSessions, error: error1 } = await this.supabase
                .from('whatsapp_sessions')
                .select('id');

            const { data: connectedSessions, error: error2 } = await this.supabase
                .from('whatsapp_sessions')
                .select('id, subscription_active, created_at')
                .eq('status', 'connected');

            const { data: payedSessions, error: error3 } = await this.supabase
                .from('whatsapp_sessions')
                .select('id')
                .eq('status', 'connected')
                .eq('subscription_active', true);

            if (error1 || error2 || error3) {
                throw error1 || error2 || error3;
            }

            const persistentSessions = connectedSessions.filter(session => {
                if (!session.subscription_active) return false;
                const createdAt = new Date(session.created_at);
                const now = new Date();
                const hoursConnected = (now - createdAt) / (1000 * 60 * 60);
                return hoursConnected > 24;
            });

            return {
                total: totalSessions.length,
                connected: connectedSessions.length,
                payedActive: payedSessions.length,
                persistentSessions: persistentSessions.length,
                averageSessionHours: this.calculateAverageSessionHours(connectedSessions)
            };

        } catch (error) {
            log.error('❌ Erreur statistiques sessions:', error);
            return null;
        }
    }

    calculateAverageSessionHours(sessions) {
        if (!sessions || sessions.length === 0) return 0;
        
        const now = new Date();
        const totalHours = sessions.reduce((sum, session) => {
            const createdAt = new Date(session.created_at);
            const hours = (now - createdAt) / (1000 * 60 * 60);
            return sum + hours;
        }, 0);
        
        return Math.round(totalHours / sessions.length);
    }

    setupSessionMaintenance() {
        setInterval(() => {
            this.checkSessionsActivity();
        }, config.sessions.activityCheckInterval);

        setInterval(() => {
            this.maintainPayedSessions();
            this.cleanupExpiredTrialSessions();
        }, config.sessions.cleanupInterval);

        log.success('✅ Maintenance des sessions configurée');
    }

    async checkSessionsActivity() {
        try {
            const activeSessions = await this.getActiveSessions();
            const now = new Date();
            
            for (const session of activeSessions) {
                const lastActivity = new Date(session.last_activity);
                const minutesInactive = (now - lastActivity) / (1000 * 60);
                
                if (session.is_trial && minutesInactive > 30) {
                    log.info(`🧹 Nettoyage session essai inactive: ${session.session_id}`);
                    await this.disconnectSession(session.session_id);
                }
                
                if (session.subscription_active) {
                    await this.updateSessionActivity(session.session_id);
                }
            }
        } catch (error) {
            log.error('❌ Erreur vérification activité sessions:', error);
        }
    }

    async cleanupExpiredTrialSessions() {
        try {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            
            const { data, error } = await this.supabase
                .from('whatsapp_sessions')
                .update({ 
                    status: 'expired',
                    disconnected_at: new Date().toISOString()
                })
                .eq('status', 'connected')
                .eq('subscription_active', false)
                .lt('created_at', twentyFourHoursAgo)
                .select();

            if (data && data.length > 0) {
                log.info(`🧹 ${data.length} sessions essai expirées nettoyées`);
                
                for (const session of data) {
                    await this.disconnectSession(session.session_id);
                }
            }

            return data?.length || 0;
        } catch (error) {
            log.error('❌ Erreur nettoyage sessions essai:', error);
            return 0;
        }
    }

    async maintainPayedSessions() {
        try {
            const { data: activeSubs, error } = await this.supabase
                .from('subscriptions')
                .select('user_id')
                .eq('status', 'active')
                .gt('end_date', new Date().toISOString());

            if (activeSubs && activeSubs.length > 0) {
                const userIds = activeSubs.map(sub => sub.user_id);
                
                await this.supabase
                    .from('whatsapp_sessions')
                    .update({ 
                        subscription_active: true,
                        updated_at: new Date().toISOString()
                    })
                    .in('user_id', userIds)
                    .eq('status', 'connected');

                log.info(`✅ ${userIds.length} sessions payantes maintenues actives`);
            }

            const { data: expiredSubs, error: error2 } = await this.supabase
                .from('subscriptions')
                .select('user_id')
                .eq('status', 'active')
                .lt('end_date', new Date().toISOString());

            if (expiredSubs && expiredSubs.length > 0) {
                const expiredUserIds = expiredSubs.map(sub => sub.user_id);
                
                await this.supabase
                    .from('whatsapp_sessions')
                    .update({ 
                        subscription_active: false,
                        status: 'subscription_expired',
                        updated_at: new Date().toISOString()
                    })
                    .in('user_id', expiredUserIds)
                    .eq('status', 'connected')
                    .eq('subscription_active', true);

                log.warn(`⚠️  ${expiredUserIds.length} sessions marquées comme abonnement expiré`);
            }

        } catch (error) {
            log.error('❌ Erreur maintenance sessions payantes:', error);
        }
    }

    preserveSessionsForUpdate() {
        const preservedSessions = [];
        
        for (const [sessionId, sessionData] of this.sessions) {
            if (sessionData.status === 'connected') {
                preservedSessions.push({
                    sessionId,
                    userId: sessionData.userId,
                    userData: sessionData.userData,
                    authDir: sessionData.authDir,
                    subscriptionActive: sessionData.subscriptionActive,
                    connectionMethod: sessionData.connectionMethod
                });
            }
        }
        
        log.info(`💾 ${preservedSessions.length} sessions préservées pour mise à jour`);
        return preservedSessions;
    }

    async verifyPostUpdateIntegrity() {
        const issues = [];
        let healthyCount = 0;

        for (const [sessionId, sessionData] of this.sessions) {
            const health = await this.checkSessionHealth(sessionId);
            if (health.healthy) {
                healthyCount++;
            } else {
                issues.push({
                    sessionId,
                    userId: sessionData.userId,
                    issue: health.reason
                });
            }
        }

        return {
            totalSessions: this.sessions.size,
            healthySessions: healthyCount,
            issues: issues,
            healthPercentage: (healthyCount / this.sessions.size * 100).toFixed(1)
        };
    }

    async checkSessionHealth(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { healthy: false, reason: 'Session non trouvée' };
        }

        try {
            if (session.socket && session.socket.user) {
                return { 
                    healthy: true, 
                    user: session.socket.user,
                    lastActivity: session.lastActivity,
                    uptime: Date.now() - session.createdAt.getTime()
                };
            } else {
                return { healthy: false, reason: 'Socket non actif' };
            }
        } catch (error) {
            return { healthy: false, reason: 'Erreur vérification santé' };
        }
    }
}

module.exports = SessionManager;
