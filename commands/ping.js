const log = require('../utils/logger')(module);

module.exports = {
    name: 'ping',
    description: "Test de connexion",
    category: 'utility',
    
    run: async (context) => {
        try {
            const { sock, msg } = context;
            const remoteJid = msg.key.remoteJid;
            const start = Date.now();
            
            await sock.sendMessage(remoteJid, { text: "🏓 *Pong!*" });
            const latency = Date.now() - start;
            
            await sock.sendMessage(remoteJid, { 
                text: `🏓 *Pong!*\nLatence: ${latency}ms` 
            });
            
            log.info(`✅ Ping command executed - Latency: ${latency}ms`);
            
        } catch (error) {
            log.error(`❌ Erreur commande ping: ${error.message}`);
        }
    }
};
