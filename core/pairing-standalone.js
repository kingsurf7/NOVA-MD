const { PairingManager } = require('./core/pairing-manager');
const { SessionManager } = require('./core/session-manager');
const { initDatabase } = require('./init-database');
const log = require('./utils/logger')(module);

async function standalonePairing() {
    console.log('🔧 Mode Pairing Autonome - NOVA-MD Premium');
    console.log('==========================================\n');
    
    try {
        // Initialiser la base de données
        await initDatabase();
        log.success('✅ Base de données initialisée');
        
        // Créer les managers
        const sessionManager = new SessionManager();
        const pairingManager = new PairingManager(sessionManager);
        
        // Vérifier que le mode pairing est activé
        if (!pairingManager.isPairingMode) {
            console.log('❌ Utilisez --use-pairing-code pour activer le mode pairing');
            console.log('💡 Commande: node pairing-standalone.js --use-pairing-code');
            process.exit(1);
        }
        
        const userId = 'standalone_' + Date.now();
        const userData = { 
            name: 'Standalone User',
            type: 'pairing_demo'
        };
        
        log.info(`🎯 Démarrage pairing pour l'utilisateur: ${userId}`);
        
        await pairingManager.initializePairing(userId, userData);
        
        // Garder le processus actif
        console.log('\n🔄 Processus pairing en cours...');
        console.log('💡 Le processus restera actif jusqu\'à la connexion ou Ctrl+C\n');
        
        // Gestion propre de l'arrêt
        process.on('SIGINT', async () => {
            console.log('\n🛑 Arrêt du mode pairing...');
            await pairingManager.cleanup();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Erreur pairing autonome:', error);
        process.exit(1);
    }
}

// Script d'aide
function showHelp() {
    console.log(`
🤖 NOVA-MD Premium - Mode Pairing Autonome

Usage:
  node pairing-standalone.js [options]

Options:
  --use-pairing-code    Active le mode pairing (requis)
  --help                Affiche cette aide

Description:
  Ce script permet de tester le mode pairing de manière autonome
  sans avoir à passer par Telegram. Utile pour le développement
  et les tests.

Exemple:
  node pairing-standalone.js --use-pairing-code

⚠️  Attention:
  - Assurez-vous que les variables d'environnement sont configurées
  - La base de données doit être accessible
  - Ce mode est destiné au développement
    `);
}

// Vérifier les arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showHelp();
    process.exit(0);
}

if (require.main === module) {
    standalonePairing();
}

module.exports = { standalonePairing, showHelp };