#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# verifier-deploiement.sh — Le site déployé correspond-il au dernier
# code commité sur main ?
#
# Recoupe quatre sources, du dépôt jusqu'au conteneur en train de tourner.
# Ne demande que des droits de LECTURE sur Kubernetes : utilisable depuis
# un service VSCode du SSP Cloud lancé avec le rôle par défaut.
#
# Si le site est périmé, le remède est le bouton « Restart » sur le Deployment
# dans l'interface ArgoCD : l'image est publiée sous l'étiquette mouvante
# `latest`, qu'ArgoCD ne surveille pas. Détail pédagogique : voir apprendre.md.
# ─────────────────────────────────────────────────────────────
set -uo pipefail

APP=unimarc-sudoc-reconciler
REPO=inseefrlab/unimarc-sudoc-reconciler
SITE=https://unimarc-sudoc-reconciler.lab.sspcloud.fr

# Fichiers dont une modification change ce que fait le site. Un commit qui ne
# touche que la doc ou deploy/ produit une image au comportement identique :
# le site a donc le droit de déclarer un commit antérieur à HEAD sans être
# pour autant périmé. C'est à ces chemins-là qu'on le compare.
CHEMINS_APPLICATIFS=(src server package.json package-lock.json Dockerfile vite.config.ts)

git fetch -q origin

# 1. Ce que Git demande : le tag inscrit dans le manifeste de origin/main.
TAG_GIT=$(git show origin/main:deploy/deployment.yaml \
  | sed -n 's|.*image: ghcr.io/[^:]*:\(.*\)|\1|p')
HEAD_MAIN=$(git rev-parse origin/main)
DERNIER_CODE=$(git log -1 --format=%H origin/main -- "${CHEMINS_APPLICATIFS[@]}")

# 2. Ce qu'ArgoCD a appliqué dans le cluster, et ce que le pod exécute.
TAG_CLUSTER=$(kubectl get deployment "$APP" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed 's/.*://')
DIGEST_POD=$(kubectl get pod -l app="$APP" \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' 2>/dev/null | sed 's/.*@//')
AGE_POD=$(kubectl get pod -l app="$APP" --no-headers 2>/dev/null | awk '{print $5}')

# 3. Ce que ce tag désigne AUJOURD'HUI dans le registre : un tag est une
#    étiquette déplaçable, seule l'empreinte sha256 identifie une image.
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:${REPO}:pull&service=ghcr.io" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
DIGEST_ATTENDU=$(curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/${REPO}/manifests/${TAG_GIT}" \
  | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | tr -d '\r')

# 4. Ce que l'application déclare elle-même. Preuve directe, contrairement
#    aux trois premières qui raisonnent sur des étiquettes.
COMMIT_SITE=$(curl -s --max-time 10 "${SITE}/api/version" \
  | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')

# printf compte les octets : les accents décaleraient les colonnes.
# ${#chaine} compte les caractères, on complète donc nous-mêmes.
ligne() { local l="$1"; local n=$(( 34 - ${#l} )); printf '  %s%*s%s\n' "$l" "$n" '' "${2:-(indisponible)}"; }

echo
ligne "origin/main (HEAD)"           "${HEAD_MAIN:0:12}"
ligne "dernier commit applicatif"    "${DERNIER_CODE:0:12}"
ligne "tag demandé par le manifeste" "${TAG_GIT:0:12}"
ligne "tag appliqué dans le cluster" "${TAG_CLUSTER:0:12}"
ligne "image attendue (registre)"    "${DIGEST_ATTENDU:0:19}"
ligne "image réellement exécutée"    "${DIGEST_POD:0:19}"
ligne "commit déclaré par le site"   "${COMMIT_SITE:0:12}"
ligne "âge du pod"                   "$AGE_POD"
echo

# Verdicts. Attention : les deux premiers peuvent être ✓ alors que le site est
# périmé — c'est le propre d'une étiquette mouvante comme `latest`, qu'ArgoCD
# ne surveille pas. Le verdict qui tranche est le troisième.
[ -n "$TAG_GIT" ] && [ "$TAG_GIT" = "$TAG_CLUSTER" ] \
  && echo "  ✓ ArgoCD a bien appliqué le manifeste de main." \
  || echo "  ✗ ArgoCD n'a pas appliqué le manifeste de main (synchronisation en attente ?)."

if [ -n "$DIGEST_POD" ] && [ "$DIGEST_POD" = "$DIGEST_ATTENDU" ]; then
  echo "  ✓ Le pod exécute bien l'image que « ${TAG_GIT:0:12} » désigne aujourd’hui."
else
  echo "  ✗ Le pod exécute une AUTRE image : « ${TAG_GIT:0:12} » a bougé depuis qu'il a démarré."
fi

if [ -z "$COMMIT_SITE" ]; then
  echo "  ⚠ Le site ne répond pas sur /api/version (version antérieure à cette route, ou site injoignable)."
elif [ "$COMMIT_SITE" = "$DERNIER_CODE" ]; then
  echo "  ✓ Le site exécute le dernier code applicatif de main."
else
  echo "  ✗ Le site exécute ${COMMIT_SITE:0:12}, or le dernier code applicatif est ${DERNIER_CODE:0:12}."
fi

# Remède, affiché seulement s'il y a lieu.
PERIME=non
[ -n "$DIGEST_POD" ] && [ "$DIGEST_POD" != "$DIGEST_ATTENDU" ] && PERIME=oui
[ -n "$COMMIT_SITE" ] && [ "$COMMIT_SITE" != "$DERNIER_CODE" ] && PERIME=oui
if [ "$PERIME" = "oui" ]; then
  echo
  echo "  → Pour déployer : interface ArgoCD, application « $APP »,"
  echo "    ressource Deployment, bouton « Restart ». Le pod est recréé et"
  echo "    retélécharge l'image. Attention : les sessions de vérification"
  echo "    en cours seront perdues (l'application n'a aucune persistance)."
fi
echo
