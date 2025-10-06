#!/bin/bash

# NOVA-MD - Script de déploiement universel
# Support: Koyeb, Render, VPS, Railway, Heroku, etc.

set -e  # Arrêter en cas d'erreur

# Couleurs pour l'affichage
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Fonctions d'affichage
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Vérification des prérequis
check_prerequisites() {
    log_info "Vérification des prérequis..."
    
    # Vérifier Node.js
    if command -v node >/dev/null 2>&1; then
        NODE_VERSION=$(node -v)
        log_success "Node.js: $NODE_VERSION"
    else
        log_error "Node.js n'est pas installé"
        exit 1
    fi
    
    # Vérifier npm
    if command -v npm >/dev/null 2>&1; then
        NPM_VERSION=$(npm -v)
        log_success "npm: $NPM_VERSION"
    else
        log_error "npm n'est pas installé"
        exit 1
    fi
    
    # Vérifier Git
    if command -v git >/dev/null 2>&1; then
        GIT_VERSION=$(git --version)
        log_success "Git: $GIT_VERSION"
    else
        log_error "Git n'est pas installé"
        exit 1
    fi
    
    # Vérifier Python (pour le bot Telegram)
    if command -v python3 >/dev/null 2>&1; then
        PYTHON_VERSION=$(python3 --version)
        log_success "Python: $PYTHON_VERSION"
    else
        log_warning "Python3 n'est pas installé (requis pour le bot Telegram)"
    fi
}

# Détection de la plateforme
detect_platform() {
    log_info "Détection de la plateforme..."
    
    # Vérifier si nous sommes dans un conteneur Docker
    if [ -f /.dockerenv ]; then
        PLATFORM="docker"
    elif [ -n "$KOYEB_APP" ]; then
        PLATFORM="koyeb"
    elif [ -n "$RENDER" ]; then
        PLATFORM="render"
    elif [ -n "$RAILWAY_STATIC_URL" ]; then
        PLATFORM="railway"
    elif [ -n "$HEROKU_APP_NAME" ]; then
        PLATFORM="heroku"
    elif [ -n "$FLY_APP_NAME" ]; then
        PLATFORM="flyio"
    else
        PLATFORM="vps"
    fi
    
    log_success "Plateforme détectée: $PLATFORM"
    echo $PLATFORM
}

# Installation des dépendances
install_dependencies() {
    log_info "Installation des dépendances..."
    
    # Installation des dépendances Node.js
    if [ -f "package.json" ]; then
        log_info "Installation des dépendances npm..."
        npm install --production --no-audit --no-fund
        
        if [ $? -eq 0 ]; then
            log_success "Dépendances npm installées avec succès"
        else
            log_error "Échec de l'installation des dépendances npm"
            exit 1
        fi
    fi
    
    # Installation des dépendances Python
    if [ -f "requirements.txt" ]; then
        log_info "Installation des dépendances Python..."
        pip3 install -r requirements.txt
        
        if [ $? -eq 0 ]; then
            log_success "Dépendances Python installées avec succès"
        else
            log_warning "Échec de l'installation des dépendances Python"
        fi
    fi
}

# Configuration de l'environnement
setup_environment() {
    log_info "Configuration de l'environnement..."
    
    # Créer le fichier .env s'il n'existe pas
    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        log_info "Création du fichier .env..."
        cp .env.example .env
        log_warning "⚠️  Veuillez configurer le fichier .env avec vos variables d'environnement"
    fi
    
    # Vérifier les variables d'environnement critiques
    local critical_vars=("SUPABASE_URL" "SUPABASE_SERVICE_KEY" "TELEGRAM_BOT_TOKEN")
    local missing_vars=()
    
    for var in "${critical_vars[@]}"; do
        if [ -z "${!var}" ] && ! grep -q "$var=" .env 2>/dev/null; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        log_warning "Variables manquantes: ${missing_vars[*]}"
        log_warning "Veuillez les définir dans le fichier .env ou les variables d'environnement"
    fi
    
    # Créer les dossiers nécessaires
    local folders=("sessions" "backups" "custom-commands" "logs")
    for folder in "${folders[@]}"; do
        if [ ! -d "$folder" ]; then
            mkdir -p "$folder"
            log_success "Dossier créé: $folder"
        fi
    done
}

# Initialisation de la base de données
init_database() {
    log_info "Initialisation de la base de données..."
    
    if [ -f "init-database.js" ]; then
        node init-database.js
        
        if [ $? -eq 0 ]; then
            log_success "Base de données initialisée avec succès"
        else
            log_error "Échec de l'initialisation de la base de données"
            exit 1
        fi
    else
        log_warning "Fichier init-database.js non trouvé"
    fi
}

# Construction de l'application
build_application() {
    log_info "Construction de l'application..."
    
    # Exécuter le script build s'il existe
    if [ -f "package.json" ] && grep -q "\"build\"" package.json; then
        log_info "Exécution du script build..."
        npm run build
        
        if [ $? -eq 0 ]; then
            log_success "Application construite avec succès"
        else
            log_warning "Échec de la construction de l'application"
        fi
    fi
}

# Démarrage de l'application
start_application() {
    local platform=$1
    log_info "Démarrage de l'application sur $platform..."
    
    case $platform in
        "koyeb"|"render"|"railway"|"heroku"|"flyio")
            # Ces plateformes gèrent le démarrage automatiquement
            log_info "Démarrage avec: npm start"
            npm start
            ;;
        "docker")
            log_info "Environnement Docker détecté"
            npm start
            ;;
        "vps")
            # Sur un VPS, on peut utiliser PM2 pour la gestion des processus
            if command -v pm2 >/dev/null 2>&1; then
                log_info "Démarrage avec PM2..."
                
                # Créer la configuration PM2
                cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'nova-md',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }, {
    name: 'nova-md-bot',
    script: 'bot.py',
    interpreter: 'python3',
    instances: 1,
    autorestart: true,
    watch: false
  }]
};
EOF
                
                pm2 start ecosystem.config.js
                pm2 save
                pm2 startup
                
                log_success "Application démarrée avec PM2"
            else
                log_info "Démarrage direct avec Node.js..."
                npm start
            fi
            ;;
        *)
            log_info "Démarrage standard..."
            npm start
            ;;
    esac
}

# Vérification de la santé de l'application
health_check() {
    log_info "Vérification de la santé de l'application..."
    
    # Attendre que l'application démarre
    sleep 10
    
    # Essayer de contacter l'endpoint santé
    if command -v curl >/dev/null 2>&1; then
        local port=${PORT:-3000}
        local health_url="http://localhost:${port}/health"
        
        if curl -f -s --retry 3 --retry-delay 5 "$health_url" >/dev/null; then
            log_success "✅ L'application fonctionne correctement"
            return 0
        else
            log_error "❌ L'application ne répond pas"
            return 1
        fi
    else
        log_warning "curl non disponible, impossible de vérifier la santé"
        return 0
    fi
}

# Nettoyage
cleanup() {
    log_info "Nettoyage..."
    
    # Supprimer les fichiers temporaires
    rm -rf node_modules/.cache
    log_success "Cache nettoyé"
}

# Fonction principale
main() {
    log_info "🚀 Déploiement de NOVA-MD..."
    log_info "Version: 2.1.0"
    
    # Détection de la plateforme
    local platform=$(detect_platform)
    
    # Vérification des prérequis
    check_prerequisites
    
    # Installation des dépendances
    install_dependencies
    
    # Configuration de l'environnement
    setup_environment
    
    # Initialisation de la base de données
    init_database
    
    # Construction de l'application
    build_application
    
    # Démarrage de l'application
    start_application "$platform" &
    
    # Vérification de la santé
    if health_check; then
        log_success "🎉 Déploiement réussi!"
        log_info "📱 Application disponible sur le port ${PORT:-3000}"
        log_info "🤖 Bot Telegram prêt à recevoir des commandes"
        log_info "🔗 Endpoint santé: /health"
        
        # Afficher les informations importantes
        echo ""
        log_info "📋 Prochaines étapes:"
        log_info "   1. Configurez votre bot Telegram avec /start"
        log_info "   2. Générez des codes d'accès avec /generate_code"
        log_info "   3. Connectez WhatsApp avec /connect"
        echo ""
        
        # Garder le processus actif
        wait
    else
        log_error "💥 Échec du déploiement"
        exit 1
    fi
}

# Gestion des signaux
trap 'log_warning "Arrêt demandé..."; cleanup; exit 0' SIGINT SIGTERM

# Exécution principale
if [ "$#" -eq 0 ]; then
    main
else
    case $1 in
        "init-db")
            init_database
            ;;
        "health-check")
            health_check
            ;;
        "setup-env")
            setup_environment
            ;;
        "install-deps")
            install_dependencies
            ;;
        "start")
            start_application $(detect_platform)
            ;;
        "cleanup")
            cleanup
            ;;
        "help"|"-h"|"--help")
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  init-db      Initialiser la base de données"
            echo "  health-check Vérifier la santé de l'application"
            echo "  setup-env    Configurer l'environnement"
            echo "  install-deps Installer les dépendances"
            echo "  start        Démarrer l'application"
            echo "  cleanup      Nettoyer les fichiers temporaires"
            echo "  help         Afficher cette aide"
            echo ""
            echo "Sans commande: déploiement complet"
            ;;
        *)
            log_error "Commande inconnue: $1"
            echo "Utilisez '$0 help' pour voir les commandes disponibles"
            exit 1
            ;;
    esac
fi
