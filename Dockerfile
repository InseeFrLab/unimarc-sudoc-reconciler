# ─────────────────────────────────────────────────────────────
# Dockerfile — recette pour construire l'image du conteneur.
#
# Une "image" est un paquet figé contenant Node.js, le code et les
# dépendances. Le SSP Cloud lancera cette image dans un "conteneur".
# On lit ce fichier de haut en bas ; chaque instruction crée une couche.
# ─────────────────────────────────────────────────────────────

# 1. On part d'une image officielle Node.js 22 (version "slim" = légère).
FROM node:22-bookworm-slim

# 2. Dossier de travail à l'intérieur du conteneur.
WORKDIR /app

# 3. On copie d'abord UNIQUEMENT les fichiers de dépendances.
#    Astuce : tant que package.json ne change pas, Docker réutilise
#    l'étape "npm ci" en cache -> reconstructions bien plus rapides.
COPY package.json package-lock.json ./

# 4. Installation reproductible des dépendances (à partir du lockfile).
RUN npm ci

# 5. On copie le reste du code (.dockerignore exclut node_modules, dist, .env...).
COPY . .

# 6. Compilation du front React dans /app/dist.
RUN npm run build

# 7. Paramètres d'exécution.
ENV NODE_ENV=production
ENV PORT=3000

#    SHA du commit d'où vient ce code, passé par GitHub Actions
#    (--build-arg GIT_SHA=...). L'application le renvoie sur
#    GET /api/version : c'est ce qui permet de vérifier de l'extérieur
#    quelle version tourne réellement. Vide si l'image est construite
#    à la main sans cet argument.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

# 8. Le conteneur écoute sur ce port.
EXPOSE 3000

# 9. Commande lancée au démarrage du conteneur : sert dist/ + l'API.
CMD ["npm", "run", "start"]
