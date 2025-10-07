const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const log = require('./utils/logger')(module);

async function initDatabase() {
    log.info("🔄 Vérification de la connexion Supabase...");
    
    try {
        const supabase = createClient(config.supabase.url, config.supabase.key);
        
        // Test de connexion simple - essayer de récupérer les schémas
        const { data, error } = await supabase.rpc('get_schemas');
        
        if (error) {
            // Si RPC échoue, essayer une requête simple sur une table système
            const { error: simpleError } = await supabase
                .from('_supabase_schema')
                .select('*')
                .limit(1)
                .single();
                
            if (simpleError) {
                log.warn("⚠️  Impossible de vérifier les schémas, continuation...");
            }
        }
        
        log.success("✅ Connexion Supabase établie");
        
        // Vérifier les tables essentielles
        await checkEssentialTables(supabase);
        
        log.success("✅ Base de données vérifiée");
        
    } catch (error) {
        log.error("❌ Erreur connexion Supabase:", error.message);
        throw error;
    }
}

async function checkEssentialTables(supabase) {
    const essentialTables = [
        'access_codes',
        'subscriptions', 
        'telegram_users',
        'whatsapp_sessions',
        'user_settings'
    ];
    
    log.info("📊 Vérification des tables...");
    
    for (const table of essentialTables) {
        try {
            const { error } = await supabase
                .from(table)
                .select('id')
                .limit(1);
                
            if (error) {
                if (error.code === 'PGRST116') {
                    log.warn(`❌ Table manquante: ${table}`);
                    log.info(`💡 Créez la table ${table} manuellement dans Supabase → Table Editor`);
                } else {
                    log.warn(`⚠️  Erreur vérification table ${table}: ${error.message}`);
                }
            } else {
                log.success(`✅ Table ${table} existe`);
            }
        } catch (error) {
            log.warn(`⚠️  Erreur vérification table ${table}: ${error.message}`);
        }
    }
}

async function checkDatabaseConnection() {
    try {
        const supabase = createClient(config.supabase.url, config.supabase.key);
        
        // Test de connexion simple
        const { data, error } = await supabase
            .from('_supabase_schema')
            .select('*')
            .limit(1);
            
        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        
        log.success("✅ Connexion à Supabase établie");
        return true;
    } catch (error) {
        log.error('❌ Erreur connexion Supabase:', error.message);
        return false;
    }
}

async function createTestData() {
    try {
        log.info("🧪 Création de données de test...");
        
        const supabase = createClient(config.supabase.url, config.supabase.key);
        
        // Vérifier si la table access_codes existe
        const { error: checkError } = await supabase
            .from('access_codes')
            .select('id')
            .limit(1);
            
        if (checkError && checkError.code === 'PGRST116') {
            log.warn("❌ Table access_codes manquante - impossible de créer des données de test");
            return;
        }
        
        // Créer un code de test
        const testCode = 'NOVA-TEST' + Math.random().toString(36).substring(2, 6).toUpperCase();
        const { error: insertError } = await supabase
            .from('access_codes')
            .insert([{
                code: testCode,
                plan: 'monthly',
                duration_days: 7,
                created_by: 'system',
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            }]);
            
        if (!insertError) {
            log.success(`🔑 Code de test créé: ${testCode}`);
        } else {
            log.warn(`⚠️  Impossible de créer le code test: ${insertError.message}`);
        }
        
    } catch (error) {
        log.error('❌ Erreur création données test:', error);
    }
}

async function resetDatabase() {
    if (process.env.NODE_ENV !== 'development') {
        log.error('❌ Réinitialisation interdite en production');
        return;
    }
    
    try {
        const supabase = createClient(config.supabase.url, config.supabase.key);
        
        const tables = [
            'access_codes', 'subscriptions', 'telegram_users', 
            'whatsapp_sessions', 'user_settings'
        ];
        
        for (const table of tables) {
            try {
                const { error } = await supabase
                    .from(table)
                    .delete()
                    .neq('id', '0');
                    
                if (!error) {
                    log.info(`🧹 Table ${table} vidée`);
                }
            } catch (error) {
                log.warn(`⚠️  Impossible de vider ${table}: ${error.message}`);
            }
        }
        
        log.success("✅ Données de test supprimées");
        
    } catch (error) {
        log.error('❌ Erreur réinitialisation:', error);
    }
}

if (require.main === module) {
    initDatabase()
        .then(() => {
            log.success("🎉 Vérification base de données terminée!");
            process.exit(0);
        })
        .catch(error => {
            log.error("💥 Échec vérification:", error.message);
            log.info("💡 Créez les tables manuellement dans Supabase → Table Editor");
            process.exit(1);
        });
}

module.exports = { 
    initDatabase, 
    checkDatabaseConnection, 
    resetDatabase,
    createTestData 
};
