const log = require('../utils/logger')(module);

module.exports = {
    name: 'settings',
    description: "Afficher les paramètres actuels du bot",
    category: 'configuration',
    aliases: ['parametres', 'config', 'options'],
    
    run: async (context) => {
        try {
            const { sock, msg, sessionManager, replyWithTag } = context;
            
            if (!sock || !sock.user) {
                log.error('[SETTINGS] Socket non initialisée');
                return;
            }

            const remoteJid = msg.key.remoteJid;

            // Trouver la session correspondante
            const session = Array.from(sessionManager.sessions.values())
                .find(s => s.socket === sock);
                
            if (!session) {
                log.error('[SETTINGS] Session non trouvée');
                await replyWithTag(sock, remoteJid, msg, "❌ Session non trouvée.");
                return;
            }

            // Récupérer les paramètres
            const userSettings = sessionManager.getUserSetting(session.userId);

            const settingsText = `⚙️ *PARAMÈTRES NOVA-MD*

🔇 *Mode Silencieux:* ${userSettings.silent_mode ? '✅ ACTIVÉ' : '❌ Désactivé'}
${userSettings.silent_mode ? 
    '• Seul vous voyez les réponses\n• Commandes invisibles pour les autres' : 
    '• Tout le monde voit les commandes\n• Mode normal'}

🔒 *Mode Privé:* ${userSettings.private_mode ? '✅ ACTIVÉ' : '❌ Désactivé'}
${userSettings.private_mode ? 
    `• Accès restreint\n• Utilisateurs autorisés: ${userSettings.allowed_users?.join(', ') || 'Tout le monde'}` : 
    '• Tout le monde peut utiliser le bot'}

📱 *Session:* ${session.subscriptionActive ? '💎 PERMANENTE' : '⚠️  Essai'}
⏱️ *Connecté depuis:* ${Math.round((Date.now() - session.createdAt) / (1000 * 60 * 60 * 24))} jours

*Commandes de configuration:*
!silent - Mode silencieux
!private - Contrôle d'accès
!help - Aide complète`;

            await replyWithTag(sock, remoteJid, msg, settingsText, userSettings);

            log.info(`[SETTINGS] Paramètres affichés pour ${session.userId}`);

        } catch (error) {
            log.error(`[SETTINGS] Erreur : ${error.message}`);
            try {
                await context.replyWithTag(context.sock, context.msg.key.remoteJid, context.msg, 
                    "❌ Erreur lors de l'affichage des paramètres.");
            } catch (e) {
                log.error(`[SETTINGS] Impossible d'envoyer l'erreur : ${e.message}`);
            }
        }
    }
}; 
