module.exports = {
    bot: {
        name: "NOVA-MD Premium",
        prefix: "!",
        version: "2.1.0",
        price: 5,
        support_contact: "@Nova_king0",
        website: "https://nova-md.com",
        github_url: "https://github.com/votre-repo/nova-md",
        auto_update: true
    },
    supabase: {
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_SERVICE_KEY
    },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        admin_ids: process.env.TELEGRAM_ADMIN_IDS ? process.env.TELEGRAM_ADMIN_IDS.split(',') : [],
        support_channel: process.env.TELEGRAM_SUPPORT_CHANNEL || "@nova_md_support"
    },
    web: {
        port: process.env.PORT || 3000,
        baseUrl: process.env.BASE_URL || "http://localhost:3000"
    },
    features: {
        multiDevice: false,
        autoReconnect: true,
        persistentSessions: true,
        maxSessionsPerUser: 1,
        connectionMethods: ['qr', 'pairing'],
        autoUpdate: true,
        dynamicCommands: true,
        silentMode: true,
        privateMode: true
    },
    subscriptions: {
        defaultDurations: {
            monthly: 30,
            '3months': 90,
            '6months': 180,
            yearly: 365
        },
        availablePlans: ['monthly', '3months', '6months', 'yearly', 'custom']
    },
    sessions: {
        subscriptionSessionLifetime: 30 * 24 * 60 * 60 * 1000,
        activityCheckInterval: 5 * 60 * 1000,
        cleanupInterval: 6 * 60 * 60 * 1000
    },
    updates: {
        github_repo: "votre-repo/nova-md",
        branch: "main",
        check_interval: 3600000,
        auto_restart: false,
        backup_before_update: true,
        force_update: true,
        preserve_sessions: true,
        dynamic_reload: true
    },
    commands: {
        categories: {
            'configuration': '⚙️ Configuration',
            'information': '📊 Information', 
            'utility': '🔧 Utilitaires',
            'media': '🎵 Médias',
            'fun': '🎉 Fun'
        },
        default_prefix: "!",
        timeout: 30000
    }
};