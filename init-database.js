const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const log = require('./utils/logger')(module);

async function initDatabase() {
    const supabase = createClient(config.supabase.url, config.supabase.key);
    
    log.info("🔄 Initialisation de la base de données Supabase...");
    
    const sqlCommands = [
        `CREATE TABLE IF NOT EXISTS access_codes (
            id BIGSERIAL PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            plan TEXT NOT NULL DEFAULT 'monthly',
            duration_days INTEGER NOT NULL DEFAULT 30,
            status TEXT NOT NULL DEFAULT 'active',
            created_by TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            used_by TEXT,
            used_at TIMESTAMP WITH TIME ZONE,
            max_usage INTEGER DEFAULT 1
        );`,
        
        `CREATE TABLE IF NOT EXISTS subscriptions (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            plan TEXT NOT NULL DEFAULT 'monthly',
            duration_days INTEGER NOT NULL DEFAULT 30,
            status TEXT NOT NULL DEFAULT 'active',
            start_date TIMESTAMP WITH TIME ZONE NOT NULL,
            end_date TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            cancelled_at TIMESTAMP WITH TIME ZONE,
            access_code_used TEXT
        );`,
        
        `CREATE TABLE IF NOT EXISTS telegram_users (
            chat_id TEXT PRIMARY KEY,
            first_name TEXT NOT NULL,
            username TEXT,
            phone_number TEXT,
            is_admin BOOLEAN DEFAULT FALSE,
            language_code TEXT DEFAULT 'fr',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`,
        
        `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT UNIQUE NOT NULL,
            user_id TEXT NOT NULL,
            user_data JSONB,
            status TEXT NOT NULL DEFAULT 'connecting',
            qr_code TEXT,
            connection_method TEXT DEFAULT 'qr',
            subscription_active BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            connected_at TIMESTAMP WITH TIME ZONE,
            last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            disconnected_at TIMESTAMP WITH TIME ZONE,
            disconnect_reason TEXT
        );`,
        
        `CREATE TABLE IF NOT EXISTS pairing_codes (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            phone_number TEXT NOT NULL,
            code TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL
        );`,
        
        `CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY,
            silent_mode BOOLEAN DEFAULT FALSE,
            private_mode BOOLEAN DEFAULT FALSE,
            allowed_users JSONB DEFAULT '[]',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`,
        
        `CREATE TABLE IF NOT EXISTS commands (
            id BIGSERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            code TEXT NOT NULL,
            category TEXT DEFAULT 'custom',
            enabled BOOLEAN DEFAULT TRUE,
            created_by TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`,
        
        `CREATE TABLE IF NOT EXISTS system_updates (
            id BIGSERIAL PRIMARY KEY,
            version TEXT NOT NULL,
            update_type TEXT NOT NULL,
            status TEXT NOT NULL,
            details JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            completed_at TIMESTAMP WITH TIME ZONE
        );`,
        
        `CREATE TABLE IF NOT EXISTS active_sessions_backup (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            session_data JSONB NOT NULL,
            backed_up_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            restored BOOLEAN DEFAULT FALSE
        );`
    ];
    
    try {
        // Vérifier d'abord la connexion
        const { error: connectionError } = await supabase
            .from('_supabase_schema')
            .select('*')
            .limit(1);
            
        if (connectionError) {
            throw new Error(`Connexion Supabase échouée: ${connectionError.message}`);
        }
        
        log.success("✅ Connexion à Supabase établie");
        
        // Exécuter les commandes SQL une par une
        for (const sql of sqlCommands) {
            try {
                // Pour Supabase, on ne peut pas exécuter du SQL arbitraire directement
                // On va plutôt vérifier si la table existe et la créer si nécessaire
                const tableName = extractTableName(sql);
                if (tableName) {
                    await createTableIfNotExists(supabase, tableName, sql);
                }
            } catch (error) {
                log.warn(`⚠️  Erreur création table: ${error.message}`);
            }
        }
        
        // Vérifier que les tables essentielles existent
        const essentialTables = ['subscriptions', 'access_codes', 'telegram_users'];
        let missingTables = [];
        
        for (const table of essentialTables) {
            const { error } = await supabase
                .from(table)
                .select('id')
                .limit(1);
                
            if (error) {
                missingTables.push(table);
            }
        }
        
        if (missingTables.length > 0) {
            throw new Error(`Tables manquantes: ${missingTables.join(', ')}. Créez-les manuellement dans Supabase.`);
        }
        
        log.success("✅ Base de données initialisée avec succès");
        
        // Afficher le statut des tables
        await logDatabaseStatus(supabase);
        
        // Créer des données de test en développement
        if (process.env.NODE_ENV === 'development') {
            await createTestData(supabase);
        }
        
    } catch (error) {
        log.error("❌ Erreur initialisation base de données:", error);
        
        // Donner des instructions pour la création manuelle
        log.info("💡 Solution alternative:");
        log.info("1. Allez sur Supabase → Table Editor");
        log.info("2. Créez manuellement les tables avec le SQL fourni");
        log.info("3. Redémarrez l'application");
        
        throw error;
    }
}

// Fonction utilitaire pour extraire le nom de table du SQL
function extractTableName(sql) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
    return match ? match[1] : null;
}

// Fonction pour créer une table si elle n'existe pas
async function createTableIfNotExists(supabase, tableName, createSql) {
    try {
        // Vérifier si la table existe
        const { error } = await supabase
            .from(tableName)
            .select('*')
            .limit(1);
            
        if (error && error.code === 'PGRST116') {
            // Table n'existe pas, on log juste l'info
            log.info(`📋 Table ${tableName} à créer manuellement dans Supabase`);
            return false;
        }
        
        // Table existe déjà
        return true;
    } catch (error) {
        log.warn(`⚠️  Vérification table ${tableName}: ${error.message}`);
        return false;
    }
}

async function logDatabaseStatus(supabase) {
    try {
        const tables = [
            'access_codes', 'subscriptions', 'telegram_users', 
            'whatsapp_sessions', 'user_settings', 'commands'
        ];
        
        log.info("📊 Statut de la base de données:");
        
        for (const table of tables) {
            try {
                const { count, error } = await supabase
                    .from(table)
                    .select('*', { count: 'exact', head: true });
                    
                if (!error) {
                    log.info(`   ${table}: ${count} enregistrements`);
                } else {
                    log.warn(`   ${table}: Table non trouvée`);
                }
            } catch (error) {
                log.warn(`   ${table}: Erreur de vérification`);
            }
        }
    } catch (error) {
        log.error('❌ Erreur statut base de données:', error);
    }
}

async function createTestData(supabase) {
    try {
        log.info("🧪 Création de données de test...");
        
        // Créer un code d'accès de test
        const testCode = 'NOVA-TEST' + Math.random().toString(36).substring(2, 6).toUpperCase();
        const { error: codeError } = await supabase
            .from('access_codes')
            .insert([{
                code: testCode,
                plan: 'monthly',
                duration_days: 7,
                created_by: 'system',
                expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            }]);
            
        if (!codeError) {
            log.success(`🔑 Code de test créé: ${testCode}`);
        }
        
        log.success("🎉 Données de test créées avec succès");
        
    } catch (error) {
        log.error('❌ Erreur création données test:', error);
    }
}

// Fonction pour vérifier la connexion à la base de données
async function checkDatabaseConnection() {
    try {
        const supabase = createClient(config.supabase.url, config.supabase.key);
        const { data, error } = await supabase
            .from('_supabase_schema')
            .select('*')
            .limit(1);
            
        if (error) {
            throw error;
        }
        
        log.success("✅ Connexion à la base de données établie");
        return true;
    } catch (error) {
        log.error('❌ Erreur connexion base de données:', error.message);
        return false;
    }
}

// Fonction pour réinitialiser la base de données (dangereux - seulement pour le dev)
async function resetDatabase() {
    if (process.env.NODE_ENV !== 'development') {
        log.error('❌ Réinitialisation interdite en production');
        return;
    }
    
    try {
        const supabase = createClient(config.supabase.url, config.supabase.key);
        
        const tables = [
            'access_codes', 'subscriptions', 'telegram_users', 
            'whatsapp_sessions', 'user_settings', 'commands', 
            'system_updates', 'pairing_codes', 'active_sessions_backup'
        ];
        
        for (const table of tables) {
            const { error } = await supabase
                .from(table)
                .delete()
                .neq('id', '0'); // Supprimer tous les enregistrements
                
            if (!error) {
                log.info(`🧹 Table ${table} vidée`);
            }
        }
        
        log.success("✅ Base de données réinitialisée");
        await initDatabase();
        
    } catch (error) {
        log.error('❌ Erreur réinitialisation base de données:', error);
    }
}

if (require.main === module) {
    initDatabase()
        .then(() => {
            log.success("🎉 Initialisation terminée avec succès!");
            process.exit(0);
        })
        .catch(error => {
            log.error("💥 Échec initialisation:", error);
            process.exit(1);
        });
}

module.exports = { 
    initDatabase, 
    checkDatabaseConnection, 
    resetDatabase,
    createTestData 
};
