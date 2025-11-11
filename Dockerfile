# -----------------------------
# Étape 1 : Choisir une image de base avec Python et Node
# -----------------------------
FROM python:3.12-slim

# Installer Node.js (LTS)
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    git \
    tini \
    procps \
    ca-certificates \
    libnss3 \
    libasound2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs build-essential \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# -----------------------------
# Étape 2 : Définir le répertoire de travail
# -----------------------------
WORKDIR /app

# -----------------------------
# Étape 3 : Copier les fichiers
# -----------------------------
COPY package*.json ./
COPY requirements.txt ./
COPY . .

# -----------------------------
# Étape 4 : Installer les dépendances
# -----------------------------
RUN apt-get update && apt-get install -y git
RUN npm install --omit=dev 
RUN pip install --no-cache-dir -r requirements.txt

# -----------------------------
# Étape 5 : Ajouter un script de lancement
# -----------------------------
# Crée un fichier start.sh pour lancer Python + Node en parallèle
# ✅ Avec trap pour tuer les sous-processus proprement
RUN echo '#!/bin/bash\n\
set -e\n\
mkdir -p sessions\n\
trap "echo 🔴 Arrêt détecté, fermeture propre...; pkill -P $$; exit 0" SIGINT SIGTERM\n\
echo 🟢 Démarrage du bot Python + Node...\n\
python bot.py &\n\
node index.js &\n\
wait' > /app/start.sh

RUN chmod +x /app/start.sh

# ==========================================================
# Étape 6 : Utiliser tini comme init process
# ==========================================================
ENTRYPOINT ["/usr/bin/tini", "--"]

# -----------------------------
# Étape 6 : Définir la commande de démarrage
# -----------------------------
CMD ["bash", "start.sh"]
