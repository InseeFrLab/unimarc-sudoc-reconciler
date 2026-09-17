# Comprendre le déploiement, pas à pas

Ce document explique le vocabulaire et les mécanismes derrière
[`scripts/verifier-deploiement.sh`](scripts/verifier-deploiement.sh). Il part de
zéro : aucune connaissance de Docker, de Kubernetes ou d'ArgoCD n'est supposée.

Il répond à une question d'apparence anodine, mais dont la réponse traverse cinq
systèmes différents : **le site que je vois dans mon navigateur exécute-t-il bien
le dernier code que j'ai écrit ?**

---

## 1. Pourquoi cette question est difficile

Quand on modifie un fichier sur son ordinateur et qu'on l'enregistre, le résultat
est immédiat. Un site déployé, non : entre votre code et la page web, il y a une
chaîne de cinq maillons, chacun avec sa propre copie des choses.

```
   votre code            GitHub Actions          le registre
   ┌─────────┐   push    ┌─────────┐  construit  ┌─────────┐
   │  dépôt  │ ────────► │   CI    │ ──────────► │  GHCR   │
   │   Git   │           │         │             │ (images)│
   └─────────┘           └─────────┘             └────┬────┘
        │                                             │
        │ ArgoCD surveille                            │ Kubernetes
        │ les manifestes                              │ télécharge
        ▼                                             ▼
   ┌──────────────────────────────────────────────────────┐
   │              le cluster Kubernetes                    │
   │   manifeste  ──►  Deployment  ──►  Pod (conteneur)    │
   └──────────────────────────────────────────────────────┘
                                │
                                ▼
                      le site dans le navigateur
```

Chaque maillon peut être à jour alors que le suivant ne l'est pas. Dire « c'est
déployé » sans préciser **quel maillon** on a vérifié ne veut rien dire. C'est
exactement le piège dans lequel ce projet est tombé : ArgoCD affichait
sagement *Synced*, et pourtant le site montrait du code vieux de trois semaines.

---

## 2. Le piège central : deux « SHA » qui n'ont rien à voir

Avant tout le reste, il faut lever une ambiguïté qui fait trébucher tout le monde.
Le mot « SHA » désigne ici **deux choses différentes**, et le script affiche les
deux côte à côte.

| | SHA de commit Git | Empreinte d'image (*digest*) |
| --- | --- | --- |
| À quoi ça ressemble | `e48dca6cfb0752a71c…` | `sha256:7a33e9fbc2344bcb…` |
| Ça identifie | un état du **code source** | un état d'une **image** construite |
| Qui le fabrique | Git, à chaque commit | le registre, au dépôt de l'image |
| Où on le voit | `git log`, GitHub | `kubectl get pod`, GHCR |

Ils sont tous deux calculés par une fonction de hachage (SHA-256), d'où le nom
commun, mais ils portent sur des objets différents. Un commit Git a un SHA ;
l'image construite *à partir de* ce commit a un autre SHA, sans rapport
arithmétique avec le premier.

Retenez : **le SHA de commit répond « quel code ? », l'empreinte d'image répond
« quel paquet exécutable ? »**.

---

## 3. Le vocabulaire, maillon par maillon

### 3.1 Le dépôt Git, le commit, `main`

Un **dépôt** (*repository*) est l'historique complet du projet. Un **commit** est
une photographie de tous les fichiers à un instant donné, accompagnée d'un
message. Chaque commit reçoit un identifiant unique de 40 caractères, son **SHA**,
que l'on abrège en général aux 7 ou 12 premiers (`e48dca6`).

Une **branche** est simplement un nom qui pointe sur un commit, et qui avance
quand on en ajoute. `main` est la branche de référence : par convention dans ce
projet, **ce qui est sur `main` est ce qui doit tourner en production**.

`HEAD` désigne le commit le plus récent d'une branche. `origin` désigne la copie
du dépôt hébergée sur GitHub — par opposition à votre copie locale. D'où
`origin/main` : le dernier commit de `main` tel que GitHub le connaît.

> **À savoir** : votre copie locale ne se met pas à jour toute seule.
> `git fetch origin` va redemander à GitHub où en sont les branches. Le script le
> fait en première ligne, sinon il comparerait le cluster à une vision périmée du
> dépôt.

### 3.2 « L'applicatif », par opposition au reste

Tous les fichiers d'un dépôt ne se valent pas. Dans ce projet :

- `src/` (le front React) et `server/` (l'API Express) forment **l'applicatif** :
  le code réellement exécuté. Le modifier change le comportement du site.
- `package.json`, `package-lock.json`, `Dockerfile` en font partie aussi :
  ils déterminent ce qui entre dans l'image.
- `README.md`, `apprendre.md`, `CLAUDE.md`, `docs/` sont de la **documentation**.
  Les modifier ne change rien au site.
- `deploy/` contient les **manifestes** (voir § 3.5). Les modifier change le
  déploiement, mais pas le contenu de l'image.

Cette distinction a une conséquence pratique : un commit qui ne touche que la
documentation produit une image *identique en comportement* à la précédente. Le
script en tient compte — il compare l'image déployée au **dernier commit
applicatif**, pas au dernier commit tout court. Sinon il crierait à l'écart à
chaque correction de faute de frappe dans le README.

### 3.3 L'image et le conteneur

Une **image** est un paquet figé, en lecture seule, contenant tout le nécessaire à
l'exécution : le système de fichiers minimal, Node.js, les dépendances `npm`, et
votre code. C'est une recette cuite, pas une recette écrite.

La recette écrite, c'est le [`Dockerfile`](Dockerfile) : une suite d'instructions
(« pars de Node 22 », « copie le code », « lance `npm ci` », « compile le front »).
Le **build** exécute ces instructions et produit l'image.

Un **conteneur** est une image en train de tourner. Analogie : l'image est au
conteneur ce qu'un fichier `.exe` est à un programme ouvert. Une même image peut
donner naissance à dix conteneurs identiques.

Point capital pour la suite : **une image est immuable**. On ne met pas une image
à jour ; on en construit une nouvelle, différente, avec une nouvelle empreinte.

### 3.4 Le registre, les tags, et pourquoi un tag ment

Un **registre** est un entrepôt d'images, accessible par le réseau. Ici c'est
**GHCR** (*GitHub Container Registry*), à l'adresse `ghcr.io`.

Dans le registre, chaque image est rangée sous son **empreinte** (`sha256:7a33…`),
calculée sur son contenu. Deux images au contenu identique ont la même empreinte ;
deux images qui diffèrent ne serait-ce que d'un octet en ont deux différentes.
C'est un identifiant fiable et définitif.

Mais `sha256:7a33e9fbc2344bcb1448ee28…` est illisible. On colle donc par-dessus
des **tags** : des étiquettes lisibles. Le workflow de ce projet en pose deux sur
chaque image construite :

```yaml
tags: |
  ghcr.io/…/unimarc-sudoc-reconciler:latest
  ghcr.io/…/unimarc-sudoc-reconciler:${{ github.sha }}
```

Et voici le nœud de toute cette affaire :

> **Un tag est une étiquette déplaçable, pas un numéro de version.**

- `:latest` est **décollé et recollé** sur l'image la plus récente à chaque push
  sur `main`. Il ne désigne pas la même image d'un jour à l'autre.
- `:e48dca6cfb…`, le tag portant le SHA du commit, est posé une fois et n'est
  jamais redéplacé, puisque ce commit ne sera plus jamais reconstruit. Il désigne
  **une image précise, définitivement**.

L'image du quai de gare : « le prochain train » change tout seul au fil de la
journée ; « le TGV 8412 du 15 septembre » désigne un train et un seul. `:latest`
est le premier, le tag de commit est le second.

C'est pourquoi le script, lorsqu'il veut savoir ce qui tourne vraiment, ne
compare jamais des tags à des tags : il redemande au registre **quelle empreinte
ce tag désigne en ce moment**, puis compare des empreintes.

### 3.5 Kubernetes : cluster, manifestes, Deployment, Pod

Le **cluster** est l'ensemble des machines qui exécutent les conteneurs, piloté
par Kubernetes. Le SSP Cloud en met un à disposition. Il est découpé en
**namespaces**, des espaces de travail cloisonnés : le vôtre est `user-mhillion`.

On ne parle pas à Kubernetes en lui donnant des ordres, mais en lui **décrivant
l'état souhaité**, dans des fichiers YAML appelés **manifestes**. Kubernetes se
charge ensuite de faire coïncider la réalité avec cette description, et de l'y
ramener si elle s'en écarte. Ce projet en compte trois, dans `deploy/` :

| Manifeste | Type | Rôle |
| --- | --- | --- |
| [`deployment.yaml`](deploy/deployment.yaml) | `Deployment` | quelle image exécuter, en combien d'exemplaires, avec quelles ressources |
| [`service.yaml`](deploy/service.yaml) | `Service` | une adresse interne stable pour joindre l'application |
| [`ingress.yaml`](deploy/ingress.yaml) | `Ingress` | l'URL publique en HTTPS et son routage |

Un **Pod** est l'unité d'exécution : un ou plusieurs conteneurs lancés ensemble.
Vous ne créez jamais de Pod à la main ; le `Deployment` s'en charge et veille à ce
qu'il y en ait toujours le nombre demandé (ici, `replicas: 1`). Si un Pod meurt,
le `Deployment` en recrée un.

Et voici le second mécanisme à retenir :

> **Un Pod télécharge son image au démarrage, et une seule fois.**

Il ne surveille pas le registre. Un Pod lancé il y a trois semaines à partir de
`:latest` exécute l'image que `:latest` désignait il y a trois semaines — pour
toujours, jusqu'à ce qu'on le recrée. `imagePullPolicy: Always`, présent dans le
manifeste, ne change rien à cela : il signifie « retélécharge à chaque
**démarrage** », pas « surveille en continu ».

D'où la commande `kubectl rollout restart deployment/…`, qui force la destruction
du Pod et sa recréation — et donc un nouveau téléchargement.

### 3.6 ArgoCD et le GitOps

**GitOps** est un principe : *l'état souhaité du système est décrit dans Git, et
un automate se charge d'y conformer le cluster.* On ne déploie plus en tapant des
commandes, on déploie en poussant un commit. Avantages : l'historique du dépôt est
l'historique des déploiements, et revenir en arrière est un simple `git revert`.

**ArgoCD** est cet automate. Le fichier [`application.yaml`](application.yaml),
appliqué une seule fois à l'installation, lui dit quoi surveiller : ce dépôt,
dossier `deploy/`. Ensuite, en boucle, ArgoCD :

1. lit les manifestes dans `deploy/` sur `main` — l'**état souhaité** ;
2. lit l'état réel du cluster ;
3. si les deux diffèrent, applique les manifestes pour les réaccorder.

Il affiche alors **Synced** (les deux coïncident) ou **OutOfSync**. Les options
`prune` et `selfHeal` activées dans `application.yaml` signifient qu'il supprime
ce qui a disparu de Git et annule les modifications faites à la main dans le
cluster.

Un point de vocabulaire qui a son importance pratique : c'est ArgoCD qui écrit
dans le cluster, avec **ses** permissions, pas les vôtres. C'est pourquoi on peut
déployer sans aucun droit d'écriture Kubernetes — un `git push` suffit. Les
services VSCode du SSP Cloud sont d'ailleurs lancés par défaut avec un rôle en
lecture seule, et `kubectl rollout restart` y échoue avec un message
`... is forbidden: User "system:serviceaccount:..." cannot patch resource`.

---

## 4. Le bug qui a motivé tout ceci

Rassemblons. Pendant des semaines, ce projet a connu la situation suivante :

1. Une PR corrigeant un vrai bug est fusionnée sur `main`. ✓
2. GitHub Actions construit l'image et déplace `:latest` dessus. ✓
3. ArgoCD compare `deploy/` à l'état du cluster. Le manifeste dit
   `image: …:latest`. Il disait déjà `image: …:latest` la veille. **Le texte n'a
   pas changé d'un caractère.** ArgoCD conclut : *Synced*, rien à faire. ✓
4. Aucun Pod n'est donc recréé. Celui qui tourne depuis 23 jours continue
   d'exécuter l'image téléchargée à son démarrage. ✗
5. Le site montre l'ancien code.

Le point douloureux est l'étape 3 : **ArgoCD affiche fièrement *Synced*, et il a
raison.** Sa mission est de faire coïncider le cluster avec les manifestes, et
c'est le cas. Sa mission n'est pas de surveiller le registre d'images. Le défaut
n'est ni dans ArgoCD ni dans Kubernetes : il est dans le fait d'avoir exprimé
l'état souhaité avec une étiquette mouvante. Dire « je veux la dernière image »
n'est pas un état, c'est une promesse creuse.

**Ce qui manquait**, c'est simplement de recréer le pod. Détruit, il est aussitôt
remplacé par le `Deployment`, et le nouveau retélécharge l'image que `:latest`
désigne à cet instant. En temps normal on écrirait :

```bash
kubectl rollout restart deployment/unimarc-sudoc-reconciler
```

Mais un service VSCode du SSP Cloud est lancé avec un rôle en **lecture seule**,
et la commande échoue :

```
error: failed to patch: deployments.apps "…" is forbidden: User
"system:serviceaccount:user-mhillion:vscode-python-…" cannot patch resource
"deployments" in API group "apps" in the namespace "user-mhillion"
```

D'où le geste retenu pour ce projet : **le bouton *Restart*** sur la ressource
`Deployment`, dans l'interface ArgoCD. Même effet, mais c'est ArgoCD qui agit,
avec ses propres permissions — vos droits de lecture suffisent.

Il ne se trouve pas dans une barre d'outils : il faut survoler la boîte
`Deployment` du graphe des ressources, cliquer sur le menu `⋮` qui apparaît, puis
sur `Restart`. Le chemin détaillé, et le repli si l'action n'est pas proposée,
sont dans le [README](README.md#mettre-en-production-une-nouvelle-version).

Notez au passage le rôle d'`imagePullPolicy: Always` dans le manifeste. Il
signifie « retélécharge l'image à chaque **démarrage** de conteneur » — et non
« surveille le registre en continu », ce qui n'existe pas. Avec une étiquette
mouvante il est indispensable : sans lui, un pod recréé pourrait réutiliser
l'image déjà en cache sur la machine, et le redémarrage ne servirait à rien.

### Le choix fait ici, et ce qu'il coûte

Il existe une autre façon de procéder : **épingler dans le manifeste le tag
portant le SHA du commit**, que le workflow publie déjà à côté de `:latest`.

```yaml
image: ghcr.io/inseefrlab/unimarc-sudoc-reconciler:e48dca6cfb0752a71c…
```

Chaque mise en production modifierait alors le *fichier*. ArgoCD verrait la
différence, appliquerait le manifeste, et Kubernetes recréerait le pod de
lui-même : plus de geste manuel, et le retour arrière se réduirait à remettre le
SHA précédent. C'est ce que recommande en général la pratique GitOps.

Ce projet a délibérément gardé `:latest` et le redémarrage manuel, pour deux
raisons :

1. **Simplicité.** Épingler impose de reporter un SHA à chaque mise en
   production, ou d'écrire un automate qui le fait. Pour un outil interne déployé
   quelques fois par an, c'est de la machinerie mal amortie.
2. **Maîtrise du moment.** Un déploiement recrée le conteneur, et l'application
   n'a **aucune persistance** : les sessions de vérification en cours sont
   perdues. Un déploiement automatique pourrait interrompre une documentaliste au
   milieu de 800 notices. Le bouton laisse choisir l'instant.

Les deux contreparties, à connaître :

- **Aucun retour arrière.** `:latest` ne désigne que l'image la plus récente ; on
  ne peut pas lui demander la précédente. Réparer une régression suppose de
  corriger le code, d'attendre la reconstruction, puis de redémarrer.
- **Rien ne signale qu'un redémarrage est dû.** C'est la faiblesse qui a produit
  les trois semaines de site périmé. Le seul garde-fou est de vérifier — d'où le
  script de la section suivante, à lancer après chaque mise en production.

## 5. Ce que vérifie le script, ligne par ligne

Le script pose quatre questions indépendantes. Aucune ne suffit seule ; leur
recoupement, si.

### Question 1 — Que demande Git ?

```bash
git show origin/main:deploy/deployment.yaml | sed -n 's|.*image: ghcr.io/[^:]*:\(.*\)|\1|p'
```

`git show origin/main:chemin` lit un fichier **tel qu'il est sur `main`**, sans
toucher à votre copie de travail : on interroge la référence, pas son brouillon
local. Le `sed` en extrait le tag. C'est l'**état souhaité**.

En parallèle, le script relève `HEAD` de `main` et le dernier commit ayant touché
l'applicatif (§ 3.2) :

```bash
git log -1 --format=%H origin/main -- src server package.json Dockerfile …
```

### Question 2 — ArgoCD a-t-il appliqué ce manifeste ?

```bash
kubectl get deployment unimarc-sudoc-reconciler \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

`kubectl` est le client en ligne de commande de Kubernetes. `-o jsonpath=…`
extrait un champ précis de la réponse plutôt que de tout afficher — ici l'image du
premier conteneur du modèle de Pod.

Si ce tag diffère de celui de la question 1, ArgoCD n'a pas encore synchronisé :
soit il n'a pas fini son cycle (il vérifie toutes les trois minutes environ), soit
la synchronisation a échoué.

### Question 3 — Le Pod exécute-t-il vraiment cette image ?

**La question que tout le monde oublie**, et celle qui a révélé le bug. On
compare des empreintes, jamais des tags.

Ce que le conteneur exécute réellement :

```bash
kubectl get pod -l app=unimarc-sudoc-reconciler \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'
```

Notez `status` et non `spec` : `spec` est ce qu'on a demandé, `status` est ce qui
est. L'`imageID` contient l'empreinte de l'image effectivement chargée.

Puis ce que le tag désigne **maintenant** dans le registre. GHCR exige un jeton,
même pour un paquet public :

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:…:pull&service=ghcr.io" | …)
curl -sI -H "Authorization: Bearer $TOKEN" -H "Accept: …" \
  "https://ghcr.io/v2/…/manifests/$TAG"
```

`-I` ne demande que les en-têtes : l'empreinte arrive dans
`Docker-Content-Digest`, inutile de télécharger l'image. L'en-tête `Accept`
énumère les formats de manifeste acceptés ; sans lui, le registre peut répondre
dans un format ancien et donner une autre empreinte.

Si les deux empreintes diffèrent : le tag a bougé depuis que le Pod a démarré.

### Question 4 — Que déclare l'application elle-même ?

Les trois premières questions raisonnent sur des étiquettes et des métadonnées.
Elles établissent qu'un certain paquet tourne, pas que ce paquet contient le code
attendu. La preuve directe vient de l'application :

```bash
curl -s https://unimarc-sudoc-reconciler.lab.sspcloud.fr/api/version
```

```json
{ "version": "1.4.0", "commit": "e48dca6cfb…", "source": "image", "demarrage": "…" }
```

Le mécanisme, qui vaut d'être compris car il est réutilisable partout :

1. Le workflow passe le SHA du commit au build :
   `build-args: GIT_SHA=${{ github.sha }}`.
2. Le `Dockerfile` le reçoit (`ARG GIT_SHA`) et le fige dans l'image
   (`ENV GIT_SHA=$GIT_SHA`).
3. [`server/version.ts`](server/version.ts) lit cette variable et la renvoie sur
   `GET /api/version`.

Le SHA est ainsi **gravé dans l'image au moment de sa construction**. La réponse
ne peut pas mentir : elle vient du code en train de s'exécuter. Il suffit de la
comparer au dernier commit applicatif de `main`.

> En développement, hors conteneur, `GIT_SHA` est absent : le module retombe sur
> `git rev-parse HEAD` et signale `"source": "dépôt local"`.

---

## 6. Lire la sortie du script

```
  origin/main (HEAD)                b07217a3a967     ← dernier commit de main
  dernier commit applicatif         a9d5687f5a72     ← dernier commit qui change le site
  tag demandé par le manifeste      latest           ← état souhaité (Git)
  tag appliqué dans le cluster      latest           ← ce qu'ArgoCD a posé
  image attendue (registre)         sha256:7a33e9fb  ← ce que « latest » désigne
  image réellement exécutée         sha256:7a33e9fb  ← ce que le conteneur a chargé
  commit déclaré par le site        a9d5687f5a72     ← ce que l'appli avoue
  âge du pod                        2m
```

Avec une étiquette mouvante, les deux premières lignes de tags sont **toujours**
identiques : elles ne prouvent rien. Ce sont les lignes 5 et 6, les empreintes,
puis la ligne 7, qui tranchent.

| Symptôme | Interprétation |
| --- | --- |
| Tous les verdicts ✓ | Le site est à jour. |
| Tags identiques, empreintes différentes | `latest` a bougé sans que le pod redémarre : cliquer sur *Restart* dans ArgoCD. |
| Le site déclare un commit plus ancien que le dernier commit applicatif | Même chose, constaté depuis l'application elle-même. |
| Tag du manifeste ≠ tag du cluster, pod récent | ArgoCD n'a pas fini son cycle. Attendre deux ou trois minutes. |
| Tag du manifeste ≠ tag du cluster, pod ancien | La synchronisation échoue. Regarder l'interface ArgoCD. |
| `/api/version` indisponible | Le site tourne sur une version antérieure à cette route, ou est injoignable. |

## 7. Mémo des commandes

Toutes fonctionnent avec les droits en **lecture seule** d'un service VSCode
standard du SSP Cloud.

```bash
# Le diagnostic complet
./scripts/verifier-deploiement.sh

# Ce que le site déclare
curl -s https://unimarc-sudoc-reconciler.lab.sspcloud.fr/api/version

# Le pod : existe-t-il, depuis quand, avec quelle image ?
kubectl get pods -l app=unimarc-sudoc-reconciler
kubectl describe pod -l app=unimarc-sudoc-reconciler

# Les journaux de l'application
kubectl logs -l app=unimarc-sudoc-reconciler --tail=50
kubectl logs -l app=unimarc-sudoc-reconciler -f     # en continu

# Ce que le manifeste de main demande
git fetch -q origin && git show origin/main:deploy/deployment.yaml | grep image:

# Quels droits ai-je sur ce cluster ?
kubectl auth can-i --list
kubectl auth can-i patch deployments
```

Pour **mettre en production** : fusionner la PR, attendre que le workflow ait
publié l'image, puis cliquer sur *Restart* sur le `Deployment` dans l'interface
ArgoCD — et vérifier avec le script. Procédure détaillée dans le
[README](README.md#mettre-en-production-une-nouvelle-version).
