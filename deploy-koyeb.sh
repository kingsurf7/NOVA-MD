#!/bin/bash

# ============================================================
# 🚀 NOVA-MD - Script de déploiement optimisé pour KOYEB (v3.1.0)
# ============================================================

set -e

# 🎨 Couleurs
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}ℹ️  $1${NC}"; }
ok() { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err() { echo -e "${RED}❌ $1${NC}"; }

# 📦 1. Installation des dépendances
install_deps() {
    log "Installation des dépendances..."
    if [ -f "package-lock.json" ]; then
        npm ci --production=false || npm install --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi
    if [ -f "requirements.txt" ]; then
        pip3 install -r requirements.txt || warn "Dépendances Python ignorées"
    fi
    ok "Toutes les dépendances installées"
}

# ⚙️ 2. Configuration de l’environnement
setup_env() {
    log "Vérification du fichier .env..."
    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        cp .env.example .env
        warn "Fichier .env créé à partir de .env.example — à personnaliser"
    fi
    mkdir -p sessions backups logs custom-commands
    ok "Environnement configuré"
}

# 🗄️ 3. Initialisation de la base de données
init_db() {
    if [ -f "init-database.js" ]; then
        log "Initialisation de la base de données..."
        node init-database.js && ok "Base de données initialisée"
    else
        warn "Aucun fichier init-database.js trouvé"
    fi
}

# 🧱 4. Build optionnel
build_app() {
    if grep -q "\"build\"" package.json 2>/dev/null; then
        log "Construction du projet..."
        npm run build && ok "Build terminé"
    else
        log "Aucun script build détecté — étape ignorée"
    fi
}

# 🚀 5. Démarrage du bot (Node.js + Python)
start_app() {
    log "Démarrage de l’application sur Koyeb..."
    [ -f "bot.py" ] && python3 bot.py &
    [ -f "index.js" ] && node index.js &
    ok "NOVA-MD lancé sur le port ${PORT:-3000}"
    wait -n  # attendre si un des deux crash
}

# ❤️ 6. Vérification santé
health_check() {
    sleep 8
    if curl -fs "http://localhost:${PORT:-3000}/health" >/dev/null 2>&1; then
        ok "Application Node.js active"
    else
        warn "Endpoint /health non accessible (peut être normal au démarrage)"
    fi
}

# 🧭 Commande principale
case "$1" in
  install-deps) install_deps ;;
  setup-env) setup_env ;;
  init-db) init_db ;;
  build) build_app ;;
  start)
      start_app &
      health_check
      ok "🎉 Déploiement terminé (Koyeb)"
      tail -f /dev/null  # empêcher la fin du process
      ;;
  *)
      echo "Usage: $0 {install-deps|setup-env|init-db|build|start}"
      ;;
esac
