#!/bin/bash

# NOVA-MD - Script de déploiement universel
# Support: Koyeb, Render, VPS, Railway, Heroku, etc.
# Version: 2.2.0 (corrigée pour npm ci lockfile)

set -e  # Arrêter en cas d'erreur

# Couleurs pour l'affichage
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Fonctions d'affichage
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Vérification des prérequis
check_prerequisites() {
    log_info "Vérification des prérequis..."
    
    if command -v node >/dev/null 2>&1; then
        log_success "Node.js: $(node -v)"
    else
        log_error "Node.js n'est pas installé"; exit 1
    fi
    
    if command -v npm >/dev/null 2>&1; then
        log_success "npm: $(npm -v)"
    else
        log_error "npm n'est pas installé"; exit 1
    fi
    
    if command -v git >/dev/null 2>&1; then
        log_success "Git: $(git --version)"
    else
        log_error "Git n'est pas installé"; exit 1
    fi
    
    if command -v python3 >/dev/null 2>&1; then
        log_success "Python: $(python3 --version)"
    else
        log_warning "Python3 non installé (optionnel pour le bot Telegram)"
    fi
}

# Détection de la plateforme
detect_platform() {
    log_info "Détection de la plateforme..."
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

# Installation des dépendances (corrigée)
install_dependencies() {
    log_info "Installation des dépendances..."
    
    if [ -f "package.json" ]; then
        log_info "Installation des dépendances npm..."
        
        # Tentative npm ci avec fallback automatique
        if [ -f "package-lock.json" ]; then
            log_info "Lockfile détecté, tentative d'installation avec npm ci..."
            if ! npm ci --production=false; then
                log_warning "npm ci a échoué — fallback vers npm install"
                npm install --production=false --no-audit --no-fund
            fi
        else
            log_warning "Aucun package-lock.json trouvé, utilisation de npm install"
            npm install --production=false --no-audit --no-fund
        fi
        
        if [ $? -eq 0 ]; then
            log_success "Dépendances npm installées avec succès"
        else
            log_error "Échec de l'installation des dépendances npm"; exit 1
        fi
    fi
    
    if [ -f "requirements.txt" ]; then
        log_info "Installation des dépendances Python..."
        pip3 install -r requirements.txt && log_success "Dépendances Python installées"
    fi
}

# Configuration de l'environnement
setup_environment() {
    log_info "Configuration de l'environnement..."
    
    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        cp .env.example .env
        log_warning "⚠️  Fichier .env créé à partir du modèle — pensez à le configurer"
    fi
    
    local critical_vars=("SUPABASE_URL" "SUPABASE_SERVICE_KEY" "TELEGRAM_BOT_TOKEN")
    local missing_vars=()
    for var in "${critical_vars[@]}"; do
        if [ -z "${!var}" ] && ! grep -q "$var=" .env 2>/dev/null; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        log_warning "Variables manquantes: ${missing_vars[*]}"
    fi
    
    local folders=("sessions" "backups" "custom-commands" "logs")
    for folder in "${folders[@]}"; do
        [ ! -d "$folder" ] && mkdir -p "$folder" && log_success "Dossier créé: $folder"
    done
}

# Initialisation de la base de données
init_database() {
    log_info "Initialisation de la base de données..."
    if [ -f "init-database.js" ]; then
        node init-database.js && log_success "Base de données initialisée" || log_error "Échec de l'initialisation"
    else
        log_warning "Fichier init-database.js non trouvé"
    fi
}

# Construction de l'application
build_application() {
    log_info "Construction de l'application..."
    if [ -f "package.json" ] && grep -q "\"build\"" package.json; then
        npm run build && log_success "Application construite" || log_warning "Échec du build"
    fi
}

# Démarrage de l'application
start_application() {
    local platform=$1
    log_info "Démarrage de l'application sur $platform..."
    
    case $platform in
        "koyeb"|"render"|"railway"|"heroku"|"flyio"|"docker")
            npm start ;;
        "vps")
            if command -v pm2 >/dev/null 2>&1; then
                log_info "Démarrage avec PM2..."
                cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'nova-md',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: { NODE_ENV: 'production', PORT: 3000 }
  }, {
    name: 'nova-md-bot',
    script: 'bot.py',
    interpreter: 'python3',
    instances: 1,
    autorestart: true
  }]
};
EOF
                pm2 start ecosystem.config.js && pm2 save && pm2 startup
                log_success "Application démarrée avec PM2"
            else
                npm start
            fi ;;
        *) npm start ;;
    esac
}

# Vérification de la santé
health_check() {
    log_info "Vérification de la santé de l'application..."
    sleep 10
    if command -v curl >/dev/null 2>&1; then
        local port=${PORT:-3000}
        local health_url="http://localhost:${port}/health"
        if curl -f -s --retry 3 --retry-delay 5 "$health_url" >/dev/null; then
            log_success "✅ L'application fonctionne correctement"
            return 0
        else
            log_error "❌ L'application ne répond pas"; return 1
        fi
    else
        log_warning "curl non disponible, skip du health check"
        return 0
    fi
}

cleanup() {
    log_info "Nettoyage..."
    rm -rf node_modules/.cache 2>/dev/null || true
    log_success "Cache nettoyé"
}

main() {
    log_info "🚀 Déploiement de NOVA-MD..."
    log_info "Version: 2.2.0"
    
    local platform=$(detect_platform)
    check_prerequisites
    install_dependencies
    setup_environment
    init_database
    build_application
    start_application "$platform" &
    
    if health_check; then
        log_success "🎉 Déploiement réussi!"
        log_info "📱 Disponible sur le port ${PORT:-3000}"
        log_info "🤖 Bot Telegram opérationnel"
    else
        log_error "💥 Échec du déploiement"; exit 1
    fi
}

trap 'log_warning "Arrêt demandé..."; cleanup; exit 0' SIGINT SIGTERM

if [ "$#" -eq 0 ]; then
    main
else
    case $1 in
        "init-db") init_database ;;
        "health-check") health_check ;;
        "setup-env") setup_environment ;;
        "install-deps") install_dependencies ;;
        "start") start_application $(detect_platform) ;;
        "cleanup") cleanup ;;
        "help"|"-h"|"--help")
            echo "Usage: $0 [commande]"
            echo ""
            echo "Commandes disponibles :"
            echo "  init-db        → Initialiser la base de données"
            echo "  health-check   → Vérifier la santé"
            echo "  setup-env      → Configurer l'environnement"
            echo "  install-deps   → Installer les dépendances"
            echo "  start          → Démarrer l'application"
            echo "  cleanup        → Nettoyer les caches"
            echo "  help           → Afficher cette aide"
            ;;
        *) log_error "Commande inconnue: $1" ;;
    esac
fi
