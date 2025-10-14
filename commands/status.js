const log = require('../utils/logger')(module);

module.exports = {
    name: 'status',
    description: "Statut de la session",
    category: 'information',
    
    run: async (context) => {
        try {
            const { sock, msg, sessionManager } = context;
            const remoteJid = msg.key.remoteJid;
            
            // Trouver la session
            const session = Array.from(sessionManager.sessions.values())
                .find(s => s.socket === sock);
                
            if (session) {
                const statusText = `📊 *Statut de votre session*

🔐 Type: ${session.subscriptionActive ? 'Session permanente' : 'Session essai'}
📱 Connecté depuis: ${Math.round((Date.now() - session.createdAt) / (1000 * 60 * 60 * 24))} jours
👤 Utilisateur ID: ${session.userId}`;
                
                await sock.sendMessage(remoteJid, { text: statusText });
                log.info(`✅ Status command executed for ${session.userId}`);
            } else {
                await sock.sendMessage(remoteJid, { 
                    text: "❌ Session non trouvée" 
                });
            }
            
        } catch (error) {
            log.error(`❌ Erreur commande status: ${error.message}`);
        }
    }
}; 
