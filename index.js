const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const SessionManager = require('./core/session-manager');
const AuthManager = require('./core/auth-manager');
const SimpleUpdateManager = require('./core/simple-update-manager');
const DynamicCommandManager = require('./core/dynamic-command-manager');
const ResourceManager = require('./core/resource-manager');
const CommandHandler = require('./core/command-handler');
const log = require('./utils/logger')(module);
const path = require('path');
const fs = require('fs');

class NovaMDApp {
    constructor() {
        this.app = express();
        this.port = config.web.port;
        this.supabase = createClient(config.supabase.url, config.supabase.key);
        this.sessionManager = new SessionManager();
        this.authManager = new AuthManager();
        this.commandManager = new DynamicCommandManager();
        this.resourceManager = new ResourceManager();
        this.commandHandler = new CommandHandler();
        this.botWebhookUrl = process.env.BOT_WEBHOOK_URL || 'http://localhost:3001/webhook';
        this.commands = new Map();
        this.setupMiddleware();
        this.setupRoutes();
        this.initialize();
    }

    // AJOUTER cette méthode pour charger les commandes WhatsApp
	async loadWhatsAppCommands() {
		try {
			const commandsPath = path.join(__dirname, './commands');
			// Vérifier si le dossier existe
			if (!fs.existsSync(commandsPath)) {
				log.warn('📁 Dossier commands non trouvé, création...');
				fs.mkdirSync(commandsPath, { recursive: true });
        		return;
    		}
        
    		const files = fs.readdirSync(commandsPath);
        	let loadedCount = 0;
        
    		for (const file of files) {
        		if (file.endsWith('.js')) {
            		try {
                		const commandPath = path.join(commandsPath, file);
                		const command = require(commandPath);
                    
                		if (command.name && command.run) {
                    		this.commands.set(command.name, command);
                    		loadedCount++;
                    		log.success(`✅ Commande WhatsApp chargée: ${command.name}`);
                		}
            		} catch (error) {
                		log.error(`❌ Erreur chargement commande ${file}:`, error);
                }
        	}
    	}
        
    		log.success(`📁 ${loadedCount} commandes WhatsApp chargées`);
		} catch (error) {
        log.error('❌ Erreur chargement commandes WhatsApp:', error);
		}
	}

	// MODIFIER la méthode initialize
	async initialize() {
		await this.loadWhatsAppCommands(); // AJOUTER cette ligne
        await this.commandHandler.loadBuiltInCommands();
        
        // Tester la connexion avec le bot Python
        await this.testBotConnection();
        
        log.success("🚀 NOVA-MD initialisé avec sessions persistantes");
        
        this.setupBackgroundServices();
    }

    async testBotConnection() {
        try {
            const response = await fetch(`${this.botWebhookUrl.replace('/webhook', '')}/health`);
            if (response.ok) {
                const data = await response.json();
                if (data.status === 'healthy') {
                    log.success('🤖 Bot Telegram connecté via pont HTTP');
                    return true;
                }
            }
        } catch (error) {
            log.warn('⚠️  Bot Telegram non accessible via pont HTTP - utilisation du mode dégradé');
        }
        return false;
    }

    setTelegramBot(bot) {
        log.info('🔄 Configuration du bot Telegram dans SessionManager...');
        this.sessionManager.setTelegramBot(bot);
        this.updateManager = new SimpleUpdateManager(bot, this.sessionManager);
        log.success('✅ Bot Telegram configuré avec succès');
    }

    setupBackgroundServices() {
        setInterval(() => {
            this.sessionManager.maintainPayedSessions();
            this.sessionManager.cleanupExpiredTrialSessions();
        }, config.sessions.cleanupInterval);

        log.success("✅ Services d'arrière-plan démarrés");
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        this.app.use(express.static('public'));
        
        this.app.use((req, res, next) => {
            log.info(`🌐 ${req.method} ${req.path} - ${req.ip}`);
            next();
        });
    }

    setupRoutes() {
        this.app.get('/', (req, res) => {
            const resources = this.resourceManager.getResourceStatus();
            res.json({
                status: 'online',
                name: config.bot.name,
                version: config.bot.version,
                persistentSessions: config.features.persistentSessions,
                resources: resources,
                timestamp: new Date().toISOString()
            });
        });

        this.app.get('/health', async (req, res) => {
            try {
                const resources = this.resourceManager.getResourceStatus();
                const sessionStats = await this.sessionManager.getSessionStats();
                const authStats = await this.authManager.getStats();
                
                res.json({
                    status: 'healthy',
                    app: {
                        name: config.bot.name,
                        version: config.bot.version,
                        uptime: Math.round(process.uptime())
                    },
                    resources: resources,
                    sessions: sessionStats,
                    auth: authStats,
                    features: config.features
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // =========================================================================
        // ROUTES PONT HTTP - Communication avec le bot Python
        // =========================================================================

        this.app.post('/api/bot/send-message', async (req, res) => {
            try {
                const { user_id, message, message_type = 'text' } = req.body;
                
                if (!user_id || !message) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Paramètres manquants: user_id et message requis' 
                    });
                }

                log.info(`📤 [PONT] Envoi message à ${user_id}: ${message.substring(0, 50)}...`);
                
                // Envoyer le message au bot Python via webhook
                const botResult = await this.sendToBotWebhook('send-message', {
                    user_id: user_id,
                    message: message
                });

                if (botResult.success) {
                    log.success(`✅ Message délivré à ${user_id} via bot Telegram`);
                    res.json({ 
                        success: true, 
                        delivered: true,
                        method: 'http_bridge',
                        user_id: user_id,
                        timestamp: new Date().toISOString(),
                        bot_response: botResult
                    });
                } else {
                    log.warn(`⚠️  Message non délivré à ${user_id}, fallback console`);
                    // Fallback: afficher dans la console
                    console.log(`💬 [TELEGRAM-FALLBACK] Message pour ${user_id}: ${message}`);
                    
                    res.json({ 
                        success: true, 
                        delivered: false,
                        method: 'console_fallback',
                        user_id: user_id,
                        timestamp: new Date().toISOString(),
                        note: 'Message affiché dans console (bot non disponible)'
                    });
                }
                
            } catch (error) {
                log.error('❌ Erreur envoi message:', error);
                res.status(500).json({ 
                    success: false, 
                    error: error.message,
                    method: 'error'
                });
            }
        });

        this.app.post('/api/bot/send-qr', async (req, res) => {
            try {
                const { user_id, qr_code, session_id } = req.body;
                
                if (!user_id || !qr_code) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Paramètres manquants: user_id et qr_code requis' 
                    });
                }

                log.info(`📱 [PONT] Envoi QR à ${user_id} (session: ${session_id})`);
                
                // Envoyer le QR au bot Python via webhook
                const botResult = await this.sendToBotWebhook('send-qr', {
                    user_id: user_id,
                    qr_code: qr_code,
                    session_id: session_id
                });

                if (botResult.success) {
                    log.success(`✅ QR délivré à ${user_id} via bot Telegram`);
                    res.json({ 
                        success: true,
                        method: 'http_bridge',
                        user_id: user_id,
                        session_id: session_id,
                        timestamp: new Date().toISOString(),
                        bot_response: botResult
                    });
                } else {
                    log.warn(`⚠️  QR non délivré à ${user_id}, fallback console`);
                    // Fallback: afficher dans la console
                    console.log(`📱 [TELEGRAM-FALLBACK] QR Code pour ${user_id}: ${qr_code}`);
                    
                    res.json({ 
                        success: true, 
                        delivered: false,
                        method: 'console_fallback',
                        user_id: user_id,
                        session_id: session_id,
                        timestamp: new Date().toISOString(),
                        note: 'QR affiché dans console (bot non disponible)'
                    });
                }
                
            } catch (error) {
                log.error('❌ Erreur envoi QR:', error);
                res.status(500).json({ 
                    success: false, 
                    error: error.message,
                    method: 'error'
                });
            }
        });

        this.app.post('/api/bot/send-pairing', async (req, res) => {
            try {
                const { user_id, pairing_code, phone_number } = req.body;
                
                if (!user_id || !pairing_code) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Paramètres manquants: user_id et pairing_code requis' 
                    });
                }

                log.info(`🔐 [PONT] Envoi pairing à ${user_id}: ${pairing_code}`);
                
                // Envoyer le code de pairing au bot Python via webhook
                const botResult = await this.sendToBotWebhook('send-pairing', {
                    user_id: user_id,
                    pairing_code: pairing_code,
                    phone_number: phone_number
                });

                if (botResult.success) {
                    log.success(`✅ Code pairing délivré à ${user_id} via bot Telegram`);
                    res.json({ 
                        success: true,
                        method: 'http_bridge',
                        user_id: user_id,
                        pairing_code: pairing_code,
                        timestamp: new Date().toISOString(),
                        bot_response: botResult
                    });
                } else {
                    log.warn(`⚠️  Code pairing non délivré à ${user_id}, fallback console`);
                    // Fallback: afficher dans la console
                    console.log(`🔐 [TELEGRAM-FALLBACK] Pairing Code pour ${user_id}: ${pairing_code}`);
                    
                    res.json({ 
                        success: true, 
                        delivered: false,
                        method: 'console_fallback',
                        user_id: user_id,
                        pairing_code: pairing_code,
                        timestamp: new Date().toISOString(),
                        note: 'Code pairing affiché dans console (bot non disponible)'
                    });
                }
                
            } catch (error) {
                log.error('❌ Erreur envoi pairing:', error);
                res.status(500).json({ 
                    success: false, 
                    error: error.message,
                    method: 'error'
                });
            }
        });

        this.app.post('/api/bot/connect', async (req, res) => {
            try {
                const { bot_available, methods, webhook_url } = req.body;
                
                if (bot_available) {
                    // Mettre à jour l'URL du webhook si fournie
                    if (webhook_url) {
                        this.botWebhookUrl = webhook_url;
                        log.info(`🌉 URL webhook bot mise à jour: ${webhook_url}`);
                    }
                    
                    log.success('🤖 Bot Telegram connecté via pont HTTP');
                    
                    res.json({ 
                        success: true, 
                        message: 'Bot connecté avec succès',
                        methods_available: methods,
                        bridge: 'http_pont',
                        webhook_url: this.botWebhookUrl,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    res.status(400).json({ 
                        success: false, 
                        error: 'Bot non disponible' 
                    });
                }
            } catch (error) {
                log.error('❌ Erreur connexion bot:', error);
                res.status(500).json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });

        // =========================================================================
        // ROUTES EXISTANTES
        // =========================================================================

        this.app.post('/api/auth/validate-code', async (req, res) => {
            try {
                const { chat_id, code } = req.body;
                const result = await this.authManager.validateAccessCode(code, chat_id);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/auth/access/:userId', async (req, res) => {
            try {
                const access = await this.authManager.checkUserAccess(req.params.userId);
                res.json(access);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/sessions/create', async (req, res) => {
            try {
                const { chat_id, user_name, method = 'qr', persistent = true } = req.body;
                const sessionData = await this.sessionManager.createSession(chat_id, { name: user_name }, method);
                res.json({ ...sessionData, success: true });
            } catch (error) {
                res.status(400).json({ error: error.message });
            }
        });

        this.app.post('/api/sessions/create-with-phone', async (req, res) => {
            try {
                const { chat_id, user_name, method = 'pairing', phone_number, persistent = true } = req.body;
                
                if (!phone_number) {
                    return res.status(400).json({ error: 'Numéro de téléphone requis' });
                }

                // 🔒 Stocker uniquement les données nécessaires, SANS le numéro
                const userData = { 
                    name: user_name
                };
                
                // Passer le numéro uniquement pour le traitement immédiat
                const sessionData = await this.sessionManager.createSessionWithPhone(
                    chat_id, 
                    userData, 
                    method, 
                    phone_number
                );
                
                res.json({ ...sessionData, success: true });
            } catch (error) {
                res.status(400).json({ error: error.message });
            }
        });

        this.app.get('/api/sessions/user/:userId', async (req, res) => {
            try {
                const session = await this.sessionManager.getUserSession(req.params.userId);
                res.json(session || {});
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/sessions/health', async (req, res) => {
            try {
                const health = this.sessionManager.getSessionsHealth();
                res.json(health);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/sessions/integrity', async (req, res) => {
            try {
                const integrity = await this.sessionManager.verifyPostUpdateIntegrity();
                res.json(integrity);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/admin/generate-code', async (req, res) => {
            try {
                const { plan, duration } = req.body;
                const code = await this.authManager.generateAccessCode(plan, duration, 'admin_api');
                res.json(code);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/admin/stats', async (req, res) => {
            try {
                const stats = await this.authManager.getStats();
                const sessionStats = await this.sessionManager.getSessionStats();
                const resourceStats = this.resourceManager.getResourceStatus();
                
                res.json({
                    ...stats,
                    sessionStats,
                    resourceStats,
                    version: config.bot.version,
                    uptime: Math.round(process.uptime()),
                    features: config.features
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/updates/check', async (req, res) => {
            try {
                if (!this.updateManager) {
                    return res.json({ available: false, error: 'Update manager non initialisé' });
                }
                const updateStatus = await this.updateManager.checkForUpdates();
                res.json(updateStatus);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/updates/upgrade', async (req, res) => {
            try {
                const force = req.query.force === 'true';
                
                if (!this.updateManager) {
                    return res.json({ success: false, error: 'Update manager non initialisé' });
                }
                
                const result = await this.updateManager.performUpdate(force);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/updates/simple-update', async (req, res) => {
            try {
                if (!this.updateManager) {
                    return res.json({ success: false, error: 'Update manager non initialisé' });
                }
                
                const result = await this.updateManager.performUpdate();
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/commands/info', async (req, res) => {
            try {
                const stats = this.commandManager.getCommandStats();
                res.json(stats);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/commands/create', async (req, res) => {
            try {
                const commandData = req.body;
                const result = await this.commandManager.createCommand(commandData);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.delete('/api/commands/:name', async (req, res) => {
            try {
                const result = await this.commandManager.deleteCommand(req.params.name);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/user/:userId/whatsapp-settings', async (req, res) => {
            try {
                const settings = this.sessionManager.getUserSetting(req.params.userId);
                res.json(settings);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/user/:userId/whatsapp-settings', async (req, res) => {
            try {
                const result = await this.sessionManager.saveUserSetting(req.params.userId, req.body);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/users/register', async (req, res) => {
            try {
                const { chat_id, name, username } = req.body;
                
                const { error } = await this.supabase
                    .from('telegram_users')
                    .upsert({
                        chat_id: chat_id,
                        first_name: name,
                        username: username,
                        created_at: new Date().toISOString(),
                        last_active: new Date().toISOString()
                    }, {
                        onConflict: 'chat_id'
                    });

                if (error) throw error;
                res.json({ success: true });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/users/active', async (req, res) => {
            try {
                const { data, error } = await this.supabase
                    .from('telegram_users')
                    .select('chat_id, first_name, last_active')
                    .order('last_active', { ascending: false })
                    .limit(50);

                if (error) throw error;
                res.json(data || []);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.use('*', (req, res) => {
            res.status(404).json({ 
                error: 'Route non trouvée',
                path: req.originalUrl
            });
        });

        this.app.use((error, req, res, next) => {
            log.error('❌ Erreur non gérée:', error);
            res.status(500).json({ 
                error: 'Erreur interne du serveur',
                message: error.message
            });
        });
    }

    // =========================================================================
    // MÉTHODES POUR LE PONT HTTP
    // =========================================================================

    async sendToBotWebhook(endpoint, data) {
        try {
            const url = `${this.botWebhookUrl}/${endpoint}`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
                timeout: 10000 // 10 secondes timeout
            });

            if (response.ok) {
                const result = await response.json();
                return result;
            } else {
                log.warn(`⚠️  Réponse non-OK du bot: ${response.status}`);
                return { 
                    success: false, 
                    error: `HTTP ${response.status}`,
                    status: response.status
                };
            }
        } catch (error) {
            log.warn(`⚠️  Impossible de contacter le bot: ${error.message}`);
            return { 
                success: false, 
                error: error.message,
                connection_error: true
            };
        }
    }

    async sendMessageToUser(userId, message) {
        try {
            const result = await this.sendToBotWebhook('send-message', {
                user_id: userId,
                message: message
            });
            
            return result.success || false;
        } catch (error) {
            log.error(`❌ Erreur envoi message à ${userId}:`, error);
            return false;
        }
    }

    async sendQRToUser(userId, qrCode, sessionId) {
        try {
            const result = await this.sendToBotWebhook('send-qr', {
                user_id: userId,
                qr_code: qrCode,
                session_id: sessionId
            });
            
            return result.success || false;
        } catch (error) {
            log.error(`❌ Erreur envoi QR à ${userId}:`, error);
            return false;
        }
    }

    async sendPairingToUser(userId, pairingCode, phoneNumber) {
        try {
            const result = await this.sendToBotWebhook('send-pairing', {
                user_id: userId,
                pairing_code: pairingCode,
                phone_number: phoneNumber
            });
            
            return result.success || false;
        } catch (error) {
            log.error(`❌ Erreur envoi pairing à ${userId}:`, error);
            return false;
        }
    }

    start() {
        this.server = this.app.listen(this.port, () => {
            log.success(`🚀 Serveur NOVA-MD démarré sur le port ${this.port}`);
            log.success(`💎 Bot: ${config.bot.name} v${config.bot.version}`);
            log.success(`🔐 Sessions persistantes: ${config.features.persistentSessions ? 'Activées' : 'Désactivées'}`);
            log.success(`🔄 Mises à jour auto: ${config.features.autoUpdate ? 'Activées' : 'Désactivées'}`);
            log.success(`🔇 Mode silencieux: ${config.features.silentMode ? 'Activé' : 'Désactivé'}`);
            log.success(`🌉 Pont HTTP: ${this.botWebhookUrl}`);
            log.success(`📡 Mode: ${this.botWebhookUrl.includes('localhost') ? 'Développement' : 'Production'}`);
        });
    }

    async shutdown() {
        log.info('🛑 Arrêt du serveur NOVA-MD...');
        
        if (this.server) {
            this.server.close();
        }
        
        const sessions = this.sessionManager.sessions;
        for (const [sessionId] of sessions) {
            await this.sessionManager.disconnectSession(sessionId);
        }
        
        log.success('✅ Serveur arrêté proprement');
    }
}

const app = new NovaMDApp();
app.start();

process.on('SIGINT', async () => {
    await app.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await app.shutdown();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    log.error('❌ Exception non capturée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('❌ Rejet non géré:', reason);
});

module.exports = app;
