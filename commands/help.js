const log = require('../utils/logger')(module);

module.exports = {
    name: 'help',
    description: "Affiche le menu d'aide du bot NOVA-MD",
    category: 'information',
    aliases: ['aide', 'menu', 'commands'],
    
    run: async (context) => {
        try {
            const { sock, msg, commands, sessionManager, replyWithTag } = context;
            
            if (!sock || !sock.user) {
                log.error('[HELP] Socket non initialisée');
                return;
            }

            const BOT_NAME = "NOVA-MD";
            const PREFIX = "!";
            const remoteJid = msg.key.remoteJid;
            const sender = msg.pushName || "Utilisateur";
            
            // Récupérer les paramètres utilisateur pour le mode silencieux
            let userSettings = {};
            if (sessionManager && sessionManager.getUserSetting) {
                const session = Array.from(sessionManager.sessions.values())
                    .find(s => s.socket === sock);
                if (session) {
                    userSettings = sessionManager.getUserSetting(session.userId);
                }
            }

            log.info(`Commande HELP reçue de ${remoteJid} (${sender})`);

            // Vérification des commandes disponibles
            if (!commands || typeof commands !== 'object') {
                log.warn('[HELP] Aucune commande disponible');
                await replyWithTag(sock, remoteJid, msg, "❌ Aucune commande disponible pour le moment.", userSettings);
                return;
            }

            let helpText = `╭───≼ 💠*${BOT_NAME}*💠 ≽───╮\n`;
            helpText += `│\n`;
            helpText += `│  Bonjour *${sender}* 😄\n`;
            helpText += `│  Voici mes commandes disponibles :\n`;
            helpText += `│\n`;

            // Commandes de configuration
            helpText += `│  ⚙️ *CONFIGURATION*\n`;
            const configCommands = Array.from(commands.values())
                .filter(cmd => cmd && cmd.category === 'configuration')
                .sort((a, b) => a.name.localeCompare(b.name));
            
            if (configCommands.length > 0) {
                configCommands.forEach(command => {
                    helpText += `│  ◈ *${PREFIX}${command.name}*\n`;
                    helpText += `│     ↳ _${command.description || 'Pas de description'}_\n`;
                });
            } else {
                helpText += `│  ◈ *${PREFIX}silent*\n│     ↳ _Activer/désactiver le mode silencieux_\n`;
                helpText += `│  ◈ *${PREFIX}private*\n│     ↳ _Contrôler qui peut utiliser le bot_\n`;
                helpText += `│  ◈ *${PREFIX}settings*\n│     ↳ _Voir les paramètres actuels_\n`;
            }

            helpText += `│\n`;

            // Commandes d'information
            helpText += `│  📊 *INFORMATION*\n`;
            const infoCommands = Array.from(commands.values())
                .filter(cmd => cmd && cmd.category === 'information')
                .sort((a, b) => a.name.localeCompare(b.name));
            
            if (infoCommands.length > 0) {
                infoCommands.forEach(command => {
                    helpText += `│  ◈ *${PREFIX}${command.name}*\n`;
                    helpText += `│     ↳ _${command.description || 'Pas de description'}_\n`;
                });
            } else {
                helpText += `│  ◈ *${PREFIX}status*\n│     ↳ _Statut de votre session_\n`;
                helpText += `│  ◈ *${PREFIX}info*\n│     ↳ _Informations du bot_\n`;
            }

            helpText += `│\n`;

            // Commandes utilitaires
            helpText += `│  🔧 *UTILITAIRES*\n`;
            const utilityCommands = Array.from(commands.values())
                .filter(cmd => cmd && cmd.category === 'utility')
                .sort((a, b) => a.name.localeCompare(b.name));
            
            if (utilityCommands.length > 0) {
                utilityCommands.forEach(command => {
                    helpText += `│  ◈ *${PREFIX}${command.name}*\n`;
                    helpText += `│     ↳ _${command.description || 'Pas de description'}_\n`;
                });
            } else {
                helpText += `│  ◈ *${PREFIX}ping*\n│     ↳ _Tester la connexion_\n`;
                helpText += `│  ◈ *${PREFIX}time*\n│     ↳ _Heure actuelle_\n`;
            }

            helpText += `│\n`;

            // Commandes médias
            helpText += `│  🎵 *MÉDIAS*\n`;
            const mediaCommands = Array.from(commands.values())
                .filter(cmd => cmd && cmd.category === 'media')
                .sort((a, b) => a.name.localeCompare(b.name));
            
            if (mediaCommands.length > 0) {
                mediaCommands.forEach(command => {
                    helpText += `│  ◈ *${PREFIX}${command.name}*\n`;
                    helpText += `│     ↳ _${command.description || 'Pas de description'}_\n`;
                });
            } else {
                helpText += `│  ◈ *${PREFIX}play*\n│     ↳ _Lire de la musique_\n`;
                helpText += `│  ◈ *${PREFIX}yt*\n│     ↳ _Télécharger depuis YouTube_\n`;
            }

            helpText += `│\n`;
            helpText += `│  💡 *Astuce:* Utilisez *!silent* pour que\n`;
            helpText += `│  seul vous voyez les réponses aux commandes.\n`;
            helpText += `│\n`;
            helpText += `╰───≼ 💠NOVA-MD PREMIUM💠 ≽───╯`;

            await replyWithTag(sock, remoteJid, msg, helpText, userSettings);
            
        } catch (error) {
            log.error(`[HELP] Erreur lors de l'exécution : ${error.message}`);
            
            // Tentative d'envoi d'un message d'erreur
            try {
                if (context.sock && context.msg.key.remoteJid) {
                    const errorText = "❌ Une erreur s'est produite lors de l'affichage de l'aide.";
                    
                    // Vérifier le mode silencieux pour l'erreur aussi
                    let userSettings = {};
                    if (context.sessionManager && context.sessionManager.getUserSetting) {
                        const session = Array.from(context.sessionManager.sessions.values())
                            .find(s => s.socket === context.sock);
                        if (session) {
                            userSettings = context.sessionManager.getUserSetting(session.userId);
                        }
                    }
                    
                    await context.replyWithTag(context.sock, context.msg.key.remoteJid, context.msg, errorText, userSettings);
                }
            } catch (e) {
                log.error(`[HELP] Impossible d'envoyer le message d'erreur : ${e.message}`);
            }
        }
    }
};
