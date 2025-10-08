const fs = require('fs').promises;
const path = require('path');
const log = require('../utils/logger')(module);

class CommandHandler {
    constructor() {
        this.commands = new Map();
        this.aliases = new Map();
        this.commandsPath = path.join(__dirname, '../commands');
    }

    async loadCommands() {
        try {
            try {
                await fs.access(this.commandsPath);
            } catch {
                await fs.mkdir(this.commandsPath, { recursive: true });
                log.info('📁 Dossier commands créé');
            }

            const files = await fs.readdir(this.commandsPath);
            let loadedCount = 0;

            for (const file of files) {
                if (file.endsWith('.js')) {
                    try {
                        const commandPath = path.join(this.commandsPath, file);
                        const command = require(commandPath);
                        
                        if (command.name && command.run) {
                            this.commands.set(command.name, command);
                            loadedCount++;

                            if (command.aliases && Array.isArray(command.aliases)) {
                                command.aliases.forEach(alias => {
                                    this.aliases.set(alias, command.name);
                                });
                            }

                            log.success(`✅ Commande chargée: ${command.name}`);
                        }
                    } catch (error) {
                        log.error(`❌ Erreur chargement commande ${file}:`, error);
                    }
                }
            }

            log.success(`📁 ${loadedCount} commandes chargées avec succès`);
        } catch (error) {
            log.error('❌ Erreur chargement des commandes:', error);
        }
    }

    getCommand(name) {
        const commandName = this.aliases.get(name) || name;
        return this.commands.get(commandName);
    }

    async executeCommand(commandName, context) {
        const command = this.getCommand(commandName);
        
        if (!command) {
            return { success: false, error: 'Commande non trouvée' };
        }

        try {
            await command.run(context);
            return { success: true };
        } catch (error) {
            log.error(`❌ Erreur exécution commande ${commandName}:`, error);
            return { success: false, error: error.message };
        }
    }

    getAllCommands() {
        return Array.from(this.commands.values());
    }

    getCommandsByCategory(category) {
        return this.getAllCommands().filter(cmd => cmd.category === category);
    }

    async reloadCommand(commandName) {
        try {
            const commandPath = path.join(this.commandsPath, `${commandName}.js`);
            
            try {
                await fs.access(commandPath);
            } catch {
                return { success: false, error: 'Fichier commande non trouvé' };
            }
            
            delete require.cache[require.resolve(commandPath)];
            
            const command = require(commandPath);
            
            if (command.name && command.run) {
                this.commands.set(command.name, command);
                
                if (command.aliases) {
                    command.aliases.forEach(alias => {
                        this.aliases.set(alias, command.name);
                    });
                }
                
                log.success(`🔄 Commande rechargée: ${command.name}`);
                return { success: true };
            }
            
            return { success: false, error: 'Commande invalide' };
        } catch (error) {
            log.error(`❌ Erreur rechargement commande ${commandName}:`, error);
            return { success: false, error: error.message };
        }
    }

    async reloadAllCommands() {
        try {
            this.commands.clear();
            this.aliases.clear();
            await this.loadCommands();
            log.success('🔄 Toutes les commandes rechargées');
            return { success: true, count: this.commands.size };
        } catch (error) {
            log.error('❌ Erreur rechargement toutes les commandes:', error);
            return { success: false, error: error.message };
        }
    }

    getBuiltInCommands() {
        return [
            {
                name: 'help',
                description: 'Affiche l aide',
                category: 'general',
                run: async (context) => {
                    const { message, bot } = context;
                    const helpText = `
🤖 *Commandes NOVA-MD Premium*

*Général:*
/start - Démarrer le bot
/help - Afficher cette aide
/status - Statut de votre compte
/connect - Connecter WhatsApp

*Accès:*
/use_code - Utiliser un code d'accès
/subscribe - Informations abonnement

*Admin:*
/admin - Panel administrateur
/generate_code - Générer un code d'accès
/stats - Statistiques

*Session Permanente:*
Votre session WhatsApp reste active avec un abonnement!
Un code = Un utilisateur = Un device WhatsApp
                    `;
                    await bot.sendMessage(message.chat.id, helpText, { parse_mode: 'Markdown' });
                }
            },
            {
                name: 'use_code',
                description: 'Utiliser un code d accès',
                category: 'general',
                run: async (context) => {
                    const { message, bot, authManager } = context;
                    
                    await bot.sendMessage(message.chat.id, 
                        "🔑 *Utilisation d'un code d'accès*\\n\\n" +
                        "Veuillez entrer le code d'accès que vous avez reçu:\\n\\n" +
                        "Format: NOVA-XXXXXXX\\n\\n" +
                        "*Note:* Un code ne peut être utilisé que par un seul utilisateur et un seul device WhatsApp.",
                        { parse_mode: 'Markdown' }
                    );
                    
                    context.userData.waitingForCode = true;
                }
            },
            {
                name: 'subscribe',
                description: 'Informations abonnement',
                category: 'general',
                run: async (context) => {
                    const { message, bot } = context;
                    const subscribeText = `
💎 *Abonnement NOVA-MD Premium*

*Comment s'abonner:*
1. Contactez l'administrateur @Nova_king0
2. Choisissez votre formule
3. Recevez votre code d'accès unique
4. Utilisez /use_code pour l'activer

*Avantages:*
🔐 Session WhatsApp PERMANENTE
📱 1 code = 1 utilisateur = 1 device
⚡ Connexion par QR Code ou Pairing
🛡️ Support prioritaire 24/7

*Formules disponibles:*
• 1 mois - Session permanente 30 jours
• 3 mois - Session permanente 90 jours  
• 6 mois - Session permanente 180 jours
• 1 an - Session permanente 365 jours

*Contact admin:* @Nova_king0
                    `;
                    await bot.sendMessage(message.chat.id, subscribeText, { parse_mode: 'Markdown' });
                }
            },
            {
                name: 'stats',
                description: 'Statistiques du bot',
                category: 'admin',
                run: async (context) => {
                    const { message, bot, authManager, sessionManager } = context;
                    
                    const adminIds = process.env.TELEGRAM_ADMIN_IDS ? 
                        process.env.TELEGRAM_ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
                    
                    if (!adminIds.includes(message.from.id)) {
                        await bot.sendMessage(message.chat.id, '❌ Accès réservé aux administrateurs.');
                        return;
                    }

                    const stats = await authManager.getStats();
                    const sessionStats = await sessionManager.getSessionStats();
                    
                    const statsText = `
📊 *Statistiques NOVA-MD*

*Utilisateurs:*
• Abonnés actifs: ${stats?.activeSubs || 0}
• Codes générés: ${stats?.totalCodes || 0}
• Codes utilisés: ${stats?.usedCodes || 0}

*Sessions:*
• Total: ${sessionStats?.total || 0}
• Connectées: ${sessionStats?.connected || 0}
• Sessions actives: ${sessionStats?.active || 0}
• Sessions permanentes: ${sessionStats?.persistentSessions || 0}

*Plans:*
• Mensuel: ${stats?.plans?.monthly || 0}
• 3 mois: ${stats?.plans?.['3months'] || 0}
• 6 mois: ${stats?.plans?.['6months'] || 0}
• Annuel: ${stats?.plans?.yearly || 0}
• Custom: ${stats?.plans?.custom || 0}
                    `;
                    
                    await bot.sendMessage(message.chat.id, statsText, { parse_mode: 'Markdown' });
                }
            },
            {
                name: 'generate_code',
                description: 'Générer un code d accès',
                category: 'admin',
                run: async (context) => {
                    const { message, bot, authManager } = context;
                    
                    const adminIds = process.env.TELEGRAM_ADMIN_IDS ? 
                        process.env.TELEGRAM_ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
                    
                    if (!adminIds.includes(message.from.id)) {
                        await bot.sendMessage(message.chat.id, '❌ Accès réservé aux administrateurs.');
                        return;
                    }

                    const args = context.args || [];
                    const plan = args[0] || 'monthly';
                    const duration = args[1] ? parseInt(args[1]) : null;

                    await bot.sendMessage(message.chat.id, 
                        `🔄 Génération d'un code ${plan}...`,
                        { parse_mode: 'Markdown' }
                    );

                    const codeResult = await authManager.generateAccessCode(plan, duration, 'telegram_bot');
                    
                    if (codeResult) {
                        const codeText = `
✅ *Code d'accès généré*

🔑 *Code:* \`${codeResult.code}\`
📅 *Plan:* ${plan}
⏱️ *Durée:* ${codeResult.duration} jours
📅 *Expire le:* ${new Date(codeResult.expiresAt).toLocaleDateString('fr-FR')}

*Instructions:*
• Le code est utilisable par UN SEUL utilisateur
• UN SEUL device WhatsApp peut être connecté
• Valable jusqu'à la date d'expiration
                        `;
                        await bot.sendMessage(message.chat.id, codeText, { parse_mode: 'Markdown' });
                    } else {
                        await bot.sendMessage(message.chat.id, '❌ Erreur lors de la génération du code.');
                    }
                }
            },
            {
                name: 'admin',
                description: 'Panel administrateur',
                category: 'admin',
                run: async (context) => {
                    const { message, bot } = context;
                    
                    const adminIds = process.env.TELEGRAM_ADMIN_IDS ? 
                        process.env.TELEGRAM_ADMIN_IDS.split(',').map(id => parseInt(id)) : [];
                    
                    if (!adminIds.includes(message.from.id)) {
                        await bot.sendMessage(message.chat.id, '❌ Accès réservé aux administrateurs.');
                        return;
                    }

                    const adminText = `
👑 *Panel Administrateur NOVA-MD*

*Commandes disponibles:*
/generate_code - Créer un code d'accès
/stats - Statistiques du système
/admin - Ce panel

*Utilisation:*
/generate_code monthly
/generate_code yearly 365
/stats
                    `;
                    
                    await bot.sendMessage(message.chat.id, adminText, { parse_mode: 'Markdown' });
                }
            },
            {
                name: 'status',
                description: 'Statut du compte',
                category: 'general',
                run: async (context) => {
                    const { message, bot, authManager } = context;
                    
                    const access = await authManager.checkUserAccess(message.from.id);
                    
                    if (access.hasAccess) {
                        const statusText = `
✅ *Statut NOVA-MD Premium*

💎 *Abonnement:*
• Plan: ${access.plan || 'N/A'}
• Jours restants: ${access.daysLeft || 0}
• Expire le: ${access.endDate || 'N/A'}

📱 *Fonctionnalités:*
• Session WhatsApp permanente
• Connexion QR Code/Pairing
• Support prioritaire
• Mises à jour automatiques

🔐 Votre session reste active automatiquement!
                        `;
                        await bot.sendMessage(message.chat.id, statusText, { parse_mode: 'Markdown' });
                    } else {
                        const noAccessText = `
❌ *Statut: Accès non activé*

Vous n'avez pas d'abonnement actif.

📋 *Pour obtenir l'accès:*
1. Contactez @Nova_king0
2. Choisissez votre formule
3. Recevez votre code unique
4. Utilisez /use_code pour l'activer

💎 *Formules disponibles:*
• 1 mois - 30 jours
• 3 mois - 90 jours
• 6 mois - 180 jours
• 1 an - 365 jours
                        `;
                        await bot.sendMessage(message.chat.id, noAccessText, { parse_mode: 'Markdown' });
                    }
                }
            },
            {
                name: 'connect',
                description: 'Connecter WhatsApp',
                category: 'general',
                run: async (context) => {
                    const { message, bot, sessionManager } = context;
                    
                    const access = await sessionManager.authManager.checkUserAccess(message.from.id);
                    
                    if (!access.hasAccess) {
                        await bot.sendMessage(message.chat.id,
                            "❌ *Accès requis*\\n\\n" +
                            "Vous devez avoir un abonnement actif pour connecter WhatsApp.\\n\\n" +
                            "Options:\\n" +
                            "• /use_code - Activer un code d'accès\\n" +
                            "• /subscribe - Informations abonnement",
                            { parse_mode: 'Markdown' }
                        );
                        return;
                    }

                    const connectText = `
🔗 *Options de connexion WhatsApp*

Choisissez la méthode de connexion:

📱 *QR Code* - Scannez avec l'appareil photo
🔢 *Pairing Code* - Entrez un code numérique

💡 *Session permanente active jusqu'au ${access.endDate || 'N/A'}*

*Instructions:*
1. Utilisez le bouton approprié
2. Suivez les instructions
3. Votre session restera active
                    `;
                    
                    await bot.sendMessage(message.chat.id, connectText, { parse_mode: 'Markdown' });
                }
            }
        ];
    }

    async loadBuiltInCommands() {
        const builtInCommands = this.getBuiltInCommands();
        
        for (const command of builtInCommands) {
            this.commands.set(command.name, command);
            
            if (command.aliases && Array.isArray(command.aliases)) {
                command.aliases.forEach(alias => {
                    this.aliases.set(alias, command.name);
                });
            }
        }
        
        log.success(`📁 ${builtInCommands.length} commandes intégrées chargées`);
    }
}

module.exports = CommandHandler;
