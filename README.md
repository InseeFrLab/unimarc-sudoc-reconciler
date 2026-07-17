# Vérificateur de notices Syracuse ⇄ Sudoc

Application web POC du Centre de ressources documentaires de l'Insee. Elle **compare les notices bibliographiques du SIGB Syracuse au catalogue Sudoc (ABES)**, met en
évidence les écarts, et permet à un·e documentaliste de **corriger et compléter**
les notices avant de les réexporter.

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
la session (un fichier en entrée, un fichier en sortie).

## Prérequis

- Node.js 20 ou plus.
- Un accès réseau sortant vers `www.sudoc.fr` et `www.sudoc.abes.fr` (interrogation
  du Sudoc). Pour les suggestions RAMEAU : un endpoint LLM compatible OpenAI
  (par défaut le LLM du SSP Cloud).

## Installation et lancement

```bash
npm install

# Développement (rechargement à chaud via Vite)
npm run dev

# Production
npm run build      # compile le front dans dist/
npm run start      # sert dist/ + l'API sur http://localhost:3000
```

Vérifier le typage sans compiler : `npm run typecheck`.

## Configuration

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port d'écoute du serveur | `3000` |

Le **LLM** (suggestions RAMEAU) se configure directement depuis l'interface
(panneau « Configuration LLM » du tableau de bord) : endpoint, clé d'API, modèle.
L'endpoint proposé par défaut est `https://llm.lab.sspcloud.fr/api/chat/completions`.
Copier `.env.example` en `.env` si vous souhaitez fixer des valeurs.

## Formats

- **Entrée** : XML Syracuse (`items` / `property`).
- **Sorties** :
  - `export_corrige_*.xml` — notices Syracuse avec corrections appliquées ;
  - `rapport_ecarts.csv` — un écart par ligne, séparateur `;`, encodage UTF‑8 (BOM) ;
  - `export_unimarc_*.txt` — notices UNIMARC en notation texte WINIBW.

## Structure du projet

```
.
├── index.html            # page hôte du front
├── src/                  # front React (Vite + Tailwind)
│   ├── App.tsx           # toute l'interface (4 vues)
│   ├── main.tsx
│   └── index.css
├── server/               # back Express (aucune logique métier dans index.ts)
│   ├── index.ts          # routes HTTP + démarrage
│   ├── sessions.ts       # stockage en mémoire
│   ├── syracuse.ts       # lecture XML Syracuse + tables de correspondance
│   ├── marc.ts           # accès Sudoc (SRU + notice) + parsing UNIMARC
│   ├── compare.ts        # comparaison champ à champ
│   ├── verify.ts         # traitement d'une notice
│   ├── exports.ts        # génération XML / CSV / TXT
│   └── llm.ts            # utilitaire LLM (vedettes RAMEAU)
├── deploy/           # manifestes Kubernetes (YAML bruts pour ArgoCD)
│   ├── deployment.yaml   # lance le conteneur
│   ├── service.yaml      # adresse interne stable
│   └── ingress.yaml      # URL publique HTTPS
├── .github/workflows/    # CI : build image → ghcr.io
│   └── build-push.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Limites connues

- Le traitement des notices est **séquentiel** (avec une pause de 500 ms entre
  chaque, par politesse envers les serveurs de l'ABES) : un gros fichier prend du
  temps.
- Pas de persistance : un redémarrage du serveur efface les sessions en cours.
- La logique de comparaison et de conversion UNIMARC est héritée du POC ; elle doit
  être **validée sur des cas réels** avant un usage en production.

## Déploiement sur le SSP Cloud

Le dossier `deploy/` contient les manifestes Kubernetes bruts (Deployment,
Service, Ingress). Le déploiement se fait via **ArgoCD** (disponible dans le
catalogue Onyxia) selon le principe GitOps : ArgoCD surveille le dépôt Git et
applique automatiquement les changements.

Voir `CLAUDE.md` pour la procédure pas à pas.
