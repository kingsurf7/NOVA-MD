const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const SessionManager = require('./core/session-manager');
const AuthManager = require('./core/auth-manager');
const UpdateManager = require('./core/update-manager');
const DynamicCommandManager = require('./core/dynamic-command-manager');
const ResourceManager = require('./core/resource-manager');
const CommandHandler = require('./core/command-handler');
const log = require('./utils/logger')(module);

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
        
        this.setupMiddleware();
        this.setupRoutes();
        this.initialize();
    }

    async initialize() {
        await this.commandHandler.loadBuiltInCommands();
        log.success("🚀 NOVA-MD initialisé avec sessions persistantes");
        
        this.setupBackgroundServices();
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
                
                const result = force ? 
                    await this.updateManager.forceUpdate() : 
                    await this.updateManager.performUpdate();
                    
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

    setTelegramBot(bot) {
        this.sessionManager.setTelegramBot(bot);
    }

    setUpdateManager(updateManager) {
        this.updateManager = updateManager;
    }

    start() {
        this.server = this.app.listen(this.port, () => {
            log.success(`🚀 Serveur NOVA-MD démarré sur le port ${this.port}`);
            log.success(`💎 Bot: ${config.bot.name} v${config.bot.version}`);
            log.success(`🔐 Sessions persistantes: ${config.features.persistentSessions ? 'Activées' : 'Désactivées'}`);
            log.success(`🔄 Mises à jour auto: ${config.features.autoUpdate ? 'Activées' : 'Désactivées'}`);
            log.success(`🔇 Mode silencieux: ${config.features.silentMode ? 'Activé' : 'Désactivé'}`);
        });
    }

    async shutdown() {
        log.info('🛑 Arrêt du serveur NOVA-MD...');
        
        if (this.server) {
            this.server.close();
        }
        
        if (this.updateManager) {
            this.updateManager.stopAutoUpdate();
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