# Savoir métier : Syracuse, Sudoc et UNIMARC

Ce document rassemble les connaissances **bibliothéconomiques** nécessaires pour
comprendre et faire évoluer l'application : vocabulaire, formats, web services de
l'ABES, règles de normalisation, mapping UNIMARC ↔ Syracuse.

Il décrit l'état **effectivement implémenté** (voir `server/`). Les intentions de
conception initiales, parfois divergentes, sont archivées dans
[historique-conception.md](historique-conception.md).

- Vue d'ensemble de l'application : [../README.md](../README.md)
- Invariants à ne pas casser en modifiant le code : [../CLAUDE.md](../CLAUDE.md)

---

## 1. Vocabulaire

| Terme | Définition |
| --- | --- |
| **Syracuse** | Le SIGB (logiciel de gestion documentaire) du Centre de ressources documentaires de l'Insee. Source des notices à corriger. |
| **Sudoc** | Système Universitaire de DOCumentation : catalogue collectif français de l'enseignement supérieur, géré par l'**ABES**. Fait référence. |
| **PPN** | *Pica Production Number* : identifiant d'une notice dans le Sudoc. **Toujours 9 caractères** (8 chiffres + 1 caractère de contrôle, chiffre ou `X`). |
| **PMB** | *Personnal Media Base* : ancien système documentaire de l'Insee. Ses notices n'ont pas de PPN et doivent être recherchées dans le Sudoc par leur contenu. |
| **UNIMARC** | Format d'échange des notices bibliographiques. Zones à 3 chiffres (200 = titre, 010 = ISBN…), sous-zones `$a`, `$b`… |
| **WINIBW** | Client de catalogage professionnel du Sudoc. Accepte le collage de notices UNIMARC en **notation textuelle**. |
| **RAMEAU** | Référentiel d'indexation matière des bibliothèques françaises (vedettes matière). |
| **SRU** | *Search/Retrieve via URL* : protocole d'interrogation du catalogue Sudoc par critères (titre, auteur, année). |
| **IdRef** | Référentiel d'autorités (auteurs, collectivités) associé au Sudoc. Présent en `$3` des zones 7XX. |

---

## 2. Le fichier d'entrée : export XML Syracuse

Export de type « Panier-catalogue ». Il contient tout le nécessaire : l'identifiant
d'origine (PPN ou identifiant PMB) et l'ensemble des champs bibliographiques.

```xml
<items>
  <item type="GESMARC">
    <property name="NomDuChamp" value="ValeurDuChamp" rank="N"
              referentialType="" referentialName="" />
    <!-- ... -->
  </item>
</items>
```

Un `<item>` = une notice. `rank` donne l'ordre d'affichage ; `referentialType` et
`referentialName` servent aux champs référencés (le plus souvent vides). Ces
attributs sont **préservés à l'export** pour que le fichier reste réimportable.

### Champs rencontrés (43 propriétés)

**Identifiants** — `Identifiant d'origine` (PPN Sudoc ou identifiant PMB, toujours
rempli), `Identifiant` (clé interne Syracuse, **stable**), `ISBN`, `ISSN`, `EAN`,
`EAN (valeur)`, `Filtre` (`SUDOC` vs `PMB.BIB`).

**Description** — `Titre`, `Auteur principal - Personne physique`,
`Auteur principal - Collectivité ` (⚠️ espace final dans le libellé),
`Autre auteur principal - Personne physique`, `Autre auteur principal - Collectivité`,
`Auteur secondaire - Personne physique`, `Auteur secondaire- Collectivité`
(⚠️ espace manquant dans le libellé), `Editeur`, `Publié le`, `Collection`,
`Description matérielle`.

**Contenu et indexation** — `Résumé`, `Table des matières`, `Vedette matière - Nom
commun` (RAMEAU), `Vedette matière - Forme, genre`, `Vedette matière - Nom de
collectivité`, `Vedette matière - Nom de personne`, `Vedette matière - Nom
géographique`.

**Administratif** — `Prix`, `Référence commerciale`, `Référence éditoriale`,
`Document`, `Type de notice`, `Nombre d'exemplaires`, `Règle`, `Notes`.

**Souvent vides** — `Nom - Responsabiblité` (⚠️ faute d'orthographe dans le
libellé source, à reproduire tel quel), `UPC`, `Titre : volume`, `Titre de partie
et N° de partie`, `Titre uniforme`.

> Les libellés fautifs ou avec espaces parasites sont ceux **émis par Syracuse** :
> ils servent de clés dans `SYRACUSE_MAPPING` et ne doivent pas être « corrigés ».

### Deux catégories de notices

`detectCategory` (`server/syracuse.ts`) :

- **Catégorie A — rattachée au Sudoc** : le champ `Filtre` contient `SUDOC`
  (majuscules ignorées, donc `INSEESUDOC` compte aussi) **ou** l'identifiant
  d'origine correspond à `^[0-9]{8}[0-9X]$`.
- **Catégorie B — notice PMB** : tout le reste. Typiquement des identifiants de
  6-7 chiffres, ouvrages anciens (1950-1970) sans ISBN.

---

## 3. Interroger le Sudoc

### Web services de l'ABES

| Service | URL | Utilisé par l'appli |
| --- | --- | --- |
| Notice par PPN (UNIMARC XML) | `https://www.sudoc.fr/{PPN}.xml` | ✅ catégorie A et après rattachement |
| SRU (recherche par contenu) | `https://www.sudoc.abes.fr/cbs/sru/?operation=searchRetrieve&version=1.1&recordSchema=unimarc&maximumRecords=10&query=…` | ✅ catégorie B |
| PPN fusionné | `https://www.sudoc.fr/services/merged/{PPN}` | ✅ secours sur HTTP 404 |
| `isbn2ppn` | `https://www.sudoc.fr/services/isbn2ppn/{ISBN}` | ✅ secours quand le PPN ne répond pas |
| `ean2ppn` | `https://www.sudoc.fr/services/ean2ppn/{EAN}` | ✅ secours après l'ISBN |

Toutes ces API sont **publiques, sans authentification**. Données sous Licence
Ouverte. Timeout appliqué : 15 s par requête, avec une pause de 500 ms entre deux
notices (politesse envers l'ABES).

### Le PPN fait toujours 9 caractères

Quand un PPN commence par `0`, ce zéro est fréquemment perdu (PPN stocké comme
entier, ou retourné tronqué par certains services). Sans padding, l'URL Sudoc
renvoie un **HTTP 404**.

```
reçu     65493583  → https://www.sudoc.fr/65493583  → 404
paddé   065493583  → https://www.sudoc.fr/065493583 → OK
```

Le padding à 9 caractères est appliqué par `padPpn` (`server/marc.ts`) : à
l'entrée de `fetchSudocRecord`, sur les PPN renvoyés par le SRU et par
isbn2ppn/ean2ppn, au rattachement, et dans tous les affichages du front.

**Piège de parsing, à connaître.** `fast-xml-parser` convertit par défaut les
valeurs numériques en nombres : `026927438` devient `26927438`, `070` devient
`70`. C'est *là* que les PPN de la zone 001 et les IdRef de la sous-zone `$3`
perdaient leur zéro initial. Tous les parseurs du Sudoc utilisent donc
`SUDOC_PARSER_OPTIONS` avec `parseTagValue: false`. Ne pas le retirer.

> Cas non tranchable : un identifiant à 8 chiffres peut être un PPN amputé de son
> zéro **ou** un identifiant PMB — même forme. `detectCategory` reste donc strict
> (9 caractères exigés) et la notice part en catégorie B ; le PPN paddé y est
> ensuite proposé comme **candidat de rattachement** (piste `PPN_TRONQUE`), que la
> documentaliste valide ou refuse.

### Notice de catégorie A

1. Appel direct `https://www.sudoc.fr/{PPN}.xml` (PPN paddé).
2. Si HTTP 404 → `services/merged/{PPN}` : si un nouveau PPN est retourné, on
   relance la récupération avec celui-ci (récursif, avec garde-fou anti-boucle).
3. Secours par le contenu : `isbn2ppn` sur l'ISBN Syracuse, puis `ean2ppn` sur
   l'EAN. Le premier PPN qui ramène une notice l'emporte ; le résultat porte
   alors `ppnSourceSecours` et `ppnOrigine`, et l'interface affiche un bandeau
   d'avertissement — le PPN de Syracuse est faux, sa correction reste une
   décision humaine (l'application ne réécrit pas `Identifiant d'origine`).
4. Sinon → statut `NON_TROUVE`.

### Notice de catégorie B : PPN tronqué, puis recherche SRU en 3 niveaux

Avant la recherche par contenu, si l'identifiant a la forme d'un PPN amputé de
son zéro (8 caractères), le PPN paddé est interrogé au Sudoc. S'il répond, il
devient le **premier candidat** de la liste, marqué `PPN_TRONQUE`.


`searchSru` (`server/marc.ts`) tente successivement, en s'arrêtant au premier
niveau qui retourne au moins un résultat :

| Niveau | Requête |
| --- | --- |
| 1 | `mti={mots_titre}` + `aut={nom_auteur}` + `apu={année}` |
| 2 | `mti={mots_titre}` + `apu={année}` |
| 3 | `mti={mots_titre}` |

Construction des critères :

- **mots_titre** : jusqu'à 5 mots de plus de 2 lettres, ponctuation retirée, mots
  vides multilingues exclus (`STOP_WORDS` dans `server/marc.ts` : `the, a, an,
  of, in, on, to, for, and, or, its, by, with, from, le, la, les, de, du, des,
  un, une, et, en, au, aux, dans, par, sur, der, die, das, und, zu, von, im,
  ein, eine, für, mit`).
- **nom_auteur** : premier segment du nom de l'auteur principal personne physique,
  ou les 2 premiers mots significatifs de l'auteur collectivité.
- **année** : 4 chiffres extraits de `Publié le` (« C 2022 » → `2022`).

Traitement des résultats (10 au maximum, `maximumRecords=10`) :

| Résultats | Comportement |
| --- | --- |
| 0 aux 3 niveaux | Statut `ABSENT_SUDOC` — notice conservée telle quelle |
| 1 candidat | Tableau comparatif complet Syracuse ↔ Sudoc, boutons « Rattacher » / « Pas la bonne » |
| plusieurs | Un bloc comparatif par candidat, bouton « Sélectionner et rattacher » |

**Rattachement** : mise à jour de `Identifiant d'origine` avec le nouveau PPN
(paddé), récupération de la notice complète, comparaison classique, statut
`RATTACHE_SRU`. La zone `003` de l'export UNIMARC doit refléter le nouveau PPN,
pas l'ancien identifiant PMB.

---

## 4. Normaliser et comparer

Les mêmes données sont écrites différemment de part et d'autre. Écarts de
formatage récurrents :

1. **Titres** : ponctuation, espaces insécables, apostrophes typographiques.
2. **ISBN** : découpage en groupes variable, forme numérique identique.
3. **Auteurs** : le Sudoc donne `Nom, Prénom (dates ; qualificatif)` + IdRef ;
   Syracuse concatène `Nom Prénom dates IdRef code_fonction`.
4. **Année** : parfois préfixée `C ` (copyright) dans le Sudoc.
5. **Description matérielle** : `1 vol.`, `p.` à développer, parenthèses à poser.
6. **Reliure** : `br.` / `rel.` à développer en `broché` / `relié`.

### Règles de comparaison effectives (`server/compare.ts`)

`normalizeString` : minuscules, `;` et `:` → espace, apostrophes typographiques
unifiées, espaces insécables → espace, espaces multiples réduits.

| Champ | Règle | Seuils |
| --- | --- | --- |
| **ISBN** | tirets supprimés, égalité stricte | — |
| **EAN** | espaces supprimés, égalité stricte | — |
| **Publié le** | 4 premiers chiffres de chaque côté | — |
| **Titre** | `normalizeString` puis similarité | > 0.9 **ou** inclusion mutuelle ⇒ `DIFFERENCE_MINEURE`, sinon `ERREUR` |
| **Editeur** | minuscules + diacritiques retirés | > 0.85 ⇒ `IDENTIQUE` ; > 0.5 ⇒ `DIFFERENCE_MINEURE` ; sinon `ERREUR` |
| **Auteurs** (700/701/702, 710/711/712) | IdRef d'abord : les identifiants d'autorité à 9 caractères sont extraits des deux côtés | IdRef commun ⇒ `IDENTIQUE` si les graphies coïncident, sinon `DIFFERENCE_MINEURE` ; IdRef tous différents ⇒ `ERREUR` ; pas d'IdRef d'un côté ⇒ comparaison générique |
| **autres champs** | `normalizeString` puis similarité | > 0.9 ⇒ `DIFFERENCE_MINEURE`, sinon `ERREUR` |

Similarité calculée par `string-similarity` (Dice sur bigrammes).

Cas triviaux traités avant les règles ci-dessus : deux valeurs vides ⇒
`IDENTIQUE` ; Syracuse vide et Sudoc rempli ⇒ `MANQUANT_SYRACUSE` ; Syracuse
rempli et Sudoc vide ⇒ `ABSENT_SUDOC` ; champ non modifiable ⇒ `NON_VERIFIE`.

> Piste restante : suppression des diacritiques sur le titre (aujourd'hui seul
> `Editeur` et la comparaison des auteurs en bénéficient).

### Statuts d'écart

| Statut | Couleur UI | Sens |
| --- | --- | --- |
| `IDENTIQUE` | gris | identiques après normalisation |
| `DIFFERENCE_MINEURE` | bleu | écart de formatage seulement |
| `ERREUR` | rouge | divergence substantielle |
| `MANQUANT_SYRACUSE` | orange | vide dans Syracuse, renseigné dans le Sudoc |
| `ABSENT_SUDOC` | gris | renseigné dans Syracuse, vide dans le Sudoc |
| `NON_VERIFIE` | — | champ exclu de la vérification |
| `NORMALISE` | violet | valeur réécrite par une règle automatique |
| `GENERE_AUTO` | violet | valeur générée (EAN depuis l'ISBN) |
| `FUSION` | violet | union Syracuse + Sudoc (mentions d'illustrations, 215 `$c`) |

Statuts de notice (`statutGlobal`) : `OK`, `MINEURE`, `COMPLEMENT`, `ERREUR`,
`NON_TROUVE`, `EN_ATTENTE_RATTACHEMENT`, `RATTACHE_SRU`, `ABSENT_SUDOC`, `VALIDE`.

> ⚠️ `ABSENT_SUDOC` porte **deux sens** : au niveau d'un écart, « champ vide côté
> Sudoc » ; au niveau d'une notice, « notice PMB pour laquelle la recherche SRU n'a
> rien donné ». Le front les distingue en testant `categorie === 'B'`. Fragile.

### Champs exclus de la vérification

`UNMODIFIABLE_FIELDS` (`server/syracuse.ts`) : `Identifiant`,
`Identifiant d'origine`, `Filtre`, `Règle`, `Nombre d'exemplaires`,
`Référence commerciale`, `Référence éditoriale`, `EAN (valeur)`, `UPC`,
`Document`, `Type de notice`.

`Identifiant d'origine` est la seule exception : il est réécrit lors d'un
rattachement SRU.

### Champs prioritaires

- **Vérification systématique** : `Titre` (200 `$a$e`), `Auteur principal -
  Personne physique` (700), `Editeur` (214/210 `$c`), `Publié le` (214/210 `$d`),
  `ISBN` (010 `$a`), `EAN` (073 `$a`).
- **Complétion à fort intérêt** : `Résumé` (330), `Table des matières` (327),
  vedettes matières (606-608, avec l'appui du LLM), `Collection` (225),
  autres auteurs (701).

---

## 5. Règles d'enrichissement automatique

### Reliure (ISBN, 010 `$b`)

`br.` → `broché`, `rel.` → `relié`, appliqué à la lecture de la zone 010 `$b` du
Sudoc, sans validation utilisateur.

> La règle utilisait `/\bbr\.\b/` : après un point, `\b` réclame un caractère de
> mot, donc « br. » en fin de chaîne ne matchait jamais et la normalisation ne
> s'appliquait pas. Corrigé en `/\bbr\./`.

La valeur alimente un champ `reliure` affiché dans l'interface, mais qui n'est pas
dans `SYRACUSE_MAPPING` : elle n'est donc **pas comparée** à Syracuse ni reportée
dans les exports.

### EAN généré depuis l'ISBN

À la lecture de la notice Sudoc : si la zone 073 est absente mais l'ISBN présent,
`EAN = ISBN` sans tirets ni espaces — **à condition** que le résultat fasse
exactement 13 chiffres (un ISBN-10 ne produit donc pas d'EAN). Exemple :
`978-2-3260-0345-3` → `9782326003453`.

L'écart n'est proposé que si l'EAN Syracuse est vide : statut `GENERE_AUTO`,
action `ACCEPTER` par défaut.

### Type de support matériel (183)

Si la notice Sudoc n'a pas de zone 183 (`hasTypeSupport === false`), un écart est
proposé : champ `Type de support (183)`, valeur `183 ##$P01$anga` (volume imprimé,
code RDA), statut `GENERE_AUTO`, action `ACCEPTER` par défaut.

C'est un **pseudo-champ** : il n'existe pas dans Syracuse et ne concerne que la
notice UNIMARC. Deux conséquences dans le code :

- `PSEUDO_UNIMARC_FIELDS` (`server/syracuse.ts`) le recense, et `buildXmlExport`
  refuse d'en faire une `<property>` — sans quoi le réimport Syracuse échouerait ;
- la ligne 183 n'est ajoutée à l'export TXT que si l'action est restée
  `ACCEPTER`. Refusée, elle disparaît.

Le code `nga` vaut pour un volume imprimé : c'est le cas courant du fonds, mais la
proposition reste soumise à validation, jamais appliquée en silence.

### Description matérielle (215 `$a`)

Transformations, dans cet ordre :

1. `1 vol.` → `1 volume` (variantes `1vol.`, `1 Vol.`)
2. ` p.` → ` pages`
3. Pagination sans mention de volume → préfixer `1 volume `
4. Parenthéser la pagination

| Avant | Après |
| --- | --- |
| `1 vol. (151 p.) Tableaux 22 cm` | `1 volume (151 pages) Tableaux 22 cm` |
| `220 pages 24 cm` | `1 volume (220 pages) 24 cm` |
| `1 volume 220 pages 24 cm` | `1 volume (220 pages) 24 cm` |

Le résultat est présenté avec le statut `NORMALISE` (la valeur Syracuse d'origine
est barrée dans l'interface).

### Illustrations (215 `$c`)

Syracuse porte parfois une mention que le Sudoc ignore (« Tableaux ») : l'écraser
perdrait de l'information. `buildFusedCollation` (`server/marc.ts`) propose donc
l'**union**, Sudoc d'abord :

```
Sudoc     215 $a1 vol. (151 p.) $cill.        $d22 cm
Syracuse  « 1 vol. (151 p.) Tableaux 22 cm »
Fusion    « 1 volume (151 pages) ill., Tableaux 22 cm »   -> statut FUSION
```

Le vocabulaire reconnu est dans `ILLUSTRATION_TERMS`, les plus longs d'abord pour
que « couv. ill. » ne soit pas réduit à « ill. ». La comparaison est insensible à
la casse et aux accents, et la graphie du catalogueur est préservée.

L'écart porte en plus sa cible UNIMARC (`unimarc: { tag: '215', subfields }`) :
l'export TXT réécrit la zone 215 complète à partir des sous-zones, au lieu de
déverser la collation entière dans `$a` et de laisser `$c` en doublon.

> Le découpage repose sur un vocabulaire fini : une mention inconnue de
> `ILLUSTRATION_TERMS` ne sera pas fusionnée (elle repassera par la comparaison
> classique). Liste à compléter au vu de cas réels.

### Suggestions RAMEAU par LLM

- Endpoint compatible OpenAI (`/chat/completions`), configuré depuis l'interface.
  Défaut : le LLM du SSP Cloud, `https://llm.lab.sspcloud.fr/api/chat/completions`.
  La liste des modèles est déduite de l'endpoint (`server/llm.ts`) puis chargée
  dynamiquement.
- Le prompt s'appuie sur les données **Sudoc** de la notice (titre, éditeur,
  collection, résumé, table des matières) — pas sur Syracuse, souvent vide pour
  les notices PMB. Les vedettes déjà présentes sont listées pour éviter les
  doublons.
- Le LLM est positionné comme bibliothécaire spécialisé RAMEAU ; on demande 3 à 7
  vedettes au format `Terme principal Subdivision_sujet Subdivision_géographique
  Subdivision_chronologique`, une par ligne, sans numérotation. `temperature: 0`
  pour la reproductibilité.
- Post-traitement : découpage ligne à ligne, filtrage des doublons.
- Une vedette acceptée est ajoutée à `Vedette matière - Nom commun` avec le
  **suffixe ` rameau`** (convention Syracuse).
- La clé d'API ne vit que dans l'état React et le temps d'une requête : l'appel
  part du backend, elle n'est ni persistée ni journalisée.

---

## 6. Mapping UNIMARC ↔ Syracuse

### Lecture d'une notice Sudoc (`parseSudocRecord`)

| Champ Syracuse | Zone | Sous-zones | Règle |
| --- | --- | --- | --- |
| `Titre` | 200 | `$a`, `$e` | concaténation `$a` + espace + `$e` |
| `Auteur principal - Personne physique` | 700 | `$a $b $f $3 $4` | `Nom Prénom dates IdRef code_fonction` |
| `Autre auteur principal - Personne physique` | 701 | idem | multiples séparés par ` ; ` |
| `Auteur secondaire - Personne physique` | 702 | idem | multiples séparés par ` ; ` |
| `Auteur principal - Collectivité ` | 710 | `$a $b $3 $4` | multiples séparés par ` ; ` |
| `Autre auteur principal - Collectivité` | 711 | idem | multiples séparés par ` ; ` |
| `Auteur secondaire- Collectivité` | 712 | idem | multiples séparés par ` ; ` |
| `Editeur` | 214 (défaut) ou 210 | `$c` | premier éditeur si plusieurs 214 |
| `Publié le` | 214 ou 210 | `$d` | année sur 4 chiffres |
| `ISBN` | 010 | `$a` | forme avec tirets |
| `EAN` | 073 | `$a` | numérique brut |
| `Collection` | 225 | `$a` | multiples avec ` ; ` |
| `Description matérielle` | 215 | `$a $c $d` | concaténation + normalisation |
| `Résumé` | 330 | `$a` | texte intégral |
| `Table des matières` | 327 | `$a` | texte intégral |
| `Vedette matière - Nom commun` | 606 | `$a $x $y $z` | `$a $x $y $z rameau`, multiples avec `; ` |
| `Vedette matière - Nom géographique` | 607 | `$a $x` | `$a $x rameau` |
| `Vedette matière - Forme, genre` | 608 | `$a` | `$a rameau` |
| `Vedette matière - Nom de personne` | 600 | `$a $b $f` | |
| `Vedette matière - Nom de collectivité` | 601 | `$a $b` | |
| `Prix` | 010 | `$d` | texte libre (ex. `22 EUR`) |
| `Notes` | 300-305 | `$a` | concaténation avec ` ; ` |

### Écriture des corrections dans le texte UNIMARC

`SYRACUSE_TO_UNIMARC` (`server/syracuse.ts`) donne la cible **unique** (une zone,
une sous-zone) où réinjecter chaque valeur corrigée :

| Champ Syracuse | Tag | Sous-zone |
| --- | --- | --- |
| `Titre` | 200 | `$a` |
| `ISBN` | 010 | `$a` |
| `EAN` | 073 | `$a` |
| `Editeur` | 214 | `$c` |
| `Publié le` | 214 | `$d` |
| `Description matérielle` | 215 | `$a` |
| `Collection` | 225 | `$a` |
| `Résumé` | 330 | `$a` |
| `Table des matières` | 327 | `$a` |
| `Auteur principal - Personne physique` | 700 | `$a` |
| `Vedette matière - Nom commun` | 606 | `$a` |
| `Vedette matière - Nom géographique` | 607 | `$a` |
| `Vedette matière - Forme, genre` | 608 | `$a` |
| `Vedette matière - Nom de personne` | 600 | `$a` |
| `Vedette matière - Nom de collectivité` | 601 | `$a` |
| `Notes` | 300 | `$a` |
| `Prix` | 010 | `$d` |

Si la zone/sous-zone n'existe pas dans le XML d'origine (ajout d'une vedette
suggérée par le LLM, par exemple), une nouvelle ligne UNIMARC est ajoutée en fin
de notice.

### Structure du XML retourné par le Sudoc

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
</record>
```

Le parseur itère sur les `<datafield>` filtrés par `tag`, extrait les
`<subfield>` par `code`, et gère les zones répétables (plusieurs `<datafield>`
de même tag).

---

## 7. Export UNIMARC textuel pour WINIBW

Produit à partir du XML UNIMARC brut du Sudoc (`unimarcXmlToText`,
`server/marc.ts`).

### Format d'une ligne

```
<TAG><ESPACE><INDICATEURS>$<CODE><VALEUR>$<CODE><VALEUR>…
```

- `<TAG>` : 3 chiffres (`010`, `200`, `214`, `606`, `700`…)
- `<INDICATEURS>` : 2 caractères, chiffre ou `#` pour un espace
- Sous-zones `$<code><valeur>` collées, sans espace entre elles

Controlfields : `TAG VALEUR` (sans `$`).

Les indicateurs sont **toujours** rendus sur deux caractères. Attention : le
parseur XML supprime les espaces des attributs, donc `ind1=" "` arrive sous la
forme d'une chaîne vide — c'est pourquoi la conversion en `#` teste la chaîne
vide et pas seulement l'espace. Sans ça, les lignes sortaient en `010 $a…` au
lieu de `010 ##$a…`, illisibles pour WINIBW.

### Conversion de la zone 100 (UNIMARC standard → format Sudoc)

Le web service `https://www.sudoc.fr/{PPN}.xml` expose la zone 100 au format
**UNIMARC standard** : une seule sous-zone `$a` de 36 caractères à positions
fixes. WINIBW attend le **format Sudoc**, où l'information est éclatée en
sous-zones. Il faut donc détecter une zone 100 à `$a` longue et la reconvertir.

- Positions 0-7 : date d'entrée dans le Sudoc → **ignorer**
- Position 8 : code de type de date (lettre)
- Positions 9-12 : 1ʳᵉ date (4 chiffres ou `X`)
- Positions 13-16 : 2ᵈᵉ date

| Pos. 8 | Type | 1er indicateur | 1ʳᵉ date | 2ᵈᵉ date |
| --- | --- | --- | --- | --- |
| `a` | ressource continue | `1` | `$a` | `$b` |
| `b` | ressource à date ouverte | `1` | `$a` | `$d` (avec `-...`) |
| `d` | monographie, 1 volume | `0` | `$a` | — |
| `e` | reproduction | `0` | `$a` | — |
| `f` | date incertaine | `1` | `$a` | `$c` |
| `g` | monographie multivolumes | `0` | `$a` | `$b` |
| `h` | livre ancien (2 dates) | `0` | `$a` (publication) | `$f` (copyright) |
| `j` | enregistrement sonore | `0` | `$a` | — |
| autre | inconnu | `#` | `$a` | — |

Exemple : `100 ##$a20230214h20222022k  y0frey50      ba` → `100 0#$a2022$f2022`

Documentation de référence : <https://documentation.abes.fr/sudoc/formats/unmb/zones/100.htm>

Les autres zones (104, 105, 106, 181-183, 200, 210, 214, 215, 225, 606, 700…)
sont déjà exposées au format Sudoc : **aucune conversion**.

### Zones filtrées à l'export

Deux listes, dans `server/marc.ts` :

- `HOLDINGS_TAGS` = `915, 917, 930, 940, 941, 991, 999` — localisation des
  exemplaires dans d'autres bibliothèques, sans objet pour WINIBW.
- `EXCLUDED_TAGS` = `000, 004, 005, 006, 007, 008, 020, 579, 676, 680, 686, 801,
  931, 990, 992` — zones techniques ou de gestion.

**Décision : le leader (000) et la zone 008 ne sont pas exportés.** Le fichier
sert à corriger dans WINIBW une notice Sudoc **qui existe déjà** — elle en vient —
et ces deux zones y sont donc déjà présentes. Les recopier n'ajouterait que du
bruit à coller. Le code des deux mises en forme correspondantes (`000 $0…`,
`008 $a…`) a été supprimé plutôt que laissé mort. Si le besoin de **créer** des
notices apparaît, retirer `000` et `008` d'`EXCLUDED_TAGS` et rétablir ces deux
mises en forme.

### Séparateurs

- Un seul `\n` entre deux zones d'une notice.
- Entre deux notices : `\n\n----------------------------------------\n\n`

---

## 8. Cas particuliers

| Cas | Traitement |
| --- | --- |
| **PPN fusionné** | HTTP 404 → `services/merged/{PPN}` → nouveau PPN → nouvelle tentative |
| **Notice absente du Sudoc** | `NON_TROUVE` (catégorie A) ou `ABSENT_SUDOC` (catégorie B) ; notice conservée telle quelle |
| **PPN tronqué** | padding d'un `0` initial pour revenir à 9 caractères, partout |
| **Encodage** | tout en UTF-8 ; normaliser guillemets `«»`, tirets `–—`, espaces insécables, apostrophes ; préserver l'encodage à l'export (CSV en UTF-8 avec BOM pour Excel) |

---

## 9. Références externes

- Format UNIMARC/B du Sudoc — <https://documentation.abes.fr/sudoc/formats/unmb/zones/>
- Zone 100 (dates) — <https://documentation.abes.fr/sudoc/formats/unmb/zones/100.htm>
- Zone 214 (publication) — <https://documentation.abes.fr/sudoc/formats/unmb/zones/214.htm>
- Web service UNIMARC — `https://www.sudoc.fr/{PPN}.xml`
- Service SRU — `https://www.sudoc.abes.fr/cbs/sru/`
- LLM du SSP Cloud — `https://llm.lab.sspcloud.fr/api/chat/completions`
- Documentation SSP Cloud — <https://docs.sspcloud.fr/>
