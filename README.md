# Vérificateur de notices Syracuse ⇄ Sudoc

Application web du **Centre de ressources documentaires de l'Insee**. Elle compare
les notices bibliographiques du SIGB **Syracuse** au catalogue **Sudoc** (ABES),
met en évidence les écarts, et permet à un·e documentaliste de **corriger et
compléter** les notices avant de les réexporter.

> **Statut : POC en cours de validation.** La logique de comparaison et de
> conversion UNIMARC est héritée du prototype initial. Les règles métier sont
> couvertes par des tests unitaires (`npm test`), mais elles doivent encore être
> éprouvées sur de vrais exports Syracuse avant un usage courant.

## Contexte

Le Centre de ressources documentaires catalogue ses ouvrages dans **Syracuse**. Ses
notices sont censées être alignées sur le **Sudoc**, le catalogue collectif de
l'enseignement supérieur géré par l'ABES, qui fait référence : chaque notice
Syracuse porte un champ « Identifiant d'origine » contenant le **PPN**,
l'identifiant Sudoc de la notice.

Deux problèmes se posent en pratique :

1. **Des notices divergent du Sudoc** — erreurs de saisie, champs laissés vides
   alors que l'information existe côté Sudoc, formatages hétérogènes.
2. **Une partie du fonds n'est pas rattachée au Sudoc.** Ces notices proviennent de
   l'ancien système **PMB** : elles n'ont pas de PPN et doivent être retrouvées
   dans le Sudoc par leur contenu (titre, auteur, année) avant de pouvoir être
   comparées.

Vérifier tout cela à la main, notice par notice, dans deux interfaces différentes,
est long et peu fiable. Cet outil automatise la partie mécanique — interroger le
Sudoc, comparer champ à champ, proposer les corrections — et laisse la décision à
l'humain.

C'est un **outil de revue avec l'humain dans la boucle** : la machine détecte et
propose, la documentaliste tranche. C'est particulièrement vrai pour le choix du
bon PPN parmi les candidats d'une recherche : aucune correction n'est appliquée
sans validation, exception faite de quelques normalisations de forme.

Le travail corrigé repart vers deux destinations : un **XML réimportable dans
Syracuse**, et un **texte UNIMARC** à coller dans **WINIBW**, l'outil de catalogage
professionnel du Sudoc.

## Ce qu'elle fait

1. On dépose un **export XML Syracuse** (structure `items` / `property`).
2. Chaque notice est classée :
   - **catégorie A** — elle porte déjà un PPN Sudoc → la notice Sudoc est
     récupérée et comparée champ à champ ;
   - **catégorie B** — identifiant PMB sans PPN → une **recherche SRU** est lancée
     dans le Sudoc et propose des candidats.
3. Un **tableau de bord** récapitule les écarts (statistiques + graphe).
4. En **vue détail**, on accepte / rejette / modifie chaque écart, on rattache le
   bon PPN pour les catégories B, et on peut demander à un LLM des **suggestions
   de vedettes RAMEAU** (facultatif).
5. On **exporte** le résultat en XML Syracuse corrigé, CSV (rapport d'écarts) ou
   texte UNIMARC (notation WINIBW).

Il n'y a **pas de base de données** : chaque traitement vit en mémoire le temps de
la session (un fichier en entrée, un fichier en sortie). Un redémarrage du serveur
efface les sessions en cours.

## Documentation

| Vous cherchez… | Voir |
| --- | --- |
| le contexte, le démarrage, le déploiement | ce fichier |
| le savoir métier : formats Syracuse et UNIMARC, web services de l'ABES, règles de normalisation, mappings | [docs/metier-unimarc-sudoc.md](docs/metier-unimarc-sudoc.md) |
| comprendre le déploiement de zéro : image, tag, registre, manifeste, pod, ArgoCD | [apprendre.md](apprendre.md) |
| les invariants à ne pas casser en modifiant le code, la carte des modules | [CLAUDE.md](CLAUDE.md) |
| l'historique de conception du POC (document d'archive) | [docs/historique-conception.md](docs/historique-conception.md) |

## Prérequis

- **Node.js 20** ou plus (l'image Docker utilise Node 22).
- Un **accès réseau sortant** vers `www.sudoc.fr` et `www.sudoc.abes.fr`
  (interrogation du Sudoc, API publiques sans authentification).
- Pour les suggestions RAMEAU, facultatives : un **endpoint LLM compatible OpenAI**
  et une clé d'API personnelle. Par défaut, l'interface propose le LLM du SSP
  Cloud.

## Installation et lancement

```bash
npm install

# Développement (rechargement à chaud : Vite est monté en middleware d'Express)
npm run dev

# Production
npm run build      # compile le front dans dist/
npm run start      # sert dist/ + l'API sur http://localhost:3000
```

```bash
npm test           # tests unitaires des règles métier (aucun accès réseau)
npm run typecheck  # vérifie le typage sans compiler
```

Les tests utilisent le lanceur intégré de Node (`node:test`) via `tsx` — aucune
dépendance supplémentaire. Ils travaillent sur des notices figées dans
`test/fixtures/`, donc ils ne sollicitent ni le Sudoc ni le LLM.

### Derrière un proxy (SSP Cloud, code-server)

Si vous ouvrez l'application par une URL **à préfixe** — typiquement
`https://<votre-service>.user.lab.sspcloud.fr/proxy/3000/` sur le SSP Cloud —
`npm run dev` affiche une **page blanche**. Passer par le mode production :

```bash
npm run build && npm run start
```

Pourquoi : le serveur de développement de Vite référence ses fichiers en chemins
**absolus** (`/src/main.tsx`), qui sortent du préfixe `/proxy/3000/` et visent la
racine du service au lieu de l'application — d'où des 401 et un `<div id="root">`
qui reste vide. Le `base: './'` de `vite.config.ts` produit bien des chemins
relatifs (`./assets/…`), mais **il ne s'applique qu'au build** : le serveur de dev
ramène toute base relative à `/`. Seul `npm run start` fonctionne donc derrière un
proxy, au prix du rechargement à chaud — après chaque modification de `src/`,
refaire `npm run build` (quelques secondes) et rafraîchir. Le backend, lui, reste
rechargé automatiquement par `tsx`.

Ne pas tenter `/absproxy/3000/`, la variante de code-server qui **conserve** le
préfixe : le front appelle l'API en relatif (`api/upload`) en comptant précisément
sur le fait que `/proxy/` retire le préfixe avant de transmettre. Avec
`/absproxy/`, Express recevrait `/absproxy/3000/api/upload` et répondrait 404 à
tous les appels.

## Configuration

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port d'écoute du serveur | `3000` |
| `NODE_ENV` | À `production`, Express sert `dist/` au lieu de monter Vite en middleware. Positionné automatiquement par `npm run start` et par l'image Docker. | *(non défini)* |

Copier `.env.example` en `.env` pour fixer ces valeurs localement.

Le **LLM** (suggestions RAMEAU) ne se configure **pas** par variable
d'environnement mais depuis l'interface, dans le panneau « Configuration LLM » du
tableau de bord : endpoint, clé d'API, modèle. L'endpoint proposé par défaut est
`https://llm.lab.sspcloud.fr/api/chat/completions`. La clé saisie ne quitte le
navigateur que le temps de chaque requête, transite par le backend qui joue le
rôle de proxy, et n'est **ni persistée ni journalisée** — elle est donc à ressaisir
après chaque rechargement de page.

## Formats

- **Entrée** : XML Syracuse (`items` / `property`), jusqu'à 50 Mo.
- **Sorties** :
  - `export_corrige_*.xml` — notices Syracuse avec corrections appliquées,
    structure et attributs préservés pour le réimport ;
  - `rapport_ecarts.csv` — un écart par ligne, séparateur `;`, encodage UTF‑8 (BOM)
    pour Excel ;
  - `export_unimarc_*.txt` — notices UNIMARC en notation texte WINIBW.

## Architecture en bref

- Front **React 19 + Vite + Tailwind** (`src/`) : une seule page à 4 vues (upload,
  progression, tableau de bord, détail).
- Back **Express** (`server/`), exécuté par `tsx` — pas d'étape de compilation
  TypeScript côté serveur.
- État en mémoire dans une `Map` indexée par UUID de session
  (`server/sessions.ts`). Pas de base de données, pas de volume persistant.
- Le front suit l'avancement de la vérification en **interrogeant
  `api/status/:sessionId`** à intervalle régulier (polling ; ce n'est pas du SSE).
- **Aucun secret côté serveur** : les API Sudoc sont publiques, la clé LLM
  appartient à l'utilisateur.

Détail des modules et des invariants : [CLAUDE.md](CLAUDE.md).

## Structure du projet

```
.
├── index.html            # page hôte du front
├── src/                  # front React (Vite + Tailwind)
│   ├── App.tsx           # toute l'interface (4 vues)
│   ├── main.tsx
│   └── index.css
├── test/                 # tests unitaires (node:test via tsx)
│   ├── fixtures/         # notices Syracuse et Sudoc figées
│   ├── marc.test.ts
│   ├── compare.test.ts
│   ├── syracuse.test.ts
│   └── exports.test.ts
├── server/               # back Express (aucune logique métier dans index.ts)
│   ├── index.ts          # routes HTTP + démarrage
│   ├── sessions.ts       # stockage en mémoire
│   ├── syracuse.ts       # lecture XML Syracuse + tables de correspondance
│   ├── marc.ts           # accès Sudoc (SRU + notice) + parsing UNIMARC
│   ├── compare.ts        # comparaison champ à champ
│   ├── verify.ts         # traitement d'une notice
│   ├── exports.ts        # génération XML / CSV / TXT
│   ├── llm.ts            # URL de listing des modèles LLM
│   └── version.ts        # version exécutée, exposée sur /api/version
├── scripts/
│   └── verifier-deploiement.sh  # le site déployé est-il à jour ?
├── apprendre.md          # cours : la chaîne de déploiement expliquée
├── docs/
│   ├── metier-unimarc-sudoc.md    # savoir métier (formats, mappings, règles)
│   └── historique-conception.md   # spécification d'origine (archive)
├── deploy/               # manifestes Kubernetes (YAML bruts, surveillés par ArgoCD)
│   ├── deployment.yaml   # lance le conteneur
│   ├── service.yaml      # adresse interne stable
│   └── ingress.yaml      # URL publique HTTPS
├── application.yaml      # ressource ArgoCD, à appliquer une seule fois à la main
├── .github/workflows/    # CI : build image → ghcr.io
│   └── build-push.yml
├── .env.example
├── Dockerfile
├── package.json
├── tsconfig.json
├── vite.config.ts
└── CLAUDE.md             # guide de travail sur le dépôt (humains et agents)
```

## Limites connues

- Le traitement des notices est **séquentiel**, avec une pause de 500 ms entre
  chaque par politesse envers les serveurs de l'ABES : comptez ~1 min pour 100
  notices, ~10 min pour 1000.
- **Pas de persistance** : un redémarrage du serveur efface les sessions en cours.
- Les **fixtures de test sont synthétiques** : écrites à la main d'après la
  structure réelle des réponses du Sudoc, pas capturées sur le service. Y figer de
  vraies notices renforcerait la couverture.
- L'**interface n'est pas testée automatiquement** : seules les règles métier du
  backend le sont.
- `src/App.tsx` est d'un seul tenant (~575 lignes, repris du POC) : dense à
  parcourir.
- La logique de comparaison et de conversion UNIMARC doit être **validée sur des
  cas réels** avant un usage en production.

## Déploiement sur le SSP Cloud

Cible : un conteneur unique servant le front compilé et l'API, déployé sur le
Kubernetes du SSP Cloud, sans base de données. Le principe est **GitOps** : ArgoCD
surveille le dossier `deploy/` du dépôt et applique automatiquement les
changements.

```
git push → GitHub Actions → image ghcr.io → ArgoCD détecte → Kubernetes
```

Procédure, à faire une fois :

1. **Vérifier l'image.** Un push sur `main` déclenche
   [.github/workflows/build-push.yml](.github/workflows/build-push.yml), qui publie
   `ghcr.io/<propriétaire>/<dépôt>:latest` **et un tag par commit** — c'est ce
   dernier qui est référencé dans `deploy/deployment.yaml` (voir « Mettre en
   production une nouvelle version »). Le paquet GHCR doit être **public**, sinon
   il faut ajouter un `imagePullSecret` au Deployment.
2. **Adapter les manifestes.** Dans `deploy/*.yaml` et `application.yaml`, remplacer
   le namespace `user-mhillion` par le vôtre, ajuster l'image dans
   `deploy/deployment.yaml` et le `host` dans `deploy/ingress.yaml`. Les points à
   adapter sont signalés par des commentaires `⚠️ À ADAPTER`.
3. **Lancer ArgoCD** depuis le catalogue Onyxia du SSP Cloud.
4. **Enregistrer l'application**, une seule fois :
   `kubectl apply -f application.yaml`. Ce fichier dit à ArgoCD quel dépôt et quel
   dossier surveiller ; `prune` et `selfHeal` sont activés.
5. Ensuite, tout passe par Git : ArgoCD resynchronise à chaque changement de
   `deploy/`. Voir ci-dessous pour mettre en production une nouvelle version.

### Mettre en production une nouvelle version

L'image est **épinglée par le SHA du commit** dans `deploy/deployment.yaml`, et non
par un tag `:latest`. La raison : ArgoCD compare le *texte* des fichiers de
`deploy/` à l'état du cluster. Un tag mouvant ne change jamais ce texte, donc
ArgoCD ne voit rien à faire et le pod continue de tourner avec l'image téléchargée
à son démarrage. Épingler le SHA fait de chaque mise en production un commit, que
ArgoCD applique de lui-même.

1. Fusionner la PR sur `main` et attendre que
   [.github/workflows/build-push.yml](.github/workflows/build-push.yml) ait publié
   l'image (onglet *Actions* du dépôt).
2. Relever le SHA du commit dont on veut l'image — `git rev-parse origin/main`, ou
   le SHA du commit de merge sur GitHub. Le workflow publie un tag par commit, en
   plus de `:latest`.
3. Reporter ce SHA dans le champ `image:` de `deploy/deployment.yaml`, puis pousser
   sur `main`. ArgoCD détecte le changement et redéploie seul, en une minute ou
   deux.
4. Contrôler, avec `./scripts/verifier-deploiement.sh` : les quatre verdicts
   doivent passer au ✓. Le contrôle le plus direct est celui de la dernière
   ligne — l'application déclare elle-même sur quel commit elle a été construite :

   ```
   curl -s https://unimarc-sudoc-reconciler.lab.sspcloud.fr/api/version
   {"version":"1.4.0","commit":"e48dca6cfb…","source":"image","demarrage":"…"}
   ```

   Ce SHA est gravé dans l'image à sa construction (`build-args: GIT_SHA` dans le
   workflow → `ARG`/`ENV` dans le `Dockerfile` → [server/version.ts](server/version.ts)),
   il ne peut donc pas mentir. Tout le mécanisme est expliqué pas à pas dans
   [apprendre.md](apprendre.md).

   Note : un changement **applicatif** demande deux commits, puisqu'on ne connaît
   le SHA qu'une fois le merge fait. Fusionner d'abord la PR, laisser le workflow
   publier l'image, puis pousser sur `main` un second commit qui reporte le SHA du
   commit de merge dans `deploy/deployment.yaml`.

Quelques conséquences utiles :

- **Aucun droit d'écriture sur Kubernetes n'est nécessaire.** C'est ArgoCD qui
  applique les manifestes ; un `git push` suffit. Les services VSCode du SSP Cloud
  sont lancés par défaut avec un rôle en lecture seule, et `kubectl rollout
  restart` y échoue — sans conséquence ici. (Pour l'obtenir malgré tout : relancer
  le service avec le rôle `admin`, ou récupérer son kubeconfig personnel depuis la
  page *Mon compte* d'Onyxia.)
- **Le dépôt dit ce qui tourne.** Plus besoin d'interroger le registre pour savoir
  quelle version est en ligne.
- **Le retour arrière est trivial** : remettre le SHA précédent et pousser.
- Quand le commit de mise en production ne touche que `deploy/` ou la
  documentation, le SHA épinglé reste celui du commit applicatif précédent. C'est
  normal : l'image est identique, seul le manifeste a changé.
- Pour rendre le déploiement automatique à chaque merge, il faudrait ArgoCD Image
  Updater ou une étape du workflow qui réécrit ce SHA. Tant que les mises en
  production sont occasionnelles et décidées, l'édition à la main reste la plus
  lisible.

Contraintes réseau, vérifiées : sortie HTTPS vers `www.sudoc.fr`,
`www.sudoc.abes.fr` et `llm.lab.sspcloud.fr` ✓ ; entrée HTTPS via l'ingress
nginx ✓. Aucun secret Kubernetes ni compte de service dédié n'est nécessaire.

## Recette avant mise en service

1. `npm test && npm run typecheck && npm run build` — doivent passer sans erreur.
2. `npm run start`, puis déposer un **vrai** export Syracuse contenant des notices
   des deux catégories.
3. Vérifier : détection A/B, cohérence des écarts, rattachement d'un PPN de
   catégorie B, et les **trois exports** — rouvrir le XML corrigé dans Syracuse,
   contrôler la notation UNIMARC du `.txt` dans WINIBW.
4. Faire valider par une documentaliste les propositions automatiques : la zone
   183 générée, la fusion des mentions d'illustrations, et les notices retrouvées
   par ISBN/EAN quand leur PPN Syracuse est faux.
