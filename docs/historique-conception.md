# Spécifications fonctionnelles et techniques — Application de vérification et correction des notices bibliographiques Syracuse à partir du catalogue Sudoc

> ## ⚠️ Document d'archive — le code fait foi
>
> Ce document est la **spécification de conception** rédigée *avant* et *pendant*
> le développement du POC (v1.0 à v1.4). Il est conservé pour la traçabilité des
> décisions et parce qu'il détaille des intentions utiles, mais il **ne décrit pas
> fidèlement l'application livrée**.
>
> Pour comprendre ou modifier l'application, utiliser dans cet ordre :
>
> | Besoin | Document |
> | --- | --- |
> | Contexte, démarrage, architecture, déploiement | [../README.md](../README.md) |
> | Savoir métier à jour (formats, mappings, règles) | [metier-unimarc-sudoc.md](metier-unimarc-sudoc.md) |
> | Invariants à ne pas casser | [../CLAUDE.md](../CLAUDE.md) |
> | Comportement exact | le code, dans `server/` et `src/` |
>
> Les écarts connus entre ce document et le code sont recensés en
> [annexe](#annexe--%C3%A9carts-connus-entre-ce-document-et-le-code) en fin de
> fichier. Ne pas corriger ce document : le faire évoluer reviendrait à créer une
> seconde source de vérité.

---



**Document de spécifications pour le Centre de Ressources Documentaires de l'Insee**

**Version** : 1.4
**Date** : 1 septembre 2026
**Auteur** : Analyse préparatoire Claude / Anthropic
**Historique** :
- v1.0 (6 avril 2026) — version initiale
- v1.1 (13 avril 2026) — ajout des règles de normalisation automatique et de suggestion IA de mots-clés
- v1.2 (13 avril 2026) — LLM externe configurable SSP Cloud
- v1.3 (14 avril 2026) — prise en charge des notices PMB non rattachées au Sudoc, recherche SRU par contenu
- v1.4 (1 septembre 2026) — export UNIMARC textuel pour WINIBW, conversion zone 100 UNIMARC standard → format Sudoc, corrections des bugs (export XML, suggestions IA, tableau comparatif SRU, PPN padding, format d'affichage), déploiement SSP Cloud opérationnel via ArgoCD

---

## 1. Contexte et objectif

### 1.1 Contexte

Le Centre de Ressources Documentaires de l'Insee utilise le système de gestion documentaire **Syracuse** pour cataloguer ses ouvrages. Les notices d'ouvrages de Syracuse sont rattachées au catalogue du **Système Universitaire de Documentation (Sudoc)**, le catalogue collectif français des bibliothèques et centres de documentation de l'enseignement supérieur et de la recherche. Chaque notice Syracuse contient un champ « Identifiant d'origine » qui correspond au **PPN** (Pica Production Number), l'identifiant unique de la notice dans le Sudoc.

Or, certaines informations contenues dans les notices Syracuse peuvent être **erronées** (différences avec le Sudoc faisant référence) ou **incomplètes** (champs vides alors que l'information existe dans le Sudoc). Par ailleurs, une partie du fonds documentaire n'est pas rattachée au Sudoc et provient de l'ancien système PMB (Personnal Media Base) : ces notices doivent être recherchées dans le Sudoc par leur contenu (titre, auteur, année) et rattachées si un candidat pertinent est trouvé.

Après correction et validation, les notices doivent pouvoir être exportées dans deux formats :
1. **XML Syracuse** — pour réimport dans Syracuse
2. **UNIMARC textuel** — pour copier-coller dans WINIBW (l'outil de catalogage professionnel utilisé pour le Sudoc)

### 1.2 Objectif

Développer une application web permettant de :

1. **Importer** un fichier XML exporté depuis Syracuse contenant une liste de notices d'ouvrages.
2. **Détecter automatiquement** le type de chaque notice (rattachée Sudoc ou notice PMB non rattachée).
3. **Interroger automatiquement** le catalogue Sudoc :
   - Par PPN pour les notices rattachées.
   - Par recherche SRU (titre + auteur + année) pour les notices PMB.
4. **Comparer** les informations Syracuse avec les informations de référence du Sudoc.
5. **Identifier** les écarts : erreurs, différences et champs manquants.
6. **Proposer** les corrections et compléments issus du Sudoc.
7. **Permettre à l'utilisateur** de valider, modifier ou rejeter chaque proposition.
8. **Suggérer via IA** des vedettes matières RAMEAU complémentaires à partir du contenu de la notice.
9. **Exporter** les notices corrigées dans plusieurs formats :
   - **XML** au format Syracuse (pour réimport dans Syracuse).
   - **UNIMARC textuel** (format Sudoc) pour copier-coller dans WINIBW.
   - **CSV** de synthèse des écarts (pour reporting).

---

## 2. Analyse des données sources

### 2.1 Fichiers en entrée

L'application accepte un fichier XML au format d'export Syracuse (type « Panier-catalogue »). Le fichier XML contient toutes les informations suffisantes : PPN (« Identifiant d'origine ») pour rechercher la notice Sudoc, et l'ensemble des champs bibliographiques à vérifier.

### 2.2 Structure du fichier XML Syracuse

```xml
<items>
  <item type="GESMARC">
    <property name="NomDuChamp" value="ValeurDuChamp" rank="N"
              referentialType="" referentialName="" />
    <!-- ... autres propriétés ... -->
  </item>
  <!-- ... autres items ... -->
</items>
```

Chaque `<item>` représente une notice et contient des éléments `<property>` avec les attributs `name` (nom du champ) et `value` (valeur du champ). L'attribut `rank` indique l'ordre d'affichage, `referentialType` et `referentialName` sont utilisés pour les champs référencés (souvent vides).

### 2.3 Champs disponibles dans le XML Syracuse (43 propriétés)

**Identifiants :**
- `Identifiant d'origine` — PPN Sudoc pour les notices rattachées / identifiant PMB pour les autres (toujours rempli)
- `Identifiant` — Identifiant interne Syracuse (toujours rempli, clé stable)
- `ISBN` — Numéro ISBN
- `ISSN` — Numéro ISSN
- `EAN` / `EAN (valeur)` — Code EAN
- `Filtre` — Discrimine notices rattachées Sudoc (« SUDOC ») vs PMB (« PMB.BIB »)

**Description bibliographique :**
- `Titre`, `Auteur principal - Personne physique`, `Auteur principal - Collectivité `, `Autre auteur principal - Personne physique`, `Autre auteur principal - Collectivité`, `Auteur secondaire - Personne physique`, `Auteur secondaire- Collectivité`, `Editeur`, `Publié le`, `Collection`, `Description matérielle`

**Contenu et indexation :**
- `Résumé`, `Table des matières`
- `Vedette matière - Nom commun` (RAMEAU), `Vedette matière - Forme, genre`, `Vedette matière - Nom de collectivité`, `Vedette matière - Nom de personne`, `Vedette matière - Nom géographique`

**Informations administratives (non modifiables) :**
- `Prix`, `Référence commerciale`, `Document`, `Type de notice`, `Nombre d'exemplaires`, `Règle`, `Notes`

**Champs souvent vides :**
- `Nom - Responsabiblité`, `Référence éditoriale`, `UPC`, `Titre : volume`, `Titre de partie et N° de partie`, `Titre uniforme`

### 2.4 Différences de formatage observées entre Sudoc et Syracuse

1. **Titres** : différences de ponctuation, espaces insécables, apostrophes typographiques.
2. **ISBN** : découpage en groupes de chiffres variable, mais forme numérique identique.
3. **Auteurs** : le Sudoc fournit `Nom, Prénom (dates ; qualificatif)` + IdRef, Syracuse concatène `Nom Prénom dates IdRef code_fonction`.
4. **Année** : parfois préfixée par `C ` (copyright) dans le Sudoc.
5. **Description matérielle** : abréviations `1 vol.`, `p.` à normaliser en `1 volume`, `pages`, ajout de parenthèses.
6. **Reliure** : abréviations `br.` / `rel.` à développer en `broché` / `relié`.

### 2.5 Deux catégories de notices — détection automatique

**Catégorie A — Notices rattachées au Sudoc :**
- Le champ `Filtre` contient « SUDOC », « INSEESUDOC » ou une variante
- OU l'identifiant d'origine est un PPN Sudoc valide (9 caractères alphanumériques, le dernier pouvant être X)

**Catégorie B — Notices PMB non rattachées :**
- Le champ `Filtre` = `PMB.BIB` (ou autre valeur ne contenant pas « SUDOC »)
- ET l'identifiant d'origine ne ressemble pas à un PPN Sudoc (souvent 6-7 chiffres)
- Ces notices sont typiquement des ouvrages anciens (années 1950-1970) sans ISBN.

---

## 3. Mécanisme d'accès au catalogue Sudoc

### 3.1 API et web services disponibles

| Méthode | URL type | Format retourné | Usage |
|---------|----------|----------------|-------|
| **Web service UNIMARC/MarcXML** | `https://www.sudoc.fr/{PPN}.xml` | UNIMARC XML | Récupération d'une notice par PPN |
| **Service SRU** | `https://www.sudoc.abes.fr/cbs/sru/?operation=searchRetrieve&version=1.1&recordSchema=unimarc&query=...` | UNIMARC XML (encapsulé SRU) | Recherche multi-critères par contenu |
| **isbn2ppn** | `https://www.sudoc.fr/services/isbn2ppn/{ISBN}` | XML | PPN à partir d'un ISBN |
| **ean2ppn** | `https://www.sudoc.fr/services/ean2ppn/{EAN}` | XML | PPN à partir d'un EAN |
| **merged** | `https://www.sudoc.fr/services/merged/{PPN}` | XML | Vérifier si un PPN a été fusionné |

**Toutes ces API sont publiques et ne nécessitent aucune authentification.** Les données Sudoc sont diffusées sous Licence Ouverte.

### 3.2 IMPORTANT — Le PPN Sudoc doit toujours avoir 9 caractères

Les PPN Sudoc font **exactement 9 caractères** (8 chiffres + 1 caractère de contrôle : chiffre ou X). Lorsqu'un PPN commence par un `0`, il arrive que ce zéro initial soit perdu (notamment quand le PPN est stocké comme entier ou quand il est retourné tronqué par certains services SRU).

**Règle** : l'application doit systématiquement ré-appliquer un padding avec `0` initial si le PPN reçu ne fait que 8 caractères. Sans ce padding, l'URL `https://www.sudoc.fr/{PPN}` retourne un HTTP 404.

Exemple :
- Reçu : `65493583` → invalide (`https://www.sudoc.fr/65493583` → 404)
- Après padding : `065493583` → valide (`https://www.sudoc.fr/065493583` → OK)

Cette règle doit être appliquée dans **tous les affichages de PPN** et dans **tous les appels backend** vers l'API Sudoc.

### 3.3 Stratégie d'interrogation

#### 3.3.1 Pour les notices de Catégorie A (rattachées au Sudoc)

**Méthode principale** : accès direct par PPN via `https://www.sudoc.fr/{PPN}.xml`.

**Méthode de secours** (HTTP 404) :
1. Appeler le web service `merged` pour vérifier si le PPN a été fusionné.
2. Si `merged` retourne un nouveau PPN, refaire la requête avec ce nouveau PPN.
3. Sinon, la notice est marquée **NON_TROUVE**.

#### 3.3.2 Pour les notices de Catégorie B (PMB non rattachées) — RECHERCHE SRU PAR CONTENU

Recherche en 3 niveaux successifs :

**Niveau 1 — titre + auteur + année :**
```
query=mti%3D{mots_titre}+aut%3D{nom_auteur}+apu%3D{année}
```

**Niveau 2 — titre + année :** si le niveau 1 retourne 0 résultat.

**Niveau 3 — titre seul :** si le niveau 2 retourne 0 résultat.

Construction des critères :
- **mots_titre** : 3 à 5 mots significatifs (suppression des mots vides multilingues : the, a, an, of, in, on, to, for, and, or, le, la, les, de, du, des, un, une, et, en, au, aux, für, der, die, das, und, zu, von, im).
- **nom_auteur** : nom de famille de l'auteur principal (personne physique ou premiers mots de l'auteur collectivité).
- **année** : année exacte extraite du champ `Publié le`.

#### 3.3.3 Gestion des résultats SRU

| Nombre de résultats | Action |
|---------------------|--------|
| **0** (aux 3 niveaux) | Marquer **ABSENT_SUDOC**. Notice conservée telle quelle. |
| **1 candidat** | Afficher un tableau comparatif complet Syracuse ↔ Sudoc avec boutons « Rattacher » / « Pas la bonne » |
| **2 à 10 candidats** | Afficher chaque candidat avec un tableau comparatif Syracuse ↔ Sudoc et un bouton « Sélectionner et rattacher » |
| **> 10 candidats** | Afficher les 10 premiers avec possibilité de recherche manuelle |

#### 3.3.4 Rattachement au Sudoc via SRU

Quand l'utilisateur valide un candidat SRU :
1. Mise à jour du champ `Identifiant d'origine` de la notice avec le nouveau PPN Sudoc (paddé à 9 caractères).
2. Récupération de la notice complète via `https://www.sudoc.fr/{PPN}.xml`.
3. Lancement de la comparaison classique.
4. Statut passé à **RATTACHE_SRU** (icône 🔗).

---

## 4. Processus de vérification automatique

### 4.1 Vue d'ensemble du processus

```
┌─────────────────┐    ┌───────────────────┐    ┌─────────────────┐
│ 1. Import XML   │───▶│ 2. Détection type │───▶│ 3. Interrogation│
│    Syracuse     │    │    (Cat A / B)    │    │    Sudoc        │
└─────────────────┘    └───────────────────┘    └────────┬────────┘
                                                         │
┌─────────────────┐    ┌───────────────────┐    ┌────────▼────────┐
│ 6. Export       │◀───│ 5. Validation     │◀───│ 4. Comparaison  │
│  XML/TXT/CSV    │    │    utilisateur    │    │    & détection  │
└─────────────────┘    │  + suggestions IA │    │    des écarts   │
                       └───────────────────┘    └─────────────────┘
```

### 4.2 Étape 1 — Import et parsing du fichier XML Syracuse

- L'utilisateur charge le fichier XML via drag-and-drop ou sélection.
- L'application parse le fichier XML et extrait toutes les notices (éléments `<item>`).
- Détection automatique du type de notice (Catégorie A ou B).
- L'interface affiche : nombre total de notices, nombre Catégorie A, nombre Catégorie B.

### 4.3 Étape 2 — Interrogation du Sudoc

**Pour les notices de Catégorie A** : accès direct par PPN.

**Pour les notices de Catégorie B** : recherche SRU par contenu.

**Gestion du débit** : délai de 500 ms entre chaque requête pour ne pas surcharger les serveurs de l'ABES.

### 4.4 Étape 3 — Normalisation et comparaison

Les données sont normalisées avant comparaison car les formats diffèrent :

| Champ | Normalisation |
|-------|---------------|
| **ISBN** | Suppression des tirets. Comparaison des formes numériques. |
| **EAN** | Suppression des espaces. Comparaison numérique. |
| **Titre** | Ignorer ponctuation, espaces multiples, espaces insécables. Comparaison en lowercase après suppression des diacritiques. |
| **Auteurs** | Extraction `Nom + Prénom`. Utilisation de l'IdRef comme clé fiable. |
| **Année** | Suppression du préfixe `C `. Extraction des 4 chiffres. |
| **Éditeur** | Comparaison fuzzy (Levenshtein/Jaro-Winkler), seuil de similarité > 0.85. |
| **Vedettes matières** | Comparaison par ensemble (set), séparateur `;`. |

### 4.5 Catégorisation des écarts

| Statut | Couleur | Description |
|--------|---------|-------------|
| **IDENTIQUE** | — | Valeurs identiques après normalisation |
| **DIFFERENCE_MINEURE** | Bleu clair | Différence de formatage uniquement |
| **ERREUR** | Rouge | Divergence substantielle |
| **MANQUANT_SYRACUSE** | Orange | Champ vide dans Syracuse, renseigné dans Sudoc |
| **ABSENT_SUDOC** | Gris | Champ vide dans Sudoc, renseigné dans Syracuse |
| **NON_TROUVE** | Gris foncé | Notice introuvable dans le Sudoc (Cat A, PPN invalide) |
| **NORMALISE** | Violet | Valeur transformée par une règle de normalisation auto |
| **GENERE_AUTO** | Violet | Valeur générée automatiquement (EAN depuis ISBN, etc.) |
| **FUSION** | Violet | Valeur résultant de la fusion Syracuse + Sudoc |
| **SUGGESTION_IA** | Violet + ✨ | Mot-clé suggéré par l'IA (RAMEAU) |
| **EN_ATTENTE_RATTACHEMENT** | Indigo | Notice PMB — candidats trouvés, en attente de validation |
| **RATTACHE_SRU** | Bleu + 🔗 | Notice PMB rattachée via SRU — nouveau PPN attribué |
| **ABSENT_SUDOC_DEFINITIF** | Noir | Notice PMB — aucun candidat trouvé |
| **VALIDE** | Vert | Notice validée manuellement par l'utilisateur |

### 4.6 Étape 4 — Présentation et validation par l'utilisateur

**Tableau de bord** avec compteurs par statut, graphique en barres des champs impactés, tableau paginé des notices.

**Vue détail d'une notice** :
- Récapitulatif complet Syracuse (tous les champs non vides).
- Tableau comparatif dynamique champ par champ Syracuse ↔ Sudoc.
- Boutons d'action par écart : **Accepter** (prendre la valeur Sudoc) / **Conserver** (valeur Syracuse) / **Modifier** (saisie libre).
- Boutons globaux : **Tout accepter** / **Tout rejeter** / **Valider la notice**.

**Vue rattachement SRU** (Catégorie B) :
- Récapitulatif Syracuse en tête.
- Pour chaque candidat SRU : tableau comparatif complet des champs non vides des deux côtés (Syracuse ↔ Sudoc), lien direct vers la fiche Sudoc en ligne, bouton « Sélectionner et rattacher ».
- Bouton « Aucun ne correspond ».

### 4.7 Étape 5 — Export (multiple formats)

L'application propose **trois formats d'export** :

**1. XML Syracuse corrigé** (`/api/export/{sessionId}/xml`)
- Format XML identique à l'entrée, avec les valeurs corrigées.
- Structure préservée (noms de propriétés, attributs `rank`, `referentialType`, `referentialName`).
- Utilisé pour réimport dans Syracuse.

**2. UNIMARC textuel** (`/api/export/{sessionId}/txt`)
- Format textuel compatible **copier-coller dans WINIBW**.
- Voir §4bis.7 pour le détail du format.

**3. CSV des écarts** (`/api/export/{sessionId}/csv`)
- Rapport de synthèse : PPN, identifiant Syracuse, champ, valeur Syracuse, valeur Sudoc, statut, action, valeur finale.
- Utilisé pour reporting et audit.

---

## 4bis. Règles de normalisation et d'enrichissement automatique

### 4bis.1 Normalisation du champ ISBN (010 $b) — reliure

| Abréviation | Forme développée |
|-------------|------------------|
| `br.` | `broché` |
| `rel.` | `relié` |

Transformation automatique, sans validation utilisateur.

### 4bis.2 Génération automatique de l'EAN à partir de l'ISBN

Si EAN vide dans Sudoc ET dans Syracuse mais ISBN présent :
```
EAN = ISBN.replace(/-/g, '')
```
Exemple : ISBN `978-2-3260-0345-3` → EAN `9782326003453`. Statut **GENERE_AUTO**.

### 4bis.3 Génération automatique du type de support matériel (183)

Si zone 183 absente : proposition de génération sous forme `183 ##$P01$anga` (volume imprimé, code RDA).

### 4bis.4 Normalisation de la description matérielle (215 $a)

Transformations dans l'ordre :

1. `1 vol.` → `1 volume` (variantes : `1vol.`, `1 Vol.`)
2. ` p.` → ` pages` (attention à `p.` faisant partie d'un autre mot)
3. Si pagination sans `volume` : préfixer par `1 volume `
4. Ajout des parenthèses autour de la pagination : `1 volume NNN pages` → `1 volume (NNN pages)`

| Avant | Après |
|-------|-------|
| `1 vol. (151 p.) Tableaux 22 cm` | `1 volume (151 pages) Tableaux 22 cm` |
| `220 pages 24 cm` | `1 volume (220 pages) 24 cm` |
| `1 volume 220 pages 24 cm` | `1 volume (220 pages) 24 cm` |

### 4bis.5 Fusion des mentions d'illustrations (215 $c)

Union des ensembles Syracuse + Sudoc (sans doublons), ordre Sudoc d'abord puis mentions spécifiques Syracuse. Statut **FUSION**.

### 4bis.6 Suggestion IA de mots-clés RAMEAU

**Architecture — API LLM externe configurable** :
- L'utilisateur configure sa propre connexion vers un LLM compatible OpenAI.
- Service par défaut : **LLM du SSP Cloud de l'Insee**
  - Endpoint : `https://llm.lab.sspcloud.fr/api/chat/completions`
  - Authentification : clé d'API personnelle (générée dans les paramètres SSP Cloud)
  - Modèles : chargés dynamiquement via `/models`
- Panneau de configuration : endpoint, clé d'API (masquée), sélecteur de modèle, bouton « Tester ».
- Le backend joue le rôle de proxy pour ne pas exposer la clé dans le navigateur.

**Sources utilisées pour le prompt** :
- La suggestion se base sur les données **Sudoc** de la notice (après rattachement pour les Catégorie B), pas sur les données Syracuse (souvent vides pour les notices PMB).
- Champs utilisés : titre, éditeur, collection, résumé, table des matières.
- Le prompt liste aussi les vedettes existantes pour éviter les doublons.

**Prompt système** : le LLM est positionné comme bibliothécaire spécialisé RAMEAU.

**Prompt utilisateur** : demande de 3 à 7 vedettes au format `Terme principal Subdivision_sujet Subdivision_géographique Subdivision_chronologique`, une par ligne, sans numérotation.

**Post-traitement** : parsing ligne par ligne, filtrage des doublons avec les vedettes existantes.

**Présentation dans l'interface** : section dédiée « Suggestions IA mots-clés » avec chaque suggestion éditable + boutons « Ajouter » / « Ignorer ».

**Sécurité de la clé d'API** :
- Transmise au backend uniquement pour la durée de chaque requête.
- Jamais persistée côté serveur, jamais logguée.
- Stockée uniquement dans le state React côté navigateur.
- Appel LLM effectué côté serveur (Node.js) pour ne pas exposer la clé.

### 4bis.7 Export UNIMARC textuel pour WINIBW (nouveauté v1.4)

L'application produit un fichier texte au format UNIMARC compatible copier-coller dans WINIBW, à partir du XML UNIMARC brut récupéré depuis le Sudoc.

**Format d'une ligne** :
```
<TAG><ESPACE><INDICATEURS>$<CODE><VALEUR>$<CODE><VALEUR>...
```

- `<TAG>` : 3 chiffres (zone UNIMARC), ex. `010`, `200`, `214`, `606`, `700`
- `<INDICATEURS>` : 2 caractères (chiffre ou `#` pour espace)
- Sous-zones : `$<code><valeur>` collées sans espace entre elles

**Traitement particulier des controlfields** :
- Tags 001-007 : `TAG VALEUR` (sans `$`)
- Tag 008 : `TAG $aVALEUR` (avec préfixe `$a`, format Sudoc)

**Traitement particulier de la zone 100 (conversion UNIMARC standard → format Sudoc)** :

Le webservice `https://www.sudoc.fr/{PPN}.xml` expose la zone 100 au format **UNIMARC standard** (une seule sous-zone `$a` de 36 caractères codés à positions fixes). WINIBW attend le **format Sudoc** où les informations sont éclatées en sous-zones. Documentation : https://documentation.abes.fr/sudoc/formats/unmb/zones/100.htm

L'application doit détecter la zone 100 avec une chaîne `$a` longue et la reconvertir :

- Positions 0-7 : date d'entrée dans le Sudoc → **ignorer**
- Position 8 : code de type de date (lettre)
- Positions 9-12 : 1ère date (4 chiffres ou X)
- Positions 13-16 : 2ème date

Table de correspondance position 8 → sémantique Sudoc :

| Pos. 8 | Type | 1er ind. | 1ère date | 2ème date |
|--------|------|----------|-----------|-----------|
| `a` | ressource continue | `1` | `$a` | `$b` |
| `b` | ressource date ouverte | `1` | `$a` | `$d` (avec "-...") |
| `d` | monographie 1 volume | `0` | `$a` | (rien) |
| `e` | reproduction | `0` | `$a` | (rien) |
| `f` | date incertaine | `1` | `$a` | `$c` |
| `g` | monographie multivolumes | `0` | `$a` | `$b` |
| `h` | livre ancien (2 dates) | `0` | `$a` (publication) | `$f` (copyright) |
| `j` | enregistrement sonore | `0` | `$a` | (rien) |
| autre | inconnu | `#` | `$a` | (rien) |

Exemple : `100 ##$a20230214h20222022k  y0frey50      ba` → `100 0#$a2022$f2022`

**Autres zones** : les zones 008, 104, 105, 106, 181-183, 200, 210, 214, 215, 225, 606, 700 etc. sont déjà exposées au format Sudoc par le webservice — **aucune conversion** nécessaire.

**Filtrage des zones d'exemplaires** : les zones 915, 917, 930, 940, 941, 991, 999 concernent les données de localisation des exemplaires dans d'autres bibliothèques et **ne doivent pas** apparaître dans le fichier destiné à WINIBW. Elles sont filtrées à l'export.

**Séparation entre zones et notices** :
- Un seul `\n` entre chaque zone d'une notice
- Séparateur visuel entre notices : `\n\n----------------------------------------\n\n`

**Application des corrections utilisateur sur le texte UNIMARC** :
Un mapping inverse `SYRACUSE_TO_UNIMARC` permet, pour chaque écart accepté ou modifié, de remplacer la valeur dans la bonne sous-zone du texte UNIMARC. Si la zone/sous-zone n'existe pas dans le XML d'origine (cas d'un ajout de vedette matière IA), une nouvelle ligne UNIMARC est ajoutée en fin de notice.

Mapping des champs Syracuse vers les zones/sous-zones UNIMARC :

| Champ Syracuse | Tag | Sous-zone |
|----------------|-----|-----------|
| Titre | 200 | $a |
| ISBN | 010 | $a |
| EAN | 073 | $a |
| Editeur | 214 | $c |
| Publié le | 214 | $d |
| Description matérielle | 215 | $a |
| Collection | 225 | $a |
| Résumé | 330 | $a |
| Table des matières | 327 | $a |
| Auteur principal - Personne physique | 700 | $a |
| Vedette matière - Nom commun | 606 | $a |
| Vedette matière - Nom géographique | 607 | $a |
| Vedette matière - Forme, genre | 608 | $a |
| Vedette matière - Nom de personne | 600 | $a |
| Vedette matière - Nom de collectivité | 601 | $a |
| Notes | 300 | $a |
| Prix | 010 | $d |

**Mise à jour du PPN pour les notices rattachées SRU** :
Pour les notices Catégorie B rattachées via SRU, la zone 003 (URI du PPN) doit refléter le nouveau PPN Sudoc, pas l'ancien identifiant PMB.

---

## 5. Champs à vérifier

### 5.1 Champs critiques (vérification systématique)

| Champ Syracuse | Zone UNIMARC | Priorité |
|----------------|--------------|----------|
| `Titre` | 200 $a $e | Haute |
| `Auteur principal - Personne physique` | 700 | Haute |
| `Editeur` | 210/214 $c | Haute |
| `Publié le` | 210/214 $d | Haute |
| `ISBN` | 010 $a | Haute |
| `EAN` | 073 $a | Moyenne |

### 5.2 Champs de complétion

| Champ | Zone | Intérêt |
|-------|------|---------|
| `Résumé` | 330 $a | Fort |
| `Table des matières` | 327 $a | Fort |
| `Collection` | 225 $a | Moyen |
| `Autres auteurs` | 701 | Moyen |
| `Vedettes matières` | 606-608 | Fort (avec IA) |

### 5.3 Champs exclus (non modifiables)

`Identifiant`, `Identifiant d'origine` (sauf lors du rattachement SRU), `Filtre`, `Règle`, `Nombre d'exemplaires`, `Référence commerciale`, `Type de notice`, `Document`, `EAN (valeur)`, `UPC`, `Nom - Responsabiblité`, `Titre uniforme`, `Titre : volume`, `Titre de partie et N° de partie`, `Titre de série`, `Tome`.

---

## 6. Spécifications techniques

### 6.1 Architecture applicative

**Application web full-stack** :
- Frontend React (SPA)
- Backend Node.js/Express (également serveur Vite en dev, statique en production)
- Stockage en mémoire (sessions)
- Appels HTTPS sortants vers API ABES et LLM SSP Cloud

```
┌──────────────────────────────────┐
│        Interface (React)          │
│  - Upload XML                     │
│  - Dashboard de comparaison       │
│  - Vue détail + rattachement SRU  │
│  - Configuration LLM              │
│  - Exports (XML / TXT / CSV)      │
└──────────────┬───────────────────┘
               │ API REST
┌──────────────▼───────────────────┐
│    Backend (Node.js/Express)      │
│  - Parsing XML Syracuse           │
│  - Appels Sudoc (PPN, SRU, merged)│
│  - Parsing UNIMARC XML            │
│  - Normalisation & comparaison    │
│  - Proxy LLM (SSP Cloud)          │
│  - Génération XML/TXT/CSV         │
└──────────────┬───────────────────┘
               │ HTTPS
       ┌───────┴───────┐
       │               │
┌──────▼─────┐  ┌──────▼──────────┐
│ APIs Sudoc │  │ LLM SSP Cloud   │
│ (publiques)│  │ (avec clé user) │
└────────────┘  └─────────────────┘
```

### 6.2 Stack technologique

- **Backend** : Node.js + Express (TypeScript)
- **Parsing XML** : `fast-xml-parser`
- **HTTP** : `axios`
- **Comparaison fuzzy** : `string-similarity`
- **Frontend** : React + TypeScript + Tailwind CSS + Recharts (graphiques) + lucide-react (icônes)
- **Build** : Vite
- **Server-Sent Events** : pour la progression de la vérification

### 6.3 Modèle de données interne (structure de session)

```typescript
type Session = {
  originalXml: string;          // XML source complet (chaîne)
  parsedXml: any;               // XML parsé (arbre JSON)
  notices: Notice[];            // Liste des notices avec propriétés brutes
  results: Result[];            // Résultats de comparaison
  status: 'UPLOADED' | 'VERIFYING' | 'COMPLETED' | 'ERROR';
  progress: { current: number; total: number; currentPpn?: string };
};

type Notice = {
  ppn: string | null;           // PPN si Cat A, null si Cat B
  titre: string | null;
  identifiant: string;          // Identifiant Syracuse (clé stable)
  categorie: 'A' | 'B';
  syracuse: Record<string, string>; // Objet plat des propriétés Syracuse
  properties: any[];            // Tableau brut des <property> du XML
  itemType: string;             // Ex: 'GESMARC'
};

type Result = {
  ppn: string;
  identifiant: string;          // Clé stable pour les recherches
  titre: string;
  categorie: 'A' | 'B';
  syracuse: any;                // Copie des données Syracuse
  sudoc?: any;                  // Données Sudoc parsées (après rattachement)
  sudocXml?: string;            // XML UNIMARC brut du Sudoc (pour export TXT)
  statutGlobal: string;         // OK | ERREUR | COMPLEMENT | NON_TROUVE
                                // | EN_ATTENTE_RATTACHEMENT | RATTACHE_SRU
                                // | ABSENT_SUDOC | VALIDE
  ecarts: Ecart[];              // Détail des différences champ par champ
  candidates?: any[];           // Candidats SRU (Catégorie B)
  sruCandidates?: any[];        // Alias pour compat frontend
  aiSuggestions?: string[];     // Suggestions IA de vedettes RAMEAU
  nbErreurs?: number;
  nbComplements?: number;
  nbMineures?: number;
};

type Ecart = {
  champ: string;                // Nom du champ Syracuse
  valeurSyracuse: string;
  valeurSudoc: string;
  statut: string;               // IDENTIQUE | ERREUR | MANQUANT_SYRACUSE ...
  action?: 'ACCEPTER' | 'CONSERVER' | 'MODIFIER';
  valeurModifiee?: string;
};
```

### 6.4 API Backend — Endpoints

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/upload` | Upload du XML, création de session |
| POST | `/api/verify/:sessionId` | Lancement de la vérification |
| GET | `/api/progress/:sessionId` | SSE de progression |
| GET | `/api/results/:sessionId` | Liste complète des résultats |
| GET | `/api/results/:sessionId/summary` | Synthèse (compteurs, stats) |
| POST | `/api/results/:sessionId/:identifiant/rattacher` | Rattacher une notice PMB à un PPN Sudoc |
| POST | `/api/results/:sessionId/:identifiant/absent` | Marquer une notice PMB comme absente |
| POST | `/api/results/:sessionId/:identifiant/valider` | Valider une notice (statut VALIDE) |
| PUT | `/api/results/:sessionId/:identifiant/action` | Enregistrer une action sur un écart (accepter/modifier/conserver) |
| POST | `/api/results/:sessionId/bulk-action` | Actions en masse sur les écarts d'une notice |
| PUT | `/api/results/:sessionId/:identifiant/add-keyword` | Ajouter un mot-clé RAMEAU (suggestion IA) |
| POST | `/api/llm/models` | Charger dynamiquement la liste des modèles LLM |
| POST | `/api/llm/test` | Tester la connexion LLM |
| POST | `/api/suggest-keywords/:sessionId/:identifiant` | Générer les suggestions IA de vedettes |
| GET | `/api/export/:sessionId/xml` | Exporter le XML Syracuse corrigé |
| GET | `/api/export/:sessionId/txt` | Exporter au format UNIMARC textuel (WINIBW) |
| GET | `/api/export/:sessionId/csv` | Exporter le rapport CSV des écarts |
| GET | `/api/sudoc/:ppn` | Récupérer une notice Sudoc par PPN (utilitaire) |
| GET | `/api/sru/search?title=...` | Recherche SRU (utilitaire de test) |

**Clé de recherche pour tous les endpoints par notice** : toujours utiliser `identifiant` (identifiant Syracuse, clé stable qui ne change pas lors du rattachement SRU), jamais `ppn` (qui change lors du rattachement).

### 6.5 Contraintes et limites

- **Débit API Sudoc** : 500 ms entre requêtes. Pour 100 notices : ~1 minute. Pour 1000 notices : ~10 minutes.
- **Taille de fichier** : jusqu'à 50 Mo (~5000 notices).
- **Timeout** : 15 s par requête Sudoc, 30 s pour le LLM.
- **Sessions** : stockées en mémoire (perdues au redémarrage du serveur).

---

## 7. Interface utilisateur

### 7.1 Écran Upload

Zone drag-and-drop pour le fichier XML. Affichage post-parsing : nombre total de notices, nombre Cat A / Cat B. Lancement automatique de la vérification.

### 7.2 Écran Vérification (progression)

Barre de progression avec compteur (current/total) et affichage de l'identifiant en cours de traitement.

### 7.3 Écran Tableau de bord

- Panneau de configuration LLM (repliable) : endpoint, clé d'API, sélecteur de modèle, bouton test.
- 6 cartes de statistiques colorées : OK / Compléments / Erreurs / Non trouvées / PMB en attente / Absentes.
- Graphique en barres horizontal des champs les plus impactés.
- Tableau paginé des notices avec filtres (par statut) et recherche libre (PPN/identifiant/titre).
- Boutons d'export : CSV / XML / UNIMARC (TXT).

### 7.4 Écran Détail d'une notice

**Cas notice Catégorie A vérifiée** :
- En-tête : titre, PPN (avec lien Sudoc et lien XML), identifiant Syracuse.
- Boutons globaux : « Tout accepter » / « Tout rejeter » / « Valider la notice ».
- Tableau comparatif dynamique : champ, valeur Syracuse, valeur Sudoc, statut, boutons d'action.
- Case à cocher « Afficher les champs identiques ».
- Section suggestions IA mots-clés.

**Cas notice Catégorie B en attente** :
- En-tête : « Recherche dans le Sudoc — Candidats trouvés ».
- Récapitulatif Syracuse (tous les champs non vides) en carte grise.
- Un seul candidat : tableau comparatif complet Syracuse ↔ Sudoc + boutons « Rattacher » / « Pas la bonne ». Lien direct vers la fiche Sudoc.
- Plusieurs candidats : un bloc par candidat avec tableau comparatif complet, lien Sudoc, bouton « Sélectionner et rattacher ».
- Bouton « Aucun ne correspond ».

**Cas notice Catégorie B rattachée** :
- Bandeau indigo « Rattachée au Sudoc via SRU — PPN nouveau (ancien PMB : identifiant) ».
- Ensuite comme cas Catégorie A.

**Cas notice absente** :
- Bandeau gris « Aucune notice trouvée dans le Sudoc. Conservée telle quelle. ».

### 7.5 Suggestions IA de vedettes RAMEAU

- Section dédiée dans la vue détail (fond violet).
- Bouton « Générer » (visible uniquement si notice comparée avec Sudoc).
- Affichage des suggestions générées, chacune éditable, avec boutons « Ajouter » et « Ignorer ».
- Le mot-clé ajouté est intégré au champ Syracuse `Vedette matière - Nom commun` avec le suffixe ` rameau`.

---

## 8. Mapping détaillé UNIMARC ↔ Syracuse

### 8.1 Tableau de correspondance

| Champ Syracuse | Zone UNIMARC | Sous-zones | Règle |
|----------------|--------------|------------|-------|
| `Titre` | 200 | $a, $e | Concaténer $a + " " + $e |
| `Auteur principal - Personne physique` | 700 | $a, $b, $f, $3, $4 | `Nom Prénom dates IdRef code_fonction` |
| `Autre auteur principal - Personne physique` | 701 | $a, $b, $f, $3, $4 | Multiples séparés par ` ; ` |
| `Auteur secondaire - Personne physique` | 702 | $a, $b, $f, $3, $4 | Multiples séparés par ` ; ` |
| `Auteur principal - Collectivité ` | 710 | $a, $b, $3, $4 | Multiples séparés par ` ; ` |
| `Autre auteur principal - Collectivité` | 711 | $a, $b, $3, $4 | Multiples séparés par ` ; ` |
| `Auteur secondaire- Collectivité` | 712 | $a, $b, $3, $4 | Multiples séparés par ` ; ` |
| `Editeur` | 214 (défaut) ou 210 | $c | Premier éditeur si plusieurs 214 |
| `Publié le` | 214 ou 210 | $d | Année 4 chiffres |
| `ISBN` | 010 | $a | Format avec tirets |
| `EAN` | 073 | $a | Numérique brut |
| `Collection` | 225 | $a | Multiples avec ` ; ` |
| `Description matérielle` | 215 | $a, $c, $d | Concaténer avec normalisation |
| `Résumé` | 330 | $a | Texte intégral |
| `Table des matières` | 327 | $a | Texte intégral |
| `Vedette matière - Nom commun` | 606 | $a, $x, $y, $z | `$a $x $y $z rameau`, multiples avec `; ` |
| `Vedette matière - Nom géographique` | 607 | $a, $x | `$a $x rameau` |
| `Vedette matière - Nom de personne` | 600 | $a, $b, $f | `$a $b $f` |
| `Vedette matière - Nom de collectivité` | 601 | $a, $b | `$a $b` |
| `Vedette matière - Forme, genre` | 608 | $a | `$a rameau` |
| `Prix` | 010 | $d | Texte libre (ex. `22 EUR`) |
| `Notes` | 300-305 | $a | Concaténation avec ` ; ` |

### 8.2 Structure du XML UNIMARC retourné par Sudoc

```xml
<record>
  <leader>cam0 22        450 </leader>
  <controlfield tag="001">267670346</controlfield>
  <controlfield tag="008">Aax3</controlfield>
  <datafield tag="200" ind1="1" ind2=" ">
    <subfield code="a">Titre</subfield>
    <subfield code="e">Sous-titre</subfield>
    <subfield code="f">Mention de responsabilité</subfield>
  </datafield>
  <!-- ... autres datafields ... -->
</record>
```

Le parseur doit :
- Itérer sur les `<datafield>` en filtrant par attribut `tag`.
- Pour chaque, extraire les `<subfield>` par attribut `code`.
- Gérer les champs répétables (plusieurs `<datafield>` avec le même tag).

---

## 9. Gestion des cas particuliers

### 9.1 Notice fusionnée dans le Sudoc

Si HTTP 404, appeler `www.sudoc.fr/services/merged/{PPN}` pour vérifier une fusion et utiliser le nouveau PPN.

### 9.2 Notice absente du Sudoc

Après échec du PPN direct et de la stratégie de secours (merged, isbn2ppn, ean2ppn), marquer NON_TROUVE (Catégorie A) ou ABSENT_SUDOC (Catégorie B).

### 9.3 PPN tronqué (perte du zéro initial)

Détecter les PPN à 8 caractères et ajouter un `0` initial pour retrouver le PPN à 9 caractères. Appliquer systématiquement dans les affichages et les appels backend.

### 9.4 Encodage et caractères spéciaux

- Données Sudoc et Syracuse en UTF-8.
- Normaliser guillemets typographiques (`«»`), tirets (`–—`), espaces insécables, apostrophes (`'` vs `'`).
- Préserver l'encodage à l'export.

---

## 10. Déploiement — SSP Cloud avec ArgoCD

### 10.1 Architecture de déploiement

L'application est déployée sur le **SSP Cloud de l'Insee** avec la stack suivante :

- **Code source** : GitHub (dépôt public ou privé)
- **Registry d'images Docker** : GHCR (GitHub Container Registry)
- **Orchestrateur** : Kubernetes du SSP Cloud
- **Déploiement** : Helm chart déployé via ArgoCD
- **URL d'accès** : `https://app-<prenom>-<nom>.lab.sspcloud.fr`

### 10.2 Chaîne CI/CD

```
┌───────────┐   git push   ┌────────────┐   GH Actions   ┌────────┐
│ Développeur│─────────────▶│  GitHub    │───────────────▶│  GHCR  │
└───────────┘              │ (main)     │  build+push    │ (image)│
                           └────────────┘                └────┬───┘
                                                              │
                                                              │ ArgoCD (polling)
                                                              ▼
                                                       ┌─────────────┐
                                                       │  Kubernetes │
                                                       │  SSP Cloud  │
                                                       └─────────────┘
```

### 10.3 Structure du Helm chart

Chart générique `aistudio-app-chart` avec :
- `Chart.yaml`
- `values.yaml` : image, replicas, service, ingress, ressources, variables d'environnement
- `templates/deployment.yaml`
- `templates/service.yaml`
- `templates/ingress.yaml`
- `templates/secret.yaml` (optionnel)
- `templates/pvc.yaml` (optionnel)

### 10.4 Application ArgoCD

L'application ArgoCD pointe vers le dépôt GitHub (branche `main`) et déploie automatiquement les nouvelles versions du chart Helm. Auto-sync activée.

### 10.5 Gestion des secrets — IMPORTANT

**L'application ne nécessite aucun secret côté serveur** grâce à son architecture :

1. **API Sudoc** : entièrement publique, aucune authentification requise. Aucun secret à stocker.

2. **Clé d'API LLM SSP Cloud** : gérée **côté utilisateur uniquement**.
   - L'utilisateur saisit sa propre clé personnelle dans le panneau de configuration LLM du frontend.
   - Le frontend transmet cette clé au backend uniquement pour la durée de chaque requête LLM.
   - Le backend agit comme proxy vers `https://llm.lab.sspcloud.fr/api/chat/completions`.
   - **La clé n'est jamais persistée** : ni dans les logs, ni dans un fichier de configuration, ni en base de données.
   - Elle est stockée uniquement dans le state React (perdue au rechargement de la page).

3. **Compte de service Kubernetes** : **non nécessaire** dans la configuration actuelle.
   - L'application ne fait pas d'appels à l'API Kubernetes.
   - Elle n'accède pas aux ressources du cluster autres que ses propres pods.
   - Le compte de service par défaut de Kubernetes (`default`) est suffisant.
   - Pas de rôle RBAC personnalisé requis.

**Aucune action n'est requise pour créer un compte de service ou provisionner des secrets.** L'application fonctionne avec la configuration par défaut de Kubernetes SSP Cloud.

### 10.6 Variables d'environnement (optionnelles)

- `NODE_ENV` : `production` pour servir le build statique Vite depuis `dist/`.
- `PORT` : port d'écoute (défaut : 3000).

### 10.7 Ressources Kubernetes recommandées

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "1Gi"
    cpu: "500m"
```

Le stockage temporaire (sessions en mémoire) tient en RAM. Aucun volume persistant nécessaire pour le fonctionnement courant.

### 10.8 Contraintes réseau

- **Sortie HTTPS vers** :
  - `www.sudoc.fr` (webservice UNIMARC, isbn2ppn, ean2ppn, merged)
  - `www.sudoc.abes.fr` (SRU)
  - `llm.lab.sspcloud.fr` (LLM)
- **Entrée HTTPS** : via l'ingress SSP Cloud sur le hostname `app-<prenom>-<nom>.lab.sspcloud.fr`.

Le proxy sortant du SSP Cloud est transparent pour ces domaines qui sont autorisés par défaut.

---

## 11. Sécurité

- **Données** : notices bibliographiques sans données personnelles sensibles. Sudoc sous Licence Ouverte.
- **Réseau** : uniquement des appels HTTPS vers API publiques et LLM SSP Cloud.
- **Stockage** : sessions en mémoire pour la durée d'utilisation, pas de base de données.
- **Authentification** : pas d'authentification applicative (protection assurée par l'ingress SSP Cloud si activée au niveau du namespace).
- **Clé d'API LLM** : jamais persistée, cf. §4bis.6 et §10.5.

---

## 12. Tests et validation

### 12.1 Jeu de test

Fichier d'exemple `ExportSyracuse_Panier-catalogue_20260225_112837.xml` (100 notices mixtes) et `echantillon_10_notices_incompletes.xml` (10 notices PMB).

### 12.2 Cas de test critiques

| Cas | Attendu |
|-----|---------|
| Notice Cat A avec PPN valide | Comparaison complète, écarts détectés |
| Notice Cat B avec 1 candidat SRU | Écran de rattachement avec tableau comparatif complet |
| Notice Cat B avec plusieurs candidats | Blocs de candidats, chacun avec tableau comparatif et bouton rattacher |
| Notice avec PPN commençant par 0 | Padding correct → URL Sudoc fonctionne |
| Export XML | Notices bien reconstruites, déclaration `<?xml ?>` en tête |
| Export UNIMARC TXT | Format WINIBW valide, zone 100 convertie Sudoc, filtrage 9XX exemplaires |
| Rattachement SRU | Zone 003 mise à jour avec le nouveau PPN dans le TXT |
| Suggestion IA | Vedettes générées à partir des données Sudoc, filtrage des doublons |
| Ajout mot-clé RAMEAU | Nouvelle ligne 606 dans l'export TXT |

### 12.3 Validation des exports

- XML : bien formé, réimportable dans Syracuse.
- TXT UNIMARC : format compatible WINIBW, testable par copier-coller.
- CSV : encodable UTF-8 avec BOM pour Excel, séparateurs corrects.

---

## 13. Résumé des évolutions v1.4

1. **Export UNIMARC textuel** pour copier-coller dans WINIBW (nouveau format `.txt`).
2. **Conversion zone 100** UNIMARC standard (chaîne 36 car) → format Sudoc (sous-zones $a, $b, $c, $d, $f).
3. **Filtrage des zones d'exemplaires** (915, 917, 930, 940, 941, 991, 999) à l'export TXT.
4. **Traitement particulier des controlfields** : tag 008 avec préfixe `$a`, autres sans.
5. **Séparateur visuel entre notices** (`----------------------------------------`) dans le TXT.
6. **PPN padding systématique** à 9 caractères pour éviter les 404 (frontend et backend).
7. **Lien Sudoc cliquable** sur les candidats uniques dans la vue rattachement.
8. **Tableau comparatif dynamique** pour les candidats SRU (tous les champs non vides des deux côtés).
9. **Récapitulatif Syracuse complet** dans la vue rattachement (tous les champs non vides).
10. **Bouton « Sélectionner et rattacher »** fonctionnel pour candidats multiples (padding + backend).
11. **Correction export XML** (auparavant vide) : itération sur `session.notices` et non `session.parsedXml.items.item`.
12. **Correction suggestions IA** : recherche par `identifiant` Syracuse (clé stable), plus par PPN (qui change lors du rattachement).
13. **Ajout des champs IA/compléments** aux exports (XML et TXT) : nouveaux `<property>` / lignes UNIMARC.
14. **Documentation du déploiement SSP Cloud** avec ArgoCD (chart Helm, absence de secrets nécessaires).

---

## 14. Références externes

- **Documentation Sudoc / format UNIMARC/B** : https://documentation.abes.fr/sudoc/formats/unmb/zones/
- **Zone 100 (dates)** : https://documentation.abes.fr/sudoc/formats/unmb/zones/100.htm
- **Zone 214 (publication)** : https://documentation.abes.fr/sudoc/formats/unmb/zones/214.htm
- **API webservice UNIMARC** : `https://www.sudoc.fr/{PPN}.xml`
- **API SRU** : `https://www.sudoc.abes.fr/cbs/sru/`
- **LLM SSP Cloud** : `https://llm.lab.sspcloud.fr/api/chat/completions`
- **Documentation SSP Cloud** : https://docs.sspcloud.fr/
- **ArgoCD** : https://argo-cd.readthedocs.io/

---

## Annexe — Écarts connus entre ce document et le code

Relevé au 1ᵉʳ septembre 2026, **mis à jour après la session de mise en conformité**
du même jour. Le code est la référence.

Les lignes marquées ✅ ont été résolues depuis : la fonctionnalité spécifiée a été
implémentée, ou la décision a été prise et documentée. Elles sont conservées parce
qu'elles expliquent *pourquoi* le code est ce qu'il est. Les lignes restantes sont
des écarts assumés (le code a raison, ce document est simplement daté) ou des
points ouverts.

| § | Ce document annonce | Le code fait |
| --- | --- | --- |
| 6.2, 6.4 | progression par Server-Sent Events, `GET /api/progress/:sessionId` | polling du front sur `GET /api/status/:sessionId` |
| 3.1, 9.2 | secours par `isbn2ppn` et `ean2ppn` | ✅ implémenté dans `verify.ts` : ISBN puis EAN, avec bandeau d'avertissement dans l'interface |
| 4bis.3 | génération de la zone 183 (`183 ##$P01$anga`) | ✅ implémenté : pseudo-champ « Type de support (183) », proposé en `GENERE_AUTO`, ajouté au TXT si accepté |
| 4bis.5 | fusion des illustrations 215 `$c`, statut `FUSION` | ✅ implémenté (`buildFusedCollation`) ; l'écart porte ses sous-zones pour réécrire proprement la zone 215 |
| 4bis.7 | seules les zones d'exemplaires (915…999) sont filtrées à l'export TXT | `HOLDINGS_TAGS` **plus** `EXCLUDED_TAGS` (000, 004-008, 020, 579, 676, 680, 686, 801, 931, 990, 992) |
| 4bis.7 | tag 008 exporté sous la forme `TAG $aVALEUR` | ✅ tranché : ni 000 ni 008 à l'export — la notice existe déjà dans WINIBW. Code mort supprimé |
| 4.4 | auteurs comparés via l'IdRef ; titre comparé sans diacritiques | ✅ IdRef implémenté (même autorité ⇒ au pire `DIFFERENCE_MINEURE`) ; diacritiques du titre toujours ouverts |
| 4.4 | seuil éditeur > 0.85 (sans plus de détail) | > 0.85 ⇒ `IDENTIQUE`, > 0.5 ⇒ `DIFFERENCE_MINEURE` ; titre et champs génériques : > 0.9 ⇒ `DIFFERENCE_MINEURE` |
| 4.5 | statuts `SUGGESTION_IA` et `ABSENT_SUDOC_DEFINITIF` | inexistants ; `NON_VERIFIE` existe et n'est pas documenté ici |
| 5.3 | champs exclus incluant `Titre uniforme`, `Titre de série`, `Tome`, `Nom - Responsabiblité`, `Titre : volume`, `Titre de partie…` | `UNMODIFIABLE_FIELDS` ne les contient pas, et ajoute `Référence éditoriale` |
| 6.3 | types `Notice`, `Result`, `Ecart` | seul `Session` est déclaré ; le reste est typé `any` |
| 6.4 | « toujours `identifiant`, jamais `ppn` » comme clé de route | trois routes déclarent le paramètre `:ppn` (`suggest-keywords`, `update-ai-suggestions`, `add-keyword`) ; le front y passe bien l'identifiant, donc le comportement est correct |
| 6.4 | table des endpoints | `PUT /api/results/:sessionId/:ppn/update-ai-suggestions` manque |
| 6.5 | timeout LLM de 30 s | 30 s pour `/api/llm/test`, 60 s pour `/api/suggest-keywords` |
| 2.5 vs 3.2 | un PPN tronqué à 8 caractères est paddé | ✅ `padPpn` appliqué à tous les appels réseau ; `detectCategory` reste strict (forme indiscernable d'un identifiant PMB) mais le PPN paddé est proposé comme candidat de rattachement |
| 10.3, 10.4, 13.14 | déploiement par **chart Helm** | manifestes Kubernetes bruts dans `deploy/` + `application.yaml` ArgoCD |
| 10.1 | URL `app-<prenom>-<nom>.lab.sspcloud.fr` | `unimarc-sudoc-reconciler.lab.sspcloud.fr` (`deploy/ingress.yaml`) |
| 12.1 | jeu de test `ExportSyracuse_Panier-catalogue_*.xml`, `echantillon_10_notices_incompletes.xml` | ✅ `test/fixtures/` + 90 tests unitaires — mais fixtures **synthétiques**, pas de vraies notices capturées |
| 1.1 vs 1.2 / 4.7 | « exportées dans deux formats » | trois formats : XML, TXT UNIMARC, CSV |

### Corrections de bugs révélées par l'écriture des tests

Ces trois défauts n'étaient documentés nulle part — ni ici, ni dans le code :

| Bug | Effet | Correctif |
| --- | --- | --- |
| `fast-xml-parser` convertit les valeurs numériques en nombres | `026927438` devenait `26927438` : PPN de la zone 001 et IdRef `$3` amputés de leur zéro initial. C'est l'origine réelle des « PPN tronqués par le SRU » du §3.2 | `SUDOC_PARSER_OPTIONS` avec `parseTagValue: false`, appliqué à tous les parseurs |
| `/\bbr\.\b/` ne matche jamais « br. » en fin de chaîne | La normalisation de la reliure (§4bis.1) ne s'appliquait pas | regex sans `\b` final |
| indicateurs vides non convertis en `#` | Toutes les lignes à indicateur espace sortaient en `010 $a…` au lieu de `010 ##$a…` : export WINIBW malformé | test sur la chaîne vide, le parseur trimant les attributs |
