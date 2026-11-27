# Spécification — Refonte simplifiée du vérificateur Syracuse ⇄ Sudoc

Nov 27, 2026 · @Mélina

## 0. Mode d'emploi pour Claude Code

Ce document est la spécification de référence de la refonte du dépôt `InseeFrLab/unimarc-sudoc-reconciler`. Il remplace l'application TypeScript (Express + React) par une application Python unique (FastAPI + gabarits HTML + HTMX), avec les mêmes fonctionnalités. Il s'adresse à un agent de code : chaque exigence est vérifiable, chaque phase se termine par des critères d'acceptation.

Règles de travail, à respecter pendant toute la refonte :

- **Travailler phase par phase** (section 13), dans l'ordre. Ne pas commencer une phase tant que les critères de la précédente ne sont pas tous verts.
- **Une branche par phase** (`refonte/phase-N`), une merge request par phase. Ne jamais pousser sur `main`, ne jamais fusionner soi-même.
- **Ne rien inventer en matière de règles métier.** Toute règle bibliothéconomique vient du code TypeScript existant, de `CLAUDE.md` ou de `docs/metier-unimarc-sudoc.md`. En cas de doute ou de contradiction, s'arrêter et poser la question, ne pas trancher.
- **Conserver le comportement, pas forcément le code.** Les anomalies listées en section 4.6 sont les seules corrections de comportement autorisées.
- **Langue** : commentaires, docstrings, libellés d'interface, messages d'erreur et documentation en français. Identifiants de code en français quand ils désignent des notions métier (`notice`, `ecart`, `rattacher`), en anglais pour le vocabulaire technique standard.
- **Avant chaque commit** : `uv run ruff format . && uv run ruff check . && uv run pytest -q`. Rien n'est commité si une commande échoue.
- **Aucun accès réseau dans les tests.** Les appels au Sudoc et au LLM sont simulés.
- **Aucun secret, aucune donnée réelle** dans le dépôt (règles des skills `onyxia-security-audit` et `git-workflow-ds` d'opencode-onyxia).
- L'ancien code TypeScript reste en place jusqu'à la phase 6 : il sert de référence pour générer les sorties attendues (section 10).

## 1. Contexte, objectifs et contraintes

L'application compare les notices du SIGB Syracuse au catalogue Sudoc de l'ABES, propose des corrections et laisse la documentaliste trancher. Elle fonctionne (version 1.4.0), mais repose sur deux écosystèmes JavaScript que peu de personnes à l'Insee savent maintenir.

État actuel mesuré :

| Élément | Aujourd'hui | Cible |
| --- | --- | --- |
| Langages | TypeScript (serveur et front), TSX, Tailwind | Python + HTML (Jinja) + CSS |
| Code applicatif | \~2 000 lignes serveur + \~660 lignes `App.tsx` (25 états React) | Modules métier Python + 5 pages et quelques fragments HTML |
| Dépendances | 14 dépendances npm + 8 de développement | \~6 dépendances Python |
| Étape de compilation | `vite build` obligatoire | Aucune |
| Mode développement derrière le proxy SSP Cloud | Cassé (page blanche) | Fonctionnel via `ROOT_PATH` |
| Déploiement | Image `:latest`, *Restart* manuel, pas de retour arrière | Image taguée par SHA, mise à jour par merge request, ArgoCD synchronise |
| Tests | 133 cas `node:test` | Les mêmes cas en pytest + tests de non-régression contre l'ancienne version |

Objectifs, par ordre de priorité :

1. **Parité fonctionnelle** : tout ce que la section 2 décrit fonctionne comme avant.
2. **Auditabilité** : un data scientist Python de l'Insee comprend le code métier sans connaître de framework web.
3. **Simplicité de maintenance** : un seul langage, aucune étape de compilation, aucun JavaScript écrit à la main.
4. **Déploiement standard SSP Cloud** : conforme aux skills `onyxia-reproducibility`, `argo-mlops` et `python-datascience` d'opencode-onyxia.

Contraintes non négociables :

- **Pas de base de données, pas de S3 pour l'instant** : l'état reste en mémoire (aucun compte de service n'est disponible). Le stockage est isolé derrière une interface pour pouvoir brancher S3 plus tard (section 7).
- **Un seul processus, une seule réplique** : conséquence directe du stockage en mémoire.
- **Politesse envers l'ABES** : 500 ms minimum entre deux notices, aucune parallélisation des appels au Sudoc.
- **L'humain tranche** : aucune correction n'est appliquée sans action de la documentaliste, hors normalisations de forme existantes.

## 2. Inventaire fonctionnel à conserver

Chaque ligne est une fonctionnalité de la version 1.4.0 qui doit exister à l'identique dans la cible. La recette manuelle de la phase 5 reprend cette liste case par case.

### 2.1 Dépôt et vérification

- [ ] Dépôt d'un export XML Syracuse (structure `items` / `property`), 50 Mo maximum. Message d'erreur si aucun fichier ou aucune notice valide.
- [ ] Affichage après dépôt : nombre total de notices, nombre en catégorie A, nombre en catégorie B.
- [ ] Lancement de la vérification en tâche de fond ; refus si une vérification est déjà en cours sur la session.
- [ ] Page de progression : notice courante / total, PPN ou identifiant en cours, rafraîchie chaque seconde, bascule automatique vers le tableau de bord à la fin, message en cas d'erreur globale.

### 2.2 Tableau de bord

- [ ] Cartes de synthèse : total, valides (OK + RATTACHE\_SRU + VALIDE), erreurs, compléments, mineures, non trouvées, PMB en attente de rattachement, absentes.
- [ ] Graphique « Champs impactés » : nombre d'écarts ERREUR, MANQUANT\_SYRACUSE ou DIFFERENCE\_MINEURE par champ.
- [ ] Filtre de la liste : Toutes, Erreurs, Compléments, Valides, Non trouvés, PMB en attente, Absentes (mêmes règles que `App.tsx` lignes 299-304).
- [ ] Liste des notices : icône de statut, cellule PPN (lien Sudoc, ou « PMB:identifiant », ou badge SRU si rattachée), titre tronqué à 60 caractères, identifiant Syracuse, compteurs err/comp/min, lien « Voir détail ».
- [ ] Exports : XML Syracuse corrigé, texte UNIMARC (WINIBW), rapport CSV des écarts.
- [ ] « Nouveau fichier » avec confirmation proposant d'exporter avant de quitter la session.

### 2.3 Détail d'une notice

- [ ] En-tête : titre, PPN (lien `https://www.sudoc.fr/{PPN}` et lien XML), identifiant Syracuse ; navigation notice précédente / suivante ; retour au tableau de bord.
- [ ] Boutons « Tout accepter » et « Tout rejeter » (actions groupées sur la notice ; règle spéciale catégorie B, section 4.4).
- [ ] Tableau des écarts : champ, valeur Syracuse, valeur Sudoc, statut, actions. Rendu spécifique des statuts NORMALISE (valeur Syracuse barrée), GENERE\_AUTO (« Généré : »), FUSION, et des valeurs modifiées.
- [ ] Actions par écart pour les statuts ERREUR, MANQUANT\_SYRACUSE, DIFFERENCE\_MINEURE, NORMALISE, GENERE\_AUTO, FUSION : Accepter, Conserver, Modifier (saisie libre préremplie avec la valeur Sudoc).
- [ ] Case « afficher les champs identiques » (masque par défaut IDENTIQUE, NON\_VERIFIE, ABSENT\_SUDOC).
- [ ] Bouton « Valider la notice » / « Notice validée » (bascule, section 4.4).
- [ ] Liens bas de page : tableau de bord, notice suivante (désactivé sur la dernière).

### 2.4 Catégorie B (notices PMB sans PPN)

- [ ] Récapitulatif « Votre notice Syracuse (PMB) — champs renseignés » (hors `UNMODIFIABLE_FIELDS`).
- [ ] Liste des candidats trouvés (piste PPN tronqué + recherche SRU), avec comparaison côte à côte Syracuse / Sudoc et bouton « Rattacher » / « Sélectionner ».
- [ ] « Recherche approfondie » : passe la notice en recherche manuelle (comportement actuel : statut ABSENT\_SUDOC, écarts vidés).
- [ ] Recherche manuelle par PPN connu (« Récupérer la notice ») ou par titre / auteur / année (« Rechercher des candidats »), avec message si aucun résultat.
- [ ] Rattachement d'un PPN : récupération de la notice Sudoc, recalcul des écarts, report du PPN dans l'« Identifiant d'origine » de la notice source.
- [ ] Après rattachement : tableau « Comparaison complète des champs » avec actions.

### 2.5 Suggestions RAMEAU (facultatif)

- [ ] Configuration : endpoint compatible OpenAI, clé d'API, choix du modèle dans la liste renvoyée par l'endpoint, bouton « Tester ».
- [ ] Génération de 3 à 6 vedettes à partir du titre, de l'éditeur, de la collection, du résumé, de la table des matières et des vedettes existantes.
- [ ] Liste des suggestions : cocher, modifier le texte, supprimer ; ajout d'une vedette au champ « Vedette matière - Nom commun » avec le suffixe `  rameau `.

### 2.6 Exploitation

- [ ] `GET /api/version` renvoie le SHA du commit gravé dans l'image (compatibilité avec `scripts/verifier-deploiement.sh`).

## 3. Pile technique et arborescence

La cible est une seule application Python, servie par un seul processus uvicorn. Le serveur produit directement le HTML ; HTMX (un fichier JavaScript vendu tel quel, jamais modifié) remplace des morceaux de page sans rechargement.

### 3.1 Dépendances autorisées

| Rôle | Bibliothèque | Remplace |
| --- | --- | --- |
| Serveur web | `fastapi`, `uvicorn` | Express, tsx |
| Gabarits HTML | `jinja2` | React, TSX |
| Dépôt de fichier | `python-multipart` | multer |
| Appels HTTP (Sudoc, LLM) | `httpx` | axios |
| Lecture XML | `lxml` | fast-xml-parser |
| Interactivité | `htmx.min.js` 2.0.x, copié dans `app/static/` | React, lucide-react |
| Style | `pico.min.css` 2.x, copié dans `app/static/`, + `app.css` (< 150 lignes) | Tailwind |
| Développement | `ruff`, `pytest` | TypeScript, node:test |

Règles :

- **Aucune autre dépendance** sans accord explicite. En particulier : pas de `rapidfuzz` ni d'équivalent (la similarité doit reproduire exactement `string-similarity`, section 4.3), pas de bibliothèque de graphiques, pas de framework CSS à compilation.
- **Aucun CDN** : HTMX et Pico sont copiés dans le dépôt, avec leur numéro de version dans le nom de fichier (`htmx-2.0.4.min.js`). L'application doit fonctionner sans accès Internet côté navigateur.
- **Aucun JavaScript écrit à la main**, sauf une exception tolérée de moins de 10 lignes, à justifier en commentaire.
- Python 3.12, projet géré par `uv` (`pyproject.toml` + `uv.lock` commités), conformément au skill `python-datascience`.

### 3.2 Arborescence cible

```
unimarc-sudoc-reconciler/
├── pyproject.toml
├── uv.lock
├── app/
│   ├── __init__.py
│   ├── main.py              # création de l'app FastAPI, montage static, ROOT_PATH
│   ├── config.py            # lecture des variables d'environnement (section 9)
│   ├── version.py           # SHA gravé dans l'image
│   ├── metier/              # cœur métier : aucune dépendance à FastAPI ni à Jinja
│   │   ├── __init__.py
│   │   ├── modeles.py       # dataclasses Notice, Ecart, Resultat, Candidat + énumérations
│   │   ├── syracuse.py      # lecture XML Syracuse, catégories, tables de correspondance
│   │   ├── sudoc.py         # accès réseau ABES : notice, SRU, isbn2ppn, ean2ppn, fusion
│   │   ├── unimarc.py       # parsing des notices Sudoc, conversion texte WINIBW
│   │   ├── similarite.py    # coefficient de Dice (portage exact de string-similarity)
│   │   ├── comparaison.py   # comparaison champ à champ, statuts
│   │   ├── verification.py  # traitement d'une notice A ou B
│   │   ├── decisions.py     # actions de la documentaliste (accepter, rattacher, valider…)
│   │   ├── exports.py       # XML Syracuse, CSV, TXT UNIMARC
│   │   └── rameau.py        # prompt, appel LLM, nettoyage des suggestions
│   ├── sessions.py          # interface de stockage + implémentation mémoire (section 7)
│   ├── taches.py            # boucle de vérification en tâche de fond
│   ├── web.py               # routes : aiguillage uniquement, aucune règle métier
│   ├── templates/           # pages et fragments Jinja (section 5)
│   └── static/              # htmx, pico, app.css
├── tests/
│   ├── fixtures/            # notices XML (reprises de test/fixtures/)
│   ├── reference/           # sorties attendues générées depuis la version TS (section 10)
│   ├── test_syracuse.py
│   ├── test_unimarc.py
│   ├── test_similarite.py
│   ├── test_comparaison.py
│   ├── test_verification.py
│   ├── test_decisions.py
│   ├── test_exports.py
│   ├── test_rameau.py
│   └── test_web.py
├── deploy/                  # manifestes Kubernetes + kustomization.yaml (section 11)
├── application.yaml         # ressource ArgoCD (conservée)
├── scripts/verifier-deploiement.sh
├── Dockerfile
├── .github/workflows/ci.yml
├── AGENTS.md                # remplace CLAUDE.md (section 12)
├── README.md
└── docs/
    ├── metier-unimarc-sudoc.md   # conservé tel quel
    ├── apprendre.md              # déplacé depuis la racine, mis à jour
    └── historique-conception.md  # conservé
```

Règle d'or des dépendances internes : `metier/` n'importe rien de `web.py`, `sessions.py`, `taches.py` ni de FastAPI. `web.py` n'importe que `metier/`, `sessions.py`, `taches.py` et `config.py`. Un test vérifie cette règle (section 10).

## 4. Portage du cœur métier en Python

Le cœur métier est porté fonction par fonction, sans réinterprétation. Chaque fonction Python porte en docstring le nom de la fonction TypeScript d'origine (`Portage de marc.ts:parseSudocRecord`), pour que la relecture puisse comparer les deux.

### 4.1 Correspondance des modules

| TypeScript (source) | Python (cible) | Contenu |
| --- | --- | --- |
| `syracuse.ts` | `metier/syracuse.py` | `detect_category`, `parse_syracuse_notices`, `SYRACUSE_MAPPING`, `SYRACUSE_TO_UNIMARC`, `UNMODIFIABLE_FIELDS`, `CHAMP_TYPE_SUPPORT`, `LIGNE_183_DEFAUT`, `PSEUDO_UNIMARC_FIELDS` |
| `marc.ts` (accès réseau) | `metier/sudoc.py` | `fetch_sudoc_record`, `search_sru`, `ppn_from_isbn`, `ppn_from_ean`, `parse_ppn2_response`, gestion des PPN fusionnés, `SUDOC_BASE_URL` |
| `marc.ts` (conversions) | `metier/unimarc.py` | `pad_ppn`, `is_ppn`, `looks_like_truncated_ppn`, `STOP_WORDS`, `normalize_description`, `generate_ean_from_isbn`, `ILLUSTRATION_TERMS`, `extract_illustration_mentions`, `build_fused_collation`, `parse_sudoc_record`, `parse_sudoc_xml`, `parse_sru_response`, `mots_titre_sru`, `nom_auteur_sru`, `annee_sru`, `build_sru_query`, `EXCLUDED_TAGS`, `HOLDINGS_TAGS`, `unimarc_xml_to_text` |
| `string-similarity` (npm) | `metier/similarite.py` | `compare_two_strings` (section 4.3) |
| `compare.ts` | `metier/comparaison.py` | `normalize_string`, `remove_accents`, `extract_idrefs`, `is_author_field`, `compare_fields`, `compare_notice_with_sudoc` |
| `verify.ts` | `metier/verification.py` | `verify_notice`, `retrouver_par_isbn_ou_ean` |
| routes de `index.ts` (logique) | `metier/decisions.py` | `appliquer_action`, `action_groupee`, `basculer_validation`, `rattacher`, `passer_en_recherche_manuelle`, `ajouter_vedette`, `resume_session` |
| `exports.ts` | `metier/exports.py` | `build_xml_export`, `build_csv_export`, `build_txt_export` |
| prompt et parsing dans `index.ts`, `llm.ts` | `metier/rameau.py` | `construire_prompt`, `nettoyer_suggestions`, `models_url`, appels HTTP |
| `sessions.ts` | `sessions.py` | section 7 |
| boucle de `/api/verify` | `taches.py` | section 7 |

Les fonctions réseau de `sudoc.py` et `rameau.py` reçoivent un `httpx.Client` en paramètre (injection de dépendance) : les tests leur passent un client construit sur `httpx.MockTransport`, sans aucune autre bibliothèque.

### 4.2 Modèles de données

Le code TypeScript manipule des `any`. La cible type tout avec des `dataclasses` (pas de Pydantic, inutile ici) dans `metier/modeles.py` :

- `Notice` : `identifiant`, `ppn`, `titre`, `categorie` (`"A"`/`"B"`), `syracuse` (dict libellé → valeur), `properties` (liste ordonnée de couples `(nom, valeur)`, l'ordre du fichier source est conservé), `item_type`.
- `Ecart` : `champ`, `valeur_syracuse`, `valeur_sudoc`, `statut`, `action`, `valeur_modifiee` (optionnel), `unimarc` (optionnel : `tag` + sous-zones).
- `Candidat` : `ppn`, données Sudoc parsées, `origine_piste` (optionnel).
- `Resultat` : `identifiant`, `ppn`, `titre`, `categorie`, `syracuse`, `sudoc`, `sudoc_xml`, `statut_global`, `nb_erreurs`, `nb_complements`, `nb_mineures`, `ecarts`, `candidats`, `ppn_source_secours`, `ppn_origine`, `suggestions_ia`.
- Énumérations (`enum.StrEnum`), avec les valeurs texte actuelles, inchangées, car elles apparaissent dans le CSV :
  - `StatutEcart` : IDENTIQUE, DIFFERENCE\_MINEURE, ERREUR, MANQUANT\_SYRACUSE, ABSENT\_SUDOC, NON\_VERIFIE, NORMALISE, GENERE\_AUTO, FUSION, MODIFIE.
  - `StatutNotice` : OK, MINEURE, COMPLEMENT, ERREUR, NON\_TROUVE, EN\_ATTENTE\_RATTACHEMENT, ABSENT\_SUDOC, RATTACHE\_SRU, VALIDE.
  - `Action` : ACCEPTER, CONSERVER, MODIFIER.

La donnée Sudoc parsée (`parse_sudoc_record`) reste un dict à clés fixes (`titre`, `auteurPrincipal`, `editeur`…), car ses clés sont les valeurs de `SYRACUSE_MAPPING`. Ne pas renommer ces clés.

### 4.3 Similarité de chaînes : portage exact

Les seuils 0,9 / 0,85 / 0,5 de `compare.ts` ont été calibrés sur le coefficient de Dice de la bibliothèque npm `string-similarity` (v4). Une autre mesure (Levenshtein, `rapidfuzz`, `difflib`) changerait les statuts. `similarite.compare_two_strings(a, b)` doit reproduire exactement l'algorithme :

1. Retirer tous les blancs des deux chaînes (`re.sub(r"\s+", "", s)`).
2. Si les chaînes sont égales : 1,0. Si l'une fait moins de 2 caractères : 0,0.
3. Compter les bigrammes (paires de caractères consécutifs) de la première chaîne, avec multiplicité.
4. Parcourir les bigrammes de la seconde : chaque bigramme présent avec un compte > 0 incrémente l'intersection et décrémente le compte.
5. Résultat : `2 × intersection / (len(a) + len(b) − 2)`.

Un test compare la fonction à au moins 30 paires de référence calculées par la bibliothèque npm d'origine (section 10).

### 4.4 Règles des actions de la documentaliste

Ces règles sont aujourd'hui dans les routes d'`index.ts`. Elles passent dans `metier/decisions.py`, en fonctions pures qui modifient un `Resultat` (et la `Notice` source quand c'est indiqué).

- **`appliquer_action(resultat, champ, action, valeur_modifiee)`** : si aucun écart n'existe pour ce champ, en créer un avec `valeur_syracuse=""`, `valeur_sudoc` = valeur Sudoc mappée via `SYRACUSE_MAPPING` (ou vide), `statut=MODIFIE`. Fixer l'action ; si MODIFIER, enregistrer la valeur.
- **`action_groupee(session, action, identifiant=None)`** : ACCEPTER\_ERREURS (ERREUR → ACCEPTER), ACCEPTER\_COMPLEMENTS (MANQUANT\_SYRACUSE → ACCEPTER), TOUT\_ACCEPTER (ERREUR, MANQUANT\_SYRACUSE, DIFFERENCE\_MINEURE → ACCEPTER), TOUT\_REJETER (tout → CONSERVER). Sans identifiant : toutes les notices. **Cas particulier** : catégorie B + TOUT\_ACCEPTER + données Sudoc présentes → pour chaque clé Sudoc non vide (hors `ppn`, `recordData`, `raw`, `hasTypeSupport`, `eanGenerated`, `collation215`) qui a un libellé Syracuse dans `SYRACUSE_MAPPING` (premier libellé trouvé), créer ou passer l'écart à ACCEPTER ; puis passer tous les écarts à ACCEPTER.
- **`basculer_validation(resultat)`** : si le statut n'est pas VALIDE → VALIDE. S'il est VALIDE : catégorie B → RATTACHE\_SRU ; catégorie A → ERREUR si `nb_erreurs > 0`, sinon COMPLEMENT si `nb_complements > 0`, sinon MINEURE si `nb_mineures > 0`, sinon OK (voir anomalie A1).
- **`rattacher(session, identifiant, ppn, client)`** : `pad_ppn`, récupération de la notice (erreur si absente), mise à jour du `Resultat` (ppn, `syracuse["Identifiant d'origine"]`, sudoc, sudoc\_xml, statut RATTACHE\_SRU), **report du PPN dans la `Notice` source** (ppn, dict `syracuse`, propriété `Identifiant d'origine`), puis recalcul des écarts avec `compare_notice_with_sudoc` sur les propriétés de la notice source.
- **`passer_en_recherche_manuelle(resultat)`** : statut ABSENT\_SUDOC, écarts vidés (comportement actuel du bouton « Recherche approfondie »).
- **`ajouter_vedette(resultat, texte)`** : valeur courante du champ `Vedette matière - Nom commun` (valeur Sudoc si ACCEPTER, valeur modifiée si MODIFIER, sinon valeur Syracuse), ajout de `texte.strip() + " rameau"`, séparateur `"; "`, action MODIFIER.
- **`resume_session(session)`** : mêmes compteurs et même `fieldsStats` que la route `/summary`.

La notice est toujours désignée par son **`identifiant` Syracuse**, jamais par son PPN (qui change lors d'un rattachement).

### 4.5 Invariants à préserver (repris de `CLAUDE.md`)

- **PPN sur 9 caractères** : `pad_ppn` partout, sinon l'API Sudoc renvoie 404.
- **Pas de conversion de type à la lecture XML.** Avec `lxml`, les valeurs restent des chaînes : le risque de perte du zéro initial disparaît, mais aucun code ne doit appeler `int()` sur un PPN ou un IdRef.
- **Espaces de bord des attributs.** fast-xml-parser trimait les valeurs d'attributs ; lxml ne le fait pas. Il faut donc appliquer explicitement `.strip()` au **nom** et à la **valeur** de chaque `property` Syracuse et des attributs des notices Sudoc. Sans cela, ` Auteur principal - Collectivité  ` (espace final) ne correspond plus à sa clé dans `SYRACUSE_MAPPING`, et les indicateurs `ind1=" "` ne sont plus vides.
- **Libellés Syracuse tels quels**, fautes comprises (`Auteur secondaire- Collectivité`, `Nom - Responsabiblité`).
- **Zones UNIMARC** mappées dans `parse_sudoc_record` : 200, 010, 214/210, 215, 225, 330, 327, 700/701/702, 710/711/712, 600/601/606/607/608, 300-305.
- **Décodage de la zone 100** dans `unimarc_xml_to_text` : porté ligne à ligne, sans simplification.
- **Suffixe `  rameau `** sur les vedettes ajoutées.
- **Seuils** : titre et champs génériques > 0,9 ⇒ DIFFERENCE\_MINEURE (titre : aussi si l'une contient l'autre) ; `Editeur` > 0,85 ⇒ IDENTIQUE, > 0,5 ⇒ DIFFERENCE\_MINEURE ; ISBN sans tirets ; EAN sans espaces ; année sur 4 chiffres ; auteurs : l'IdRef fait foi.
- **Normalisation** (`normalize_string`) : minuscules, `;` et `:` → espace, apostrophes typographiques → `'`, espace insécable → espace, blancs multiples réduits, trim. `remove_accents` : décomposition NFD puis suppression des diacritiques combinants (U+0300 à U+036F).
- **Pause de 500 ms** entre deux notices.
- **Endpoints ABES** : SRU `https://www.sudoc.abes.fr/cbs/sru/…`, notice `https://www.sudoc.fr/{PPN}.xml`, fusion `…/services/merged/{PPN}` (URL exactes reprises de `marc.ts`).
- **Export TXT** : `HOLDINGS_TAGS` et `EXCLUDED_TAGS` filtrés ; indicateurs sur deux caractères, `#` pour un espace ou une chaîne vide.
- **Pseudo-champs** (`Type de support (183)`) : jamais écrits comme `<property>` dans le XML Syracuse.
- **Export XML** : construit à partir des notices de la session (pas d'un arbre XML conservé), en respectant l'ordre des propriétés du fichier source.
- **Ordre des pistes** en catégorie A : PPN, puis isbn2ppn, puis ean2ppn. En catégorie B : PPN tronqué paddé, puis SRU ; une erreur SRU n'est fatale que si aucun candidat n'a été trouvé.
- **Température 0** pour l'appel RAMEAU.

### 4.6 Anomalies existantes : corrections autorisées

Ce sont les seules modifications de comportement permises. Chacune est un commit séparé avec un test qui la démontre.

- **A1 — Statut incohérent après dévalidation.** La route `/valider` remet `DIFFERENCE_MINEURE` comme statut de notice, alors que la vérification et le résumé utilisent `MINEURE`. Une notice dévalidée disparaît donc du compteur « mineures ». Correction : utiliser `MINEURE`.
- **A2 — Paramètres mal nommés.** Trois routes nomment `:ppn` un identifiant Syracuse. Disparaît de fait avec les nouvelles routes (section 6).
- **A3 — Double sens d'ABSENT\_SUDOC.** Le statut d'écart (« champ vide côté Sudoc ») et le statut de notice (« PMB introuvable ») partagent la même valeur. Les deux énumérations séparées de la section 4.2 lèvent l'ambiguïté dans le code ; les valeurs texte restent identiques.
- **A4 — Recherche approfondie.** Le bouton passe la notice en ABSENT\_SUDOC pour afficher le panneau de recherche manuelle. Le comportement est conservé (A4 n'est **pas** corrigée), mais la fonction porte un nom explicite (`passer_en_recherche_manuelle`) et un commentaire signale le couplage. À rediscuter avec la documentaliste (section 14).

## 5. Frontend simplifié : Jinja + HTMX

Le front React disparaît entièrement. Le serveur renvoie du HTML : une page complète quand on navigue, un fragment quand une action ne modifie qu'une partie de l'écran. HTMX, déclaré par quelques attributs dans le HTML, envoie la requête et remplace le fragment. Il n'y a plus d'état côté navigateur : la vérité est dans la session, côté serveur.

### 5.1 Principe, illustré sur une action d'écart

Aujourd'hui, accepter un écart passe par un `fetch` JSON, puis par une recopie manuelle de l'état dans React (`App.tsx`, `handleAction`, \~20 lignes). Dans la cible, la ligne du tableau se décrit elle-même :

```html
<!-- templates/_ligne_ecart.html -->
<tr id="ecart-{{ loop_id }}" class="statut-{{ e.statut | lower }}">
  <td>{{ e.champ }}</td>
  <td>{{ e.valeur_syracuse or "vide" }}</td>
  <td>{{ e.valeur_modifiee if e.action == "MODIFIER" else (e.valeur_sudoc or "vide") }}</td>
  <td>{{ e.statut | libelle_statut }}</td>
  <td>
    <form hx-post="{{ url_for('action_ecart', sid=sid, identifiant=r.identifiant) }}"
          hx-target="closest tr" hx-swap="outerHTML">
      <input type="hidden" name="champ" value="{{ e.champ }}">
      <button name="action" value="ACCEPTER" {% if e.action == "ACCEPTER" %}aria-pressed="true"{% endif %}>Accepter</button>
      <button name="action" value="CONSERVER" {% if e.action == "CONSERVER" %}aria-pressed="true"{% endif %}>Conserver</button>
    </form>
  </td>
</tr>
```

La route applique la décision, puis renvoie ce même fragment rendu à nouveau. Aucun code JavaScript n'est écrit.

### 5.2 Pages et fragments

| Gabarit | Type | Contenu |
| --- | --- | --- |
| `base.html` | Gabarit parent | En-tête « Syracuse ⇄ Sudoc », lien tableau de bord, inclusion de `pico`, `app.css`, `htmx` |
| `accueil.html` | Page | Titre, formulaire de dépôt (`multipart`), message d'erreur éventuel |
| `progression.html` | Page | Inclut `_progression.html` |
| `_progression.html` | Fragment | Barre `<progress>`, notice courante ; `hx-get` toutes les secondes (`hx-trigger="every 1s"`) ; à la fin, la route répond avec l'en-tête `HX-Redirect` vers le tableau de bord |
| `tableau.html` | Page | Cartes de synthèse, graphique en barres CSS, exports, nouveau fichier, configuration LLM, filtre, liste |
| `_lignes_notices.html` | Fragment | `<tbody>` de la liste, rechargé par le filtre (`hx-get` sur `change`) |
| `notice.html` | Page | En-tête, navigation, actions groupées, écarts, bloc catégorie B, bloc RAMEAU, validation |
| `_ligne_ecart.html` | Fragment | Une ligne d'écart avec ses actions (5.1) |
| `_bloc_categorie_b.html` | Fragment | Récapitulatif Syracuse, candidats, recherche manuelle |
| `_candidats.html` | Fragment | Résultats d'une recherche manuelle (PPN ou titre/auteur/année) |
| `_suggestions.html` | Fragment | Suggestions RAMEAU avec cases à cocher, champ texte, suppression |
| `_config_llm.html` | Fragment | Clé, liste des modèles, résultat du test |
| `erreur.html` | Page | Message d'erreur lisible, lien de retour (session introuvable après un redémarrage, par exemple) |

### 5.3 Règles de rendu

- **Graphique « Champs impactés »** : barres horizontales en HTML/CSS (`<div>` dont la largeur est un pourcentage du maximum), triées par nombre décroissant. Pas de bibliothèque de graphiques.
- **Icônes** : caractères Unicode (✓ ✗ ⚠ 🔍 ↗) ou rien. Pas de bibliothèque d'icônes.
- **Couleurs** : une variable CSS par statut dans `app.css` (`--statut-erreur`, `--statut-complement`…), couleur principale `#003366` reprise de l'existant.
- **Confirmation** « Nouveau fichier » : `hx-confirm` (boîte de dialogue native) avec un texte qui rappelle d'exporter d'abord. Les liens d'export restent visibles à côté du bouton.
- **Modification d'un écart** : bouton « Modifier » qui renvoie la ligne en mode édition (champ texte prérempli + « Enregistrer » + « Annuler »).
- **Navigation précédente / suivante** : simples liens `<a>` calculés côté serveur.
- **Case « afficher les champs identiques »** : lien qui recharge la page avec `?tout=1`.
- **Exports** : liens `<a href=… download>` ordinaires, sans HTMX.
- **Accessibilité minimale** : chaque bouton a un texte, chaque champ un `<label>`, état d'une action signalé par `aria-pressed`.

### 5.4 URL et proxy

Toutes les URL des gabarits sont produites par `url_for` (pages, actions HTMX, fichiers statiques). Aucun chemin n'est écrit en dur. Le préfixe éventuel vient de la variable `ROOT_PATH`, transmise à FastAPI (`root_path`). En production `ROOT_PATH` est vide ; derrière le proxy de code-server sur le SSP Cloud, on lance l'application avec `ROOT_PATH=/proxy/8000`. Cela supprime le piège actuel du mode développement (page blanche), documenté sur une demi-page du README.

### 5.5 Ordre de grandeur attendu

La cible vise moins de 600 lignes de HTML au total (pages + fragments), moins de 150 lignes de CSS propre, et zéro ligne de JavaScript applicatif. Si un gabarit dépasse 150 lignes, le découper en fragments inclus (`{% include %}`).

## 6. Routes HTTP

Les routes renvoient du HTML (page ou fragment), sauf les exports (fichiers) et les points d'exploitation (JSON). L'API JSON actuelle n'est pas conservée : elle n'avait qu'un seul client, le front React. Chaque route fait trois choses au plus : charger la session, appeler une fonction de `metier/` ou de `taches.py`, rendre un gabarit.

| Méthode | Chemin | Nom (`url_for`) | Réponse | Remplace |
| --- | --- | --- | --- | --- |
| GET | `/` | `accueil` | page `accueil.html` | — |
| POST | `/sessions` | `deposer` | redirection 303 vers la progression, après lancement de la vérification | `/api/upload` + `/api/verify/:id` |
| GET | `/sessions/{sid}/progression` | `progression` | page, ou fragment si requête HTMX ; `HX-Redirect` à la fin | `/api/status/:id` |
| GET | `/sessions/{sid}` | `tableau` | page `tableau.html` | `/api/results/:id` + `/summary` |
| GET | `/sessions/{sid}/notices?filtre=…` | `lignes_notices` | fragment `_lignes_notices.html` | filtre React |
| GET | `/sessions/{sid}/notices/{identifiant}` | `notice` | page `notice.html` (`?tout=1` : champs identiques) | vue DETAIL |
| POST | `/sessions/{sid}/notices/{identifiant}/ecart` | `action_ecart` | fragment `_ligne_ecart.html` (form : `champ`, `action`, `valeur_modifiee`) | `PUT …/action` |
| GET | `/sessions/{sid}/notices/{identifiant}/ecart/edition?champ=…` | `edition_ecart` | fragment `_ligne_ecart.html` en mode édition | état React |
| POST | `/sessions/{sid}/notices/{identifiant}/groupe` | `action_groupee_notice` | redirection vers la notice (form : `action`) | `bulk-action` avec `ppn` |
| POST | `/sessions/{sid}/groupe` | `action_groupee_session` | redirection vers le tableau | `bulk-action` sans `ppn` |
| POST | `/sessions/{sid}/notices/{identifiant}/validation` | `valider` | redirection vers la notice | `…/valider` |
| POST | `/sessions/{sid}/notices/{identifiant}/rattachement` | `rattacher` | redirection vers la notice (form : `ppn`) | `…/rattacher` |
| POST | `/sessions/{sid}/notices/{identifiant}/recherche-manuelle` | `recherche_manuelle` | redirection vers la notice | `…/absent` |
| GET | `/sessions/{sid}/notices/{identifiant}/candidats?ppn=…` ou `?titre=…&auteur=…&annee=…` | `chercher_candidats` | fragment `_candidats.html` | `/api/sudoc/:ppn` + `/api/sru/search` |
| POST | `/sessions/{sid}/llm` | `configurer_llm` | fragment `_config_llm.html` (form : `cle`, `modele` ; liste les modèles et teste) | `/api/llm/models` + `/api/llm/test` |
| POST | `/sessions/{sid}/notices/{identifiant}/suggestions` | `generer_suggestions` | fragment `_suggestions.html` | `/api/suggest-keywords` |
| POST | `/sessions/{sid}/notices/{identifiant}/suggestions/{rang}` | `modifier_suggestion` | fragment `_suggestions.html` (form : `texte`, `selection`, `supprimer`) | `update-ai-suggestions` |
| POST | `/sessions/{sid}/notices/{identifiant}/vedettes` | `ajouter_vedette` | redirection vers la notice (form : `texte`) | `…/add-keyword` |
| POST | `/sessions/{sid}/fermeture` | `fermer` | redirection vers `/` (supprime la session) | « Nouveau fichier » |
| GET | `/sessions/{sid}/export.xml` | `export_xml` | fichier `export_corrige_{8 premiers caractères du sid}.xml` | `/api/export/:id/xml` |
| GET | `/sessions/{sid}/export.csv` | `export_csv` | fichier `rapport_ecarts.csv` | `/api/export/:id/csv` |
| GET | `/sessions/{sid}/export.txt` | `export_txt` | fichier `export_unimarc_{8 premiers caractères}.txt` | `/api/export/:id/txt` |
| GET | `/api/version` | `version` | JSON, même format qu'aujourd'hui | inchangé |
| GET | `/healthz` | `sante` | `200 ok` (sondes Kubernetes) | nouveau |

Règles communes :

- **Session introuvable** (redémarrage, URL périmée) : page `erreur.html` avec le statut 404 et un lien vers l'accueil, jamais une trace Python.
- **Notice introuvable** : 404, même page.
- **Erreur réseau ABES ou LLM** dans une action : message affiché dans le fragment concerné, sans perdre l'état de la page.
- **En-têtes des exports** : `Content-Type` avec `charset=utf-8`, `Cache-Control: no-cache, no-store, must-revalidate`, `Content-Disposition: attachment` avec les noms de fichiers actuels.
- **Redirections après POST** (motif Post/Redirect/Get) : statut 303, ou en-tête `HX-Redirect` si la requête vient de HTMX.
- **Taille maximale de dépôt** : 50 Mo, vérifiée avant le parsing.

## 7. Sessions et vérification en tâche de fond

L'état reste en mémoire, comme aujourd'hui : un redémarrage efface les sessions en cours. La seule différence est que ce stockage passe derrière une interface, pour qu'une persistance sur S3 (déjà conçue, mais bloquée faute de compte de service) puisse être ajoutée plus tard sans toucher aux routes ni au métier.

### 7.1 Interface de stockage

```python
# app/sessions.py
class Session:          # dataclass
    sid: str
    notices: list[Notice]            # source de l'export XML
    resultats: list[Resultat]
    statut: str                      # DEPOSEE | EN_COURS | TERMINEE | ERREUR
    progression: tuple[int, int, str] # courant, total, PPN ou identifiant en cours
    config_llm: ConfigLLM | None     # clé, modèle : jamais journalisée
    cree_le: datetime

class StockageSessions(Protocol):
    def creer(self, notices: list[Notice]) -> Session: ...
    def lire(self, sid: str) -> Session | None: ...
    def enregistrer(self, session: Session) -> None: ...
    def supprimer(self, sid: str) -> None: ...

class StockageMemoire:  # seule implémentation livrée
    ...                 # dict protégé par un threading.Lock
```

Règles :

- Toute route qui modifie une session appelle `enregistrer` après la modification, même si l'implémentation mémoire n'en a pas besoin. C'est ce qui rendra l'ajout de S3 trivial.
- **Purge** : les sessions de plus de 24 heures sont supprimées à la création d'une nouvelle session (pas de tâche planifiée).
- Le choix de l'implémentation se fait dans `main.py` ; aucun autre module ne connaît `StockageMemoire`.
- Le texte XML original n'est pas conservé : l'export repart des `Notice` (anomalie d'export vide déjà corrigée dans la version TS, à ne pas réintroduire).

### 7.2 Boucle de vérification

`taches.py` expose `lancer_verification(stockage, sid, client_http)` :

- Démarre un `threading.Thread(daemon=True)`. Pas d'asyncio : le code métier est synchrone, plus simple à lire et à tester.
- Refuse le lancement si la session est déjà `EN_COURS`.
- Pour chaque notice, dans l'ordre : met à jour la progression, appelle `verify_notice`, ajoute le résultat, puis `time.sleep(0.5)`.
- En cas d'exception non rattrapée : statut `ERREUR`, trace dans les journaux. Une erreur sur une notice reste gérée par `verify_notice` (résultat en ERREUR avec l'écart « Erreur Interne »), comme aujourd'hui.
- Le `httpx.Client` utilisé a un délai d'expiration explicite (10 s par appel ABES) et un `User-Agent` identifiant l'application.

### 7.3 Contraintes de déploiement induites

- **Un seul worker uvicorn** (`--workers 1`) et **une seule réplique** Kubernetes. À inscrire dans `AGENTS.md` et en commentaire dans le Deployment.
- **Stratégie de déploiement `Recreate`** et non `RollingUpdate`, pour ne jamais avoir deux pods qui se partagent des utilisateurs avec des mémoires différentes.
- Un redémarrage pour mise à jour efface les sessions en cours : la mise en production reste une décision humaine (merge request, section 11).

### 7.4 Extension future (hors périmètre, pour mémoire)

Une implémentation `StockageS3` rangera chaque session sous `s3://<bucket-projet>/sessions/<sid>/` : `meta.json`, résultats par lots en Parquet, décisions en JSON. Elle exige un compte de service S3 dédié au projet. Ne pas l'écrire maintenant.

## 8. Suggestions RAMEAU par LLM

La fonction reste facultative et garde le même modèle de confiance : chaque utilisateur saisit sa propre clé d'API. Elle n'est pas fournie par le déploiement, car l'application n'a pas d'authentification : une clé de service exposerait le quota LLM à quiconque atteint l'URL.

### 8.1 Configuration

- **Endpoint** : variable d'environnement `LLM_ENDPOINT`, valeur par défaut `https://llm.lab.sspcloud.fr/api/chat/completions` (valeur actuelle). Il n'est plus modifiable depuis l'interface (simplification) ; le README explique comment le changer.
- **Clé** : saisie dans le fragment `_config_llm.html` du tableau de bord. Stockée uniquement dans `Session.config_llm` en mémoire ; jamais écrite dans un journal, un export, un message d'erreur ou un gabarit (le champ est de type `password` et n'est jamais pré-rempli).
- **Modèle** : à l'enregistrement de la clé, la route appelle l'URL de listing des modèles (`models_url`, portage exact de `getModelsUrl`) et affiche une liste déroulante. Les trois formats de réponse gérés aujourd'hui (`data[]`, tableau, `models[]`) restent gérés. Variable optionnelle `LLM_MODELE_DEFAUT` pour présélectionner un modèle.
- **Test** : bouton « Tester », même requête qu'aujourd'hui (`Réponds "OK".`, `max_tokens` 10, température 0, délai 30 s), affichage « Connexion OK — N ms » ou du message d'erreur.

### 8.2 Génération

- **Prompts système et utilisateur copiés à l'identique** depuis `server/index.ts` (route `suggest-keywords`), caractère pour caractère, dans des constantes de `metier/rameau.py`. Ne pas les reformuler.
- Valeurs injectées : même logique que `getVal` (valeur de l'écart selon l'action, sinon valeur Sudoc mappée, sinon valeur Syracuse) pour Titre, Editeur, Collection, Résumé, Table des matières, Vedette matière - Nom commun.
- Si titre, résumé et table des matières sont tous vides : pas d'appel, message « Pas assez d'informations pour générer des suggestions. »
- Appel : température 0, `max_tokens` 500, délai 60 s.
- **Nettoyage** (`nettoyer_suggestions`, fonction pure testée) : découpe par ligne, trim, retrait des numérotations (`^\d+[.)\-:]\s*`), des puces (`^[-*•–—]\s*`), des guillemets de bord (`"`, `'`, `«`, `»`), rejet des lignes de 2 caractères ou moins, rejet des vedettes déjà contenues (sans casse) dans les vedettes existantes.
- Les suggestions sont stockées dans `Resultat.suggestions_ia` (texte + sélection) et survivent à la navigation entre notices, comme aujourd'hui.

## 9. Configuration, secrets et sécurité

Toute la configuration passe par des variables d'environnement, lues une seule fois dans `app/config.py` (dataclass figée). Aucun autre module ne lit `os.environ`.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port d'écoute uvicorn | `8000` |
| `ROOT_PATH` | Préfixe d'URL derrière un proxy (section 5.4) | vide |
| `GIT_SHA` | SHA du commit, gravé dans l'image par la CI | vide (`/api/version` répond alors `"source": "inconnu"`) |
| `LLM_ENDPOINT` | Endpoint chat compatible OpenAI | `https://llm.lab.sspcloud.fr/api/chat/completions` |
| `LLM_MODELE_DEFAUT` | Modèle présélectionné | vide |
| `DUREE_VIE_SESSION_HEURES` | Purge des sessions | `24` |
| `NIVEAU_LOG` | Niveau de journalisation | `INFO` |

Règles de sécurité (skills `onyxia-security-audit` et `vault-secrets-onyxia`) :

- **Aucun secret dans le dépôt**, ni dans les manifestes, ni dans un `.env` commité. `.env.example` liste les variables sans valeur sensible.
- **Clé LLM** : voir section 8.1. Un test vérifie qu'elle n'apparaît dans aucune réponse HTML après sa saisie.
- **Parsing XML sûr** : `lxml` avec `resolve_entities=False`, `no_network=True`, `huge_tree=False` (protection contre les entités externes et les bombes XML), pour l'export Syracuse déposé comme pour les réponses de l'ABES.
- **Échappement HTML** : l'autoescape de Jinja reste activé partout. Aucun filtre `|safe` sur une donnée issue d'un fichier ou du Sudoc.
- **Journaux** : pas de contenu de notice au-delà de l'identifiant et du PPN ; jamais de clé.
- **Conteneur** : utilisateur non root, système de fichiers en lecture seule hormis `/tmp` (section 11).
- **Accès** : l'application n'a pas d'authentification aujourd'hui (l'ingress n'en déclare pas). Ce point est listé en section 14 ; la refonte ne l'aggrave pas puisque aucune clé de service n'est déployée.

## 10. Tests et non-régression

La garantie de parité repose sur trois niveaux de tests, tous exécutés sans réseau par `uv run pytest -q`. Le deuxième niveau est le plus important : il compare la nouvelle version à l'ancienne sur les mêmes entrées.

### 10.1 Portage des tests existants

Les 133 cas de `test/*.test.ts` sont portés un pour un en pytest, avec les mêmes fixtures (`test/fixtures/syracuse-echantillon.xml`, `test/fixtures/sudoc-267670346.xml`, copiées dans `tests/fixtures/`). Le nom de chaque test Python reprend le libellé du test d'origine. Un tableau de correspondance (fichier `tests/CORRESPONDANCE.md`) liste chaque cas TS et le test Python qui le couvre ; aucun cas ne peut manquer.

### 10.2 Sorties de référence générées depuis la version TypeScript

Avant d'écrire la moindre ligne de Python métier (phase 1), un script Node temporaire `scripts/generer_reference.ts` exécute les fonctions TypeScript actuelles sur des entrées fixes et écrit les résultats en JSON dans `tests/reference/` :

| Fichier | Contenu |
| --- | --- |
| `similarite.json` | Au moins 30 paires de chaînes (accents, ponctuation, chaînes courtes, vides, répétitions) et le score de `string-similarity` |
| `compare_fields.json` | Au moins 60 triplets (champ, valeur Syracuse, valeur Sudoc) couvrant chaque branche de `compareFields`, avec le statut attendu |
| `syracuse.json` | Résultat de `parseSyracuseNotices` sur la fixture Syracuse |
| `sudoc.json` | Résultat de `parseSudocXml` sur la fixture Sudoc |
| `ecarts.json` | Résultat de `compareNoticeWithSudoc` pour chaque notice A de la fixture contre la fixture Sudoc |
| `unimarc.txt` | Résultat de `unimarcXmlToText` sur la fixture Sudoc |
| `export.xml`, `export.csv`, `export.txt` | Exports d'une session construite à partir des fixtures, avec un jeu de décisions fixe (au moins un ACCEPTER, un CONSERVER, un MODIFIER, un rattachement, une vedette ajoutée) |

Les tests Python rejouent les mêmes entrées et comparent à ces fichiers, à l'octet près pour les exports. Toute différence est soit une anomalie autorisée de la section 4.6 (référence régénérée et différence expliquée dans le commit), soit un bug. Le script de génération est supprimé en phase 6 ; les fichiers de référence restent.

### 10.3 Tests propres à la cible

- `test_verification.py` : `verify_notice` avec un `httpx.MockTransport` qui rejoue des réponses ABES enregistrées : PPN trouvé, PPN muet puis isbn2ppn, puis ean2ppn, PPN fusionné, catégorie B avec PPN tronqué, SRU vide, SRU en erreur avec ou sans candidat.
- `test_decisions.py` : chaque règle de la section 4.4, dont le cas particulier TOUT\_ACCEPTER en catégorie B et l'anomalie A1.
- `test_rameau.py` : `nettoyer_suggestions` sur des réponses LLM bruitées, `models_url`, refus quand les champs sont vides.
- `test_web.py` avec le `TestClient` de FastAPI : parcours complet dépôt → progression → tableau → notice → action → export, sur un stockage mémoire et un client HTTP simulé ; session inconnue → 404 lisible ; `url_for` avec `ROOT_PATH=/proxy/8000` produit des liens préfixés ; la clé LLM n'apparaît dans aucune réponse.
- `test_architecture.py` : aucun module de `app/metier/` n'importe `fastapi`, `jinja2`, `app.web`, `app.sessions` ou `app.taches` (analyse des imports avec `ast`).

### 10.4 Qualité

- `uv run ruff format --check .` et `uv run ruff check .` sans erreur (configuration ruff par défaut + règles `I`, `UP`, `B`).
- Couverture indicative : au moins 85 % sur `app/metier/` (`pytest --cov`, ajouté en dépendance de développement si l'équipe l'accepte ; sinon, non bloquant).
- Recette manuelle (phase 5) sur un vrai export Syracuse fourni par la documentaliste, en local uniquement, jamais commité.

## 11. Conteneur, CI et déploiement SSP Cloud

Le déploiement corrige le principal piège actuel : l'image `:latest`, qu'ArgoCD ne voit jamais changer. Chaque image est désormais taguée par le SHA de son commit, et la mise en production consiste à fusionner une merge request qui change ce tag. ArgoCD fait le reste ; un retour arrière est un simple *revert*.

### 11.1 Dockerfile

Écart assumé au skill `onyxia-reproducibility` : l'image `inseefrlab/python-datascience` pèse plusieurs gigaoctets et embarque des outils inutiles à une application web. On part d'une image Python légère avec `uv`, en épinglant la version.

```dockerfile
FROM ghcr.io/astral-sh/uv:0.5-python3.12-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app

# Dépendances d'abord (cache de couche tant que le lockfile ne change pas)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
RUN uv sync --frozen --no-dev

ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA PORT=8000

RUN useradd --uid 10001 --no-create-home appli
USER 10001
EXPOSE 8000
CMD ["sh", "-c", "uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers"]
```

Le tag exact de l'image de base est à vérifier au moment de l'écriture et à épingler (pas de tag flottant). Garder les commentaires pédagogiques en français, dans l'esprit du Dockerfile actuel.

### 11.2 Manifestes Kubernetes (`deploy/`)

Les trois manifestes actuels sont conservés et complétés ; un `kustomization.yaml` porte le tag de l'image. ArgoCD reconnaît Kustomize sans configuration supplémentaire.

```yaml
# deploy/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - ingress.yaml
images:
  - name: ghcr.io/inseefrlab/unimarc-sudoc-reconciler
    newTag: "<sha>"   # mis à jour par la CI via merge request, jamais à la main
```

Modifications de `deployment.yaml` :

- `replicas: 1` et `strategy: { type: Recreate }`, avec un commentaire renvoyant à la section 7.3.
- Image sans tag (le tag vient de Kustomize) ; retrait de `imagePullPolicy: Always`, devenu inutile avec un tag immuable.
- Port 8000 (et mise à jour de `service.yaml`).
- Sondes `readinessProbe` et `livenessProbe` sur `/healthz`.
- `securityContext` : `runAsNonRoot: true`, `runAsUser: 10001`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false` ; volume `emptyDir` monté sur `/tmp`.
- Ressources : conserver les valeurs actuelles, sauf mesure contraire en recette.
- `ingress.yaml` : inchangé (hôte, timeout long), sauf le port du service.

`application.yaml` (ressource ArgoCD) est conservé tel quel ; son `syncPolicy.automated` assure la synchronisation après fusion.

### 11.3 Intégration continue (`.github/workflows/ci.yml`)

Un seul workflow, trois jobs, qui remplace `build-push.yml` :

1. **`qualite`** (toute branche, toute merge request) : installation de `uv`, `uv sync --frozen`, `ruff format --check`, `ruff check`, `pytest -q`.
2. **`image`** (sur `main`, après `qualite`) : construction et publication sur `ghcr.io/inseefrlab/unimarc-sudoc-reconciler:<sha>` avec `--build-arg GIT_SHA=<sha>`. Pas de tag `latest`.
3. **`proposition-deploiement`** (sur `main`, après `image`) : met à jour `newTag` dans `deploy/kustomization.yaml` et ouvre une merge request « Déployer \<sha court> » (action `peter-evans/create-pull-request`, version épinglée). Cette merge request ne déclenche pas de nouvelle image (filtre `paths-ignore: deploy/**` sur le job `image`).

La fusion de cette merge request **est** la mise en production : c'est un geste humain, conscient qu'il efface les sessions en cours. Prérequis côté dépôt GitHub : autoriser GitHub Actions à créer des pull requests (paramètres du dépôt).

### 11.4 Vérification du déploiement

`scripts/verifier-deploiement.sh` est adapté : il compare le SHA renvoyé par `/api/version` au `newTag` de `deploy/kustomization.yaml` sur `main` (et non plus au dernier commit de `main`), et affiche clairement « à jour », « synchronisation en attente » ou « écart ».

### 11.5 Développement sur le SSP Cloud

Dans un service VSCode-python :

```bash
uv sync
ROOT_PATH=/proxy/8000 uv run uvicorn app.main:app --reload --port 8000
# puis ouvrir https://<service>.user.lab.sspcloud.fr/proxy/8000/
```

Le rechargement à chaud fonctionne derrière le proxy, ce qui n'était pas le cas avec Vite.

### 11.6 Déploiement de preview

Une instance de preview, distincte de la production, permet de faire la recette d'une branche avant toute fusion. Elle vit dans le même namespace, sous d'autres noms et une autre adresse. Elle est déployée et supprimée à la main.

**Image** : le job `image-preview` de `ci.yml` s'exécute sur chaque push sur `refonte-python` (après `qualite`). Il publie l'image avec deux tags : `<sha>` (traçabilité) et `preview` (tag mouvant, réservé à cet usage).

**Manifestes** : dossier `deploy-preview/` à la racine, qui réutilise `deploy/` :

```yaml
# deploy-preview/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../deploy
nameSuffix: -preview
labels:
  - pairs:
      variante: preview
    includeSelectors: true   # indispensable : sinon le Service de preview sélectionnerait aussi les pods de production
images:
  - name: ghcr.io/inseefrlab/unimarc-sudoc-reconciler
    newTag: preview
patches:
  - target: { kind: Ingress }
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: unimarc-sudoc-reconciler-preview.lab.sspcloud.fr
  - target: { kind: Deployment }
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: Always
```

Si l'ingress déclare aussi une section `tls` avec le nom d'hôte, la patcher de la même façon. Vérifier le rendu avant d'appliquer : `kubectl kustomize deploy-preview`.

**Utilisation**, depuis un service VSCode lancé avec des droits Kubernetes d'écriture sur le namespace :

```bash
kubectl apply -k deploy-preview                                           # première fois
kubectl rollout restart deployment/unimarc-sudoc-reconciler-preview        # après chaque nouvelle image
kubectl delete -k deploy-preview                                          # après la recette
```

Le tag mouvant `preview` est acceptable ici, et seulement ici : la preview n'a pas besoin de retour arrière. La production garde le tag par SHA. `deploy-preview/` est conservé après la refonte, pour les recettes des évolutions futures (la branche suivie par `image-preview` sera alors à adapter).

## 12. Documentation à produire

La documentation actuelle est de bonne qualité ; elle est adaptée, pas réécrite. Le principe reste « un fichier, un public ».

| Fichier | Public | Action |
| --- | --- | --- |
| `README.md` | Utilisatrice et mainteneur | Réécrire les sections installation, lancement, configuration, tests et mise en production pour la pile Python. Conserver contexte, « Ce qu'elle fait », statut POC. Supprimer la section sur le proxy et Vite, remplacée par trois lignes sur `ROOT_PATH`. |
| `AGENTS.md` | Agents de code (Claude Code, OpenCode) et humains qui reprennent le code | Remplace `CLAUDE.md` (lisible par les deux outils). Reprend : architecture, carte des modules, flux de données, invariants de la section 4.5, conventions, pièges, incohérences résiduelles, commandes de vérification. Ajoute : règle d'or des imports (section 3.2), un seul worker et une seule réplique, interdiction d'ajouter une dépendance ou du JavaScript sans accord. |
| `CLAUDE.md` | — | Réduit à une ligne : `Voir AGENTS.md.` (Claude Code le lit par défaut). |
| `docs/metier-unimarc-sudoc.md` | Documentaliste, mainteneur | Inchangé, sauf les noms de fichiers source cités. |
| `docs/apprendre.md` | Public non spécialiste | Déplacé depuis la racine. Mettre à jour le chapitre déploiement : tag par SHA, merge request de déploiement, retour arrière. |
| `docs/historique-conception.md` | Archive | Inchangé. Ajouter en tête une ligne datée signalant la refonte Python. |
| `tests/CORRESPONDANCE.md` | Relecteur | Table cas TS → test Python (section 10.1). |

Chaque module Python commence par une docstring d'en-tête qui explique son rôle en deux à cinq lignes, comme les en-têtes actuels des fichiers TypeScript.

## 13. Plan d'exécution et critères d'acceptation

Sept phases, chacune sur sa branche et dans sa merge request. Une phase n'est terminée que lorsque tous ses critères sont cochés ; l'agent colle dans la description de la merge request la sortie des commandes qui les prouvent. L'ancienne application reste fonctionnelle et déployée jusqu'à la fin de la phase 6.

### Phase 0 — Préparation et références

Créer `pyproject.toml` (Python 3.12, dépendances de la section 3.1), le squelette `app/` vide, `tests/`, la configuration ruff ; écrire `scripts/generer_reference.ts` et produire `tests/reference/` (section 10.2) avec le code TypeScript actuel.

Prérequis : Node.js 20 ou plus dans le service VSCode, pour exécuter l'ancien code et `generer_reference.ts`. Il n'est pas installé par défaut sur les services du SSP Cloud ; le README de la phase 0 indique comment l'installer sans droits administrateur.

- [ ] `uv sync` et `uv run pytest -q` s'exécutent sans erreur.
- [ ] Tous les fichiers de la table 10.2 existent, avec les volumes minimaux demandés (30 paires, 60 triplets).
- [ ] `npm test` passe toujours (rien n'a été cassé côté TypeScript).
- [ ] `test_architecture.py` est en place.

### Phase 1 — Fondations métier hors réseau

`modeles.py`, `similarite.py`, `syracuse.py`, `unimarc.py` (sauf accès réseau).

- [ ] `compare_two_strings` égale la référence sur toutes les paires (tolérance 1e-12).
- [ ] `parse_syracuse_notices` et `parse_sudoc_xml` égalent `syracuse.json` et `sudoc.json`.
- [ ] `unimarc_xml_to_text` égale `unimarc.txt` à l'octet près.
- [ ] Les cas portés de `marc.test.ts` et `syracuse.test.ts` passent.

### Phase 2 — Comparaison, accès Sudoc, vérification, décisions

`comparaison.py`, `sudoc.py`, `verification.py`, `decisions.py`.

- [ ] `compare_fields` égale `compare_fields.json` sur tous les triplets ; `compare_notice_with_sudoc` égale `ecarts.json`.
- [ ] Les cas portés de `compare.test.ts` passent.
- [ ] `test_verification.py` couvre toutes les pistes listées en 10.3.
- [ ] `test_decisions.py` couvre chaque règle de 4.4 ; l'anomalie A1 a son propre commit et son test.

### Phase 3 — Exports et RAMEAU

`exports.py`, `rameau.py`.

- [ ] Les trois exports égalent `export.xml`, `export.csv`, `export.txt` à l'octet près.
- [ ] Les cas portés de `exports.test.ts` passent ; `tests/CORRESPONDANCE.md` est complet (133 lignes).
- [ ] Les prompts RAMEAU sont identiques caractère pour caractère à ceux de `server/index.ts` (test de comparaison de chaînes).

### Phase 4 — Application web

`config.py`, `sessions.py`, `taches.py`, `web.py`, `main.py`, gabarits, `static/`.

- [ ] `test_web.py` passe : parcours complet, 404 lisibles, `ROOT_PATH`, absence de la clé LLM dans les réponses.
- [ ] Aucun fichier `.js` dans `app/` hormis la copie d'HTMX ; aucune URL écrite en dur dans les gabarits (`grep` sur `href="/` et `hx-*="/` vide).
- [ ] Moins de 600 lignes de gabarits, moins de 150 lignes dans `app.css`.
- [ ] L'application démarre en local avec `uv run uvicorn app.main:app` et derrière le proxy SSP Cloud avec `ROOT_PATH`.

### Phase 5 — Image, preview et recette

`Dockerfile`, workflow `ci.yml` réduit aux jobs `qualite` et `image-preview` (section 11.6), dossier `deploy-preview/`, déploiement de preview, recette manuelle avec la documentaliste. Il n'y a pas de démon Docker dans les services du SSP Cloud : l'image est toujours construite par la CI, jamais en local. L'ancien `build-push.yml` reste en place et continue de servir la production.

- [ ] Un push sur `refonte-python` déclenche `qualite` puis `image-preview`, qui publie `ghcr.io/inseefrlab/unimarc-sudoc-reconciler:<sha>` et `:preview`.
- [ ] `kubectl apply -k deploy-preview` crée l'instance de preview sans toucher aux objets de production (`kubectl get deploy,svc,ingress` montre les deux jeux d'objets, aux noms distincts).
- [ ] Sur l'adresse de preview : `/healthz` répond 200, `/api/version` renvoie le SHA du dernier commit de `refonte-python`.
- [ ] Le pod de preview tourne en utilisateur non root, système de fichiers en lecture seule (hors `/tmp`) : vérifié par `kubectl get pod <pod> -o yaml`.
- [ ] Toutes les cases de la section 2 sont cochées lors d'une recette sur un vrai export Syracuse, menée sur la preview et comparée côte à côte avec la version 1.4.0 en production.
- [ ] Les écarts constatés en recette sont soit corrigés, soit listés et acceptés par écrit par la documentaliste.
- [ ] Après la recette, l'instance de preview est supprimée (`kubectl delete -k deploy-preview`).

### Phase 6 — Bascule et nettoyage

Nouveau workflow CI, `deploy/kustomization.yaml`, manifestes mis à jour, documentation (section 12), puis suppression de l'ancien code.

- [ ] Le job `qualite` passe sur la merge request ; après fusion, le job `image` publie l'image taguée par SHA et le job `proposition-deploiement` ouvre la merge request de déploiement.
- [ ] La fusion de cette merge request entraîne la synchronisation ArgoCD ; `scripts/verifier-deploiement.sh` affiche « à jour ».
- [ ] Un retour arrière a été testé une fois (revert de la merge request de déploiement → l'ancienne image revient).
- [ ] Supprimés : `server/`, `src/`, `test/`, `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json`, `package-lock.json`, `.github/workflows/build-push.yml`, `scripts/generer_reference.ts`. Plus aucun fichier `.ts` ni `.tsx` dans le dépôt.
- [ ] `AGENTS.md`, `README.md` et `docs/apprendre.md` sont à jour ; version passée à `2.0.0` dans `pyproject.toml`.

## 14. Hors périmètre et décisions ouvertes

Hors périmètre de cette refonte, même si l'agent le juge utile :

- Persistance des sessions (S3, PostgreSQL ou autre) : interface prévue, implémentation reportée faute de compte de service.
- Parallélisation des appels au Sudoc, reprise automatique d'une vérification interrompue.
- Nouvelles règles métier (diacritiques sur le titre, enrichissement d'`ILLUSTRATION_TERMS`, fixtures issues de vraies notices) : pistes notées dans `AGENTS.md`, à traiter après la bascule.
- Gabarit générique réutilisable pour d'autres applications : cette refonte en sera le prototype, mais on n'en extrait rien maintenant.

Décisions ouvertes, à trancher par l'équipe et non par l'agent :

| Sujet | Question | Proposition par défaut |
| --- | --- | --- |
| Authentification | L'ingress n'en déclare aucune. Faut-il protéger l'accès (oauth2-proxy + Keycloak SSP Cloud) ? | Hors refonte ; à instruire ensuite, prérequis pour toute clé LLM de service |
| Namespace | L'application tourne dans le namespace personnel `user-mhillion`. | Migrer vers un namespace de projet SSP Cloud quand il existera |
| Recherche approfondie (A4) | Le passage en ABSENT\_SUDOC pour ouvrir la recherche manuelle convient-il à la documentaliste ? | Conserver tel quel, poser la question en recette |
| Endpoint LLM | Faut-il garder la possibilité de changer d'endpoint depuis l'interface ? | Non : variable d'environnement uniquement |
| Couverture de tests | Ajouter `pytest-cov` en dépendance de développement ? | Oui, non bloquant |
| Hébergement du dépôt | Rester sur GitHub (InseeFrLab) avec ghcr.io, ou passer sur la forge interne ? | Rester sur GitHub tant que l'application est sur le SSP Cloud |
