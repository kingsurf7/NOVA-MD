# -----------------------------
# Étape 1 : Choisir une image de base avec Python et Node
# -----------------------------
FROM python:3.12-slim

# Installer Node.js (LTS)
RUN apt-get update && apt-get install -y curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs build-essential \
    && rm -rf /var/lib/apt/lists/*

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
RUN npm install --production
RUN pip install --no-cache-dir -r requirements.txt

# -----------------------------
# Étape 5 : Ajouter un script de lancement
# -----------------------------
# Crée un fichier start.sh pour lancer Python + Node en parallèle
RUN echo '#!/bin/bash\n\
mkdir sessions &\n\
python bot.py &\n\
node index.js' > /app/start.sh
RUN chmod +x /app/start.sh

# -----------------------------
# Étape 6 : Définir la commande de démarrage
# -----------------------------
CMD ["bash", "start.sh"]
