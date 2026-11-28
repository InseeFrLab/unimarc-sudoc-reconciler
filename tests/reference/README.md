# Sorties de référence (refonte Python)

Ces fichiers sont produits par le **code TypeScript actuel** (`server/`), via
`scripts/generer_reference.ts`. Le TypeScript fait foi : les tests Python rejouent les
mêmes entrées et comparent leurs résultats à ces fichiers. Ne pas les éditer à la main.
Spécification : [docs/refonte-python.md](../../docs/refonte-python.md), section 10.2.

## Contenu

| Fichier | Contenu |
| --- | --- |
| `similarite.json` | paires de chaînes et score de `string-similarity` |
| `compare_fields.json` | triplets (champ, Syracuse, Sudoc) → statut ; `attendu_agent` = ce que l'on attendait, `statut` = ce que fait le TypeScript |
| `syracuse.json`, `syracuse_cas_limites.json` | `parseSyracuseNotices` (format neutre, sans préfixe `@_`) |
| `sudoc.json`, `sudoc_cas_limites.json` | `parseSudocXml` (l'ordre des clés compte) |
| `ecarts.json`, `ecarts_cas_limites.json` | `compareNoticeWithSudoc` |
| `unimarc.txt`, `unimarc_cas_limites.txt` | `unimarcXmlToText` |
| `export_decisions.json` | jeu de décisions appliqué avant les exports |
| `export.xml`, `export.csv`, `export.txt` | exports de la session construite, à comparer à l'octet près |

Les fixtures sont dans `tests/fixtures/`. Elles sont **synthétiques** : aucune donnée réelle.

## Régénérer

```bash
export PATH="$HOME/.local/node-v22.11.0-linux-x64/bin:$PATH"   # Node 22
npx tsx scripts/generer_reference.ts
git diff --exit-code tests/reference    # doit rester vide si rien n'a changé
```

Le script n'accède jamais au réseau et ne produit rien d'aléatoire : deux exécutions
donnent des fichiers identiques. Il affiche les écarts entre le statut attendu et celui du
TypeScript ; il ne les corrige pas.

## Installer Node sans droits administrateur

Node 20 ou plus est nécessaire uniquement pour régénérer ces fichiers. Sur un service du
SSP Cloud, sans `sudo` :

```bash
cd ~/.local
curl -fsSLO https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/v22.11.0/SHASUMS256.txt | grep linux-x64.tar.xz | sha256sum -c -
tar -xJf node-v22.11.0-linux-x64.tar.xz
export PATH="$HOME/.local/node-v22.11.0-linux-x64/bin:$PATH"
node --version
```
