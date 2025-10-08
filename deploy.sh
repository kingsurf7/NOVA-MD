#!/bin/bash

# ============================================================
# 🚀 NOVA-MD - Script de déploiement universel (v3.0.0)
# Support : Koyeb, Render, Railway, Heroku, Fly.io, VPS, Docker
# Fonctionnalités :
#   - Installation auto des dépendances npm & Python
#   - Création auto des dossiers & .env
#   - Lancement simultané Node.js (index.js) + Python (bot.py)
#   - PM2 pour VPS avec redémarrage auto
# ============================================================

set -e  # Stop en cas d'erreur

# 🎨 Couleurs d'affichage
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 💬 Fonctions d'affichage
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# 🔍 Vérification des prérequis
check_prerequisites() {
    log_info "Vérification des prérequis..."
    for cmd in node npm git; do
        if command -v $cmd >/dev/null 2>&1; then
            log_success "$cmd: $($cmd --version | head -n1)"
        else
            log_error "$cmd n'est pas installé"; exit 1
        fi
    done

    if command -v python3 >/dev/null 2>&1; then
        log_success "Python: $(python3 --version)"
    else
        log_warning "Python3 non installé (nécessaire pour bot.py)"
    fi
}

# 🧠 Détection automatique de la plateforme
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
    log_success "Plateforme détectée : $PLATFORM"
    echo $PLATFORM
}

# 📦 Installation des dépendances
install_dependencies() {
    log_info "Installation des dépendances..."

    # Node.js
    if [ -f "package.json" ]; then
        log_info "→ Dépendances npm..."
        if [ -f "package-lock.json" ]; then
            if ! npm ci --production=false; then
                log_warning "npm ci a échoué → fallback vers npm install"
                npm install --production=false --no-audit --no-fund
            fi
        else
            npm install --production=false --no-audit --no-fund
        fi
        log_success "Dépendances Node.js installées"
    fi

    # Python
    if [ -f "requirements.txt" ]; then
        log_info "→ Dépendances Python..."
        pip3 install -r requirements.txt && log_success "Dépendances Python installées"
    fi
}

# ⚙️ Configuration de l'environnement
setup_environment() {
    log_info "Configuration de l'environnement..."

    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        cp .env.example .env
        log_warning "⚠️  Fichier .env créé à partir du modèle — à personnaliser"
    fi

    local vars=("SUPABASE_URL" "SUPABASE_SERVICE_KEY" "TELEGRAM_BOT_TOKEN")
    local missing=()
    for v in "${vars[@]}"; do
        if [ -z "${!v}" ] && ! grep -q "$v=" .env 2>/dev/null; then
            missing+=("$v")
        fi
    done
    [ ${#missing[@]} -gt 0 ] && log_warning "Variables manquantes : ${missing[*]}"

    for dir in "sessions" "backups" "custom-commands" "logs"; do
        [ ! -d "$dir" ] && mkdir -p "$dir" && log_success "📁 Dossier créé : $dir"
    done
}

# 🗄️ Initialisation de la base de données
init_database() {
    log_info "Initialisation de la base de données..."
    if [ -f "init-database.js" ]; then
        node init-database.js && log_success "Base de données initialisée"
    else
        log_warning "Fichier init-database.js non trouvé"
    fi
}

# 🧱 Construction du projet
build_application() {
    if [ -f "package.json" ] && grep -q "\"build\"" package.json; then
        log_info "Construction de l'application..."
        npm run build && log_success "Application construite"
    fi
}

# 🚀 Démarrage simultané (Node.js + Python)
start_application() {
    local platform=$1
    log_info "Démarrage simultané sur $platform..."

    case $platform in
        "vps")
            if command -v pm2 >/dev/null 2>&1; then
                log_info "→ Démarrage via PM2..."
                cat > ecosystem.config.js << EOF
module.exports = {
  apps: [
    {
      name: 'nova-node',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production', PORT: 3000 }
    },
    {
      name: 'nova-python',
      script: 'bot.py',
      interpreter: 'python3',
      instances: 1,
      autorestart: true
    }
  ]
};
EOF
                pm2 start ecosystem.config.js && pm2 save && pm2 startup
                log_success "Les deux processus Node.js + Python sont actifs via PM2"
            else
                log_warning "PM2 non installé → exécution simple"
                [ -f "index.js" ] && node index.js &
                [ -f "bot.py" ] && python3 bot.py &
                wait
            fi
            ;;
        *)
            [ -f "index.js" ] && npm start &
            [ -f "bot.py" ] && python3 bot.py &
            wait
            ;;
    esac
}

# ❤️ Vérification de la santé
health_check() {
    log_info "Vérification de la santé..."
    sleep 10
    if command -v curl >/dev/null 2>&1; then
        local port=${PORT:-3000}
        if curl -fs "http://localhost:${port}/health" >/dev/null; then
            log_success "✅ Application Node.js active"
        else
            log_warning "⚠️  Node.js ne répond pas sur /health"
        fi
    fi
}

# 🧹 Nettoyage
cleanup() {
    log_info "Nettoyage..."
    rm -rf node_modules/.cache 2>/dev/null || true
    log_success "Cache nettoyé"
}

# 🧭 Main
main() {
    log_info "🚀 Lancement du déploiement NOVA-MD v3.0.0..."
    local platform=$(detect_platform)
    check_prerequisites
    install_dependencies
    setup_environment
    init_database
    build_application
    start_application "$platform" &
    if health_check; then
        log_success "🎉 Déploiement réussi !"
        log_info "📱 Port : ${PORT:-3000}"
        log_info "🤖 Bots Node.js & Python opérationnels"
    else
        log_error "💥 Échec du déploiement"
        exit 1
    fi
}

trap 'log_warning "Arrêt demandé..."; cleanup; exit 0' SIGINT SIGTERM

# 🧰 Gestion des sous-commandes
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
            echo "  health-check   → Vérifier la santé de l'app"
            echo "  setup-env      → Configurer l'environnement"
            echo "  install-deps   → Installer les dépendances"
            echo "  start          → Démarrer les deux bots"
            echo "  cleanup        → Nettoyer les caches"
            echo "  help           → Afficher cette aide"
            ;;
        *) log_error "Commande inconnue: $1" ;;
    esac
fi 
