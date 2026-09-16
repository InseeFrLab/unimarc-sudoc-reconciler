# CLAUDE.md — Guide de travail sur ce dépôt

Ce fichier s'adresse à qui reprend le code, humain ou assistant IA. Il décrit
l'architecture, les invariants à respecter et les pièges connus.

**Il ne répète pas le README.** Pour le contexte métier, le démarrage et le
déploiement : [README.md](README.md). Pour les formats, les web services de l'ABES
et les mappings UNIMARC : [docs/metier-unimarc-sudoc.md](docs/metier-unimarc-sudoc.md).

En une phrase : outil interne du Centre de ressources documentaires de l'Insee qui
**fiabilise les notices du SIGB Syracuse en s'appuyant sur le Sudoc (ABES)**, avec
**l'humain dans la boucle** — la machine détecte et propose, la documentaliste
tranche.

## Architecture

- Front **React 19 + Vite + Tailwind** (`src/`), une seule page à 4 vues.
- Back **Express** (`server/`), exécuté par `tsx` (pas d'étape de compilation TS
  côté serveur). En dev, Vite est monté en middleware ; en prod (`NODE_ENV=production`),
  Express sert `dist/`.
- **Aucune base de données.** L'état vit dans une `Map` en mémoire
  (`server/sessions.ts`), indexée par un UUID de session. Volontaire : « un
  fichier en entrée, un fichier en sortie ». Ne pas introduire de persistance sans
  décision explicite.
- **Aucun secret dans le code.** Le LLM (endpoint + clé) se configure via l'UI ; la
  clé n'est ni persistée ni journalisée.

## Carte des modules (backend)

| Module | Responsabilité |
| --- | --- |
| `index.ts` | Couche HTTP uniquement : routes + démarrage. Pas de logique métier. |
| `sessions.ts` | Type `Session` + `Map` en mémoire. |
| `syracuse.ts` | Lecture de l'XML Syracuse, catégorisation A/B, tables `SYRACUSE_MAPPING` et `SYRACUSE_TO_UNIMARC`, `UNMODIFIABLE_FIELDS`. |
| `marc.ts` | Accès Sudoc (recherche SRU, récupération par PPN, gestion des PPN fusionnés) et conversions UNIMARC (→ objet structuré, → texte WINIBW). |
| `compare.ts` | Comparaison champ à champ (seuils de similarité, règles ISBN/EAN/année/titre/éditeur) et `compareNoticeWithSudoc`. |
| `verify.ts` | Traitement d'une notice (A ou B) → objet résultat. |
| `exports.ts` | `buildXmlExport`, `buildCsvExport`, `buildTxtExport`. |
| `llm.ts` | Déduction de l'URL de listing des modèles à partir de l'endpoint de chat. |
| `version.ts` | Version exécutée (SHA gravé dans l'image via `GIT_SHA`), servie par `GET /api/version`. |

Le prompt RAMEAU et l'appel au LLM sont dans `index.ts`, pas dans `llm.ts`.

## Flux de données

`upload` (parse XML → session) → `verify` (boucle sur les notices, appelle
`verifyNotice`, met à jour `progress`) → le front **interroge `api/status` en
polling** → `DASHBOARD` (résultats + résumé) → `DETAIL` (actions sur les écarts,
rattachement, RAMEAU) → `export` (XML/CSV/TXT construits depuis la session).

## Invariants métier — À NE PAS casser

Ces règles encodent du savoir bibliothéconomique repris du POC. Les modifier sans
validation d'un·e documentaliste = risque de dégrader les notices. Détail et
justification : [docs/metier-unimarc-sudoc.md](docs/metier-unimarc-sudoc.md).

- **Catégorie A vs B** (`detectCategory`) : A si le `Filtre` contient « SUDOC » ou
  si l'identifiant d'origine correspond à `^[0-9]{8}[0-9X]$`, sinon B.
- **PPN sur 9 caractères** : `padPpn` partout, affichages comme appels backend.
  Sans ça, l'API Sudoc renvoie 404.
- **`SUDOC_PARSER_OPTIONS` avec `parseTagValue: false`** pour tout XML du Sudoc :
  sinon `fast-xml-parser` transforme `026927438` en nombre et détruit le zéro
  initial des PPN (zone 001) et des IdRef (`$3`). Même raison côté Syracuse avec
  `parseAttributeValue: false`.
- **Libellés de champs Syracuse tels quels**, fautes internes comprises
  (`Auteur secondaire- Collectivité` sans espace avant le tiret,
  `Nom - Responsabiblité`). Ce sont les clés de `SYRACUSE_MAPPING`.
  **Exception : les espaces de bord.** Le XML porte
  `name="Auteur principal - Collectivité "` avec un espace final, mais
  `fast-xml-parser` trime les valeurs d'attributs — et le nom d'un champ est
  lui-même une valeur d'attribut. Le libellé arrive donc **sans** cet espace :
  les clés des tables et toute lecture directe (`buildSruQuery`) doivent utiliser
  la forme trimée, sinon le mapping n'est jamais atteint.
- **Zones UNIMARC** mappées dans `parseSudocRecord` (200 titre, 010 ISBN, 214/210
  éditeur, 215 collation, 225 collection, 330 résumé, 327 TdM, 700/701/702 et
  710/711/712 auteurs, 600/601/606/607/608 vedettes, 300-305 notes).
- **Décodage de la zone 100** (dates de publication) dans `unimarcXmlToText` :
  conversion UNIMARC standard → format Sudoc, très spécifique, à laisser tel quel.
- **Suffixe ` rameau`** ajouté aux vedettes : convention Syracuse attendue.
- **Seuils de comparaison** (`compare.ts`) : titre et champs génériques, > 0.9 ⇒
  `DIFFERENCE_MINEURE` ; `Editeur`, > 0.85 ⇒ `IDENTIQUE` et > 0.5 ⇒
  `DIFFERENCE_MINEURE` ; règles particulières ISBN (sans tirets), EAN (sans
  espaces), année (4 chiffres).
- **Pause de 500 ms** entre deux notices dans la boucle de `verify` : politesse
  envers les serveurs de l'ABES, ne pas retirer.
- **Endpoints ABES** : SRU `https://www.sudoc.abes.fr/cbs/sru/…` ; notice
  `https://www.sudoc.fr/{PPN}.xml` ; fusion `…/services/merged/{PPN}`.
- **Filtrage à l'export TXT** : `HOLDINGS_TAGS` (zones d'exemplaires 915…999) et
  `EXCLUDED_TAGS` (zones techniques + leader 000 et zone 008, volontairement hors
  export : la notice existe déjà dans WINIBW). Retirer un tag de ces listes fait
  apparaître du bruit dans le fichier à coller.
- **Indicateurs UNIMARC sur deux caractères**, `#` pour un espace. Le parseur XML
  trime les attributs : `ind1=" "` arrive vide, il faut donc tester la chaîne vide
  et pas seulement `' '`. Sinon les lignes sortent en `010 $a…`.
- **Pseudo-champs** (`PSEUDO_UNIMARC_FIELDS`, aujourd'hui `Type de support (183)`) :
  ils circulent dans les écarts mais ne doivent JAMAIS devenir une `<property>` du
  XML Syracuse, sous peine de casser le réimport.

## Conventions

- Commentaires et libellés d'interface **en français**. Chaque module porte un
  commentaire d'en-tête expliquant son rôle ; le conserver à jour.
- `server/index.ts` reste une couche HTTP : toute logique nouvelle va dans un module
  dédié.
- **Chemins d'API relatifs** dans le front (`api/upload`, pas `/api/upload`) — voir
  les pièges ci-dessous.
- `identifiant` (identifiant Syracuse) est la **clé stable** d'une notice : c'est
  lui qu'il faut passer aux routes par notice, jamais le PPN, qui change lors d'un
  rattachement SRU.
- Après modification : `npm test && npm run typecheck && npm run build`.
  Les tests (`node:test` + `tsx`, aucun accès réseau) couvrent `marc.ts`,
  `compare.ts`, `syracuse.ts` et `exports.ts` à partir de notices figées dans
  `test/fixtures/`. Toute règle métier touchée doit y gagner un cas.
- Une recette manuelle reste nécessaire pour l'interface et les appels réseau
  réels (voir README).
- **Image déployée épinglée par SHA de commit** dans `deploy/deployment.yaml`, pas
  `:latest`. ArgoCD compare le texte des manifestes : avec un tag mouvant il ne
  voit jamais rien changer, et la nouvelle image n'est jamais déployée. Mettre en
  production = reporter le SHA dans ce fichier et pousser. Ne pas revenir à un tag
  mouvant ; procédure détaillée dans le [README](README.md#mettre-en-production-une-nouvelle-version).
- **Vérifier un déploiement** : `./scripts/verifier-deploiement.sh` (droits de
  lecture suffisants). La preuve directe est `GET /api/version`, qui renvoie le SHA
  gravé dans l'image. Si la chaîne `build-args: GIT_SHA` → `ARG`/`ENV` du
  `Dockerfile` → `server/version.ts` est rompue, la route répond
  `"source": "inconnu"` et la vérification perd sa valeur.
- Pour comprendre la chaîne de déploiement de bout en bout (image, tag, registre,
  manifeste, pod, ArgoCD), voir [apprendre.md](apprendre.md) — écrit pour un
  public non spécialiste.

## Pièges connus

Corrections déjà appliquées, à ne pas défaire :

- **`base: './'`** dans `vite.config.ts` : indispensable pour que les assets
  (JS, CSS) se chargent derrière un proxy (SSP Cloud, port forwarding VSCode).
  Sans ça → page blanche. **Ne vaut que pour `vite build`** : le serveur de dev
  ramène toute base relative à `/`, donc `npm run dev` est inutilisable derrière
  un proxy à préfixe — c'est `npm run start` qu'il faut lancer. Explication
  complète côté humain dans le [README](README.md#derrière-un-proxy-ssp-cloud-code-server).
- **Chemins API relatifs** dans `src/App.tsx` : `api/upload` et non `/api/upload`.
  Même raison : un chemin absolu ne passe pas si l'appli est servie derrière un
  sous-chemin de proxy. Appliqué à tous les `fetch()`.
- **`allowedHosts: ['.lab.sspcloud.fr']`** dans `vite.config.ts` : autorise le
  serveur de développement Vite à répondre aux URL du SSP Cloud. Sans effet en
  production.
- **`temperature: 0`** sur l'appel LLM RAMEAU (dans `server/index.ts`) : maximise la
  reproductibilité de la seule brique non déterministe.
- **Export XML** : itérer sur `session.notices`, pas sur
  `session.parsedXml.items.item` (source d'un bug d'export vide).
- **Colonne « Syracuse » du tableau des candidats** (catégorie B) : un résultat de
  vérification ne transporte **pas** le tableau `properties`, seulement la table
  plate `syracuse` (libellé Syracuse → valeur). `getAllSyrProps` dans
  `src/App.tsx` doit donc lire cette table ; la chercher par clés internes
  (`editeur`, `annee`…), qui n'existent que côté Sudoc, ne remontait que le titre.

Incohérences résiduelles, non corrigées, à connaître avant de toucher au code :

- Trois routes déclarent un paramètre `:ppn` alors qu'elles reçoivent un
  `identifiant` (`suggest-keywords`, `update-ai-suggestions`, `add-keyword`). Le
  comportement est correct, le nommage trompeur.
- `ABSENT_SUDOC` a deux sens : « champ vide côté Sudoc » pour un écart, « notice
  PMB introuvable » pour une notice. Le front les distingue en testant
  `categorie === 'B'`. Fragile.
- Seul `Session` est typé ; `notices`, `results` et `ecarts` sont des `any[]`.

## Pistes d'amélioration

- **Fixtures issues de vraies notices.** `test/fixtures/` contient des notices
  écrites à la main d'après la structure réelle. Y figer de véritables réponses du
  Sudoc (une par cas tordu) augmenterait nettement la valeur des tests.
- **Compléter `ILLUSTRATION_TERMS`** au vu de collations réelles : une mention hors
  vocabulaire n'est pas fusionnée.
- **Découper `src/App.tsx`** (~575 lignes d'un seul tenant) en composants par vue
  (`UploadView`, `DashboardView`, `DetailView`…) et extraire les constantes
  partagées. Report volontaire : le faire sans recette navigateur risquait
  d'introduire des régressions.
- **Parallélisme borné** et reprise sur erreur pour les gros volumes, en respectant
  la politesse envers l'ABES.
- **Typer `Notice`, `Result`, `Ecart`** : les définitions existent dans le document
  de conception archivé, il suffit de les transcrire.
- **Diacritiques sur le titre** : seuls `Editeur` et les auteurs en bénéficient.
