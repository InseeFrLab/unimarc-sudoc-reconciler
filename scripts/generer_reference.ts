/**
 * generer_reference.ts — Génère tests/reference/ à partir du code TypeScript actuel.
 *
 * Refonte Python, phase 0 (docs/refonte-python.md, section 10.2). Le TypeScript FAIT FOI :
 * ce script exécute les fonctions existantes sur des entrées fixes et écrit leurs résultats.
 * Les tests Python rejoueront ces entrées et compareront leurs sorties à ces fichiers.
 *
 * Lancement : npx tsx scripts/generer_reference.ts
 *
 * Garanties :
 *  - aucun accès réseau (axios est neutralisé) ;
 *  - aucune date, aucun aléatoire : deux exécutions écrivent des fichiers identiques ;
 *  - pour les triplets de compare_fields.json, le statut attendu par l'agent est consigné à
 *    côté du statut réel ; un écart est signalé, JAMAIS corrigé.
 *
 * Script temporaire : supprimé en phase 6, les fichiers de référence restent.
 */
import axios from 'axios';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stringSimilarity from 'string-similarity';

import { parseSyracuseNotices, UNMODIFIABLE_FIELDS, SYRACUSE_MAPPING } from '../server/syracuse.ts';
import { padPpn, parseSudocXml, unimarcXmlToText } from '../server/marc.ts';
import { compareFields, compareNoticeWithSudoc } from '../server/compare.ts';
import { buildCsvExport, buildTxtExport, buildXmlExport } from '../server/exports.ts';
import { PSEUDO_UNIMARC_FIELDS } from '../server/syracuse.ts';

// ─── Garde-fou : aucun accès réseau ──────────────────────────────────────────
// Sans lui, buildTxtExport appellerait sudoc.fr pour toute notice qui a un PPN mais pas de
// sudocXml. Avec lui, fetchSudocRecord attrape l'erreur et renvoie null, comme un 404.
const reseauInterdit = async () => { throw new Error('Réseau interdit pendant la génération des références'); };
(axios as any).get = reseauInterdit;
(axios as any).post = reseauInterdit;

// ─── Chemins et écriture ─────────────────────────────────────────────────────
const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dossierFixtures = path.join(racine, 'tests', 'fixtures');
const dossierRef = path.join(racine, 'tests', 'reference');
mkdirSync(dossierRef, { recursive: true });

const lire = (nom: string) => readFileSync(path.join(dossierFixtures, nom), 'utf8');
const ecrireJson = (nom: string, data: unknown) =>
  writeFileSync(path.join(dossierRef, nom), JSON.stringify(data, null, 2) + '\n', 'utf8');
const ecrireTexte = (nom: string, texte: string) => writeFileSync(path.join(dossierRef, nom), texte, 'utf8');

const SYRACUSE = lire('syracuse-echantillon.xml');
const SUDOC = lire('sudoc-267670346.xml');
const SYRACUSE_LIM = lire('syracuse-cas-limites.xml');
const SUDOC_LIM = lire('sudoc-cas-limites.xml');

// ─── 1. similarite.json ──────────────────────────────────────────────────────
// Chaînes à bigrammes tous distincts, pour construire des scores EXACTEMENT sur les seuils
// (Dice = 2·i / (la + lb − 2)).
const a10 = 'abcdefghij';
const a11 = 'abcdefghijk';
const a20 = 'abcdefghijklmnopqrst';

const paires: Array<[string, string]> = [
  // identiques, vides, très courtes
  ['', ''], ['a', 'a'], ['a', 'b'], ['', 'abc'], ['abc', ''], ['ab', 'ab'], ['ab', 'ba'], ['ab', 'abc'],
  [' ', ''], ['  ', '   '], ['a b', 'ab'],
  // blancs : espaces multiples, tabulation, retour à la ligne, insécable, BOM
  ['les comptes', 'lescomptes'], ['les   comptes', 'les comptes'], ['les\tcomptes', 'les comptes'],
  ['les\ncomptes', 'les comptes'], ['les comptes', 'les comptes'], ['les﻿comptes', 'lescomptes'],
  ['les\u001Fcomptes', 'lescomptes'],
  // répétitions et bigrammes en double
  ['aaaa', 'aa'], ['aaaa', 'aaaa'], ['aaaa', 'aaa'], ['abab', 'ab'], ['abababab', 'baba'], ['night', 'nacht'],
  // casse, accents, ponctuation
  ['Insee', 'insee'], ['économie', 'economie'], ['économie', 'économie'], ['l’économie', "l'économie"],
  ['a;b', 'a:b'], ['hello, world!', 'hello world'],
  // référence classique de la bibliothèque
  ['france', 'french'], ['healed', 'sealed'], ['edward', 'edwards'], ['Olive-green table for sale in extremely good condition.', 'For sale: table in very good  condition, olive green in colour.'],
  // titres réalistes
  ['Les comptes de la nation', 'Les comptes de la nation 2022'],
  ['Le recensement de la population de 1954', 'Le recensement de la population de 1955'],
  ['Statistiques agricoles', 'Comptes nationaux'],
  ['Gallimard', 'Gallimard Jeunesse'],
  ['Dunod', 'Hachette'],
  // hors BMP : la mesure JavaScript compte des unités UTF-16 (😀 = 2 unités)
  ['😀😀', '😀😁'], ['😀', '😀'], ['😀', '😁'], ['a😀b', 'a😁b'], ['日本語の本', '日本語の書'],
  // seuils exacts
  [a10, a10 + 'kl'],                                  // 0,9
  [a10, a11],                                         // 18/19
  [a20, a20.slice(0, 18) + 'uvwx'],                   // 0,85
  [a20, a20.slice(0, 18) + 'uvw'],                    // juste au-dessus de 0,85 ?
  [a11, a11.slice(0, 6) + 'lmnop'],                   // 0,5
  [a11, a11.slice(0, 7) + 'lmnop'],                   // juste au-dessus de 0,5
];
const similarite = paires.map(([a, b]) => ({ a, b, score: stringSimilarity.compareTwoStrings(a, b) }));
ecrireJson('similarite.json', similarite);

// ─── 2. compare_fields.json ──────────────────────────────────────────────────
// Chaque triplet porte : une étiquette de branche, ce que l'AGENT attendait d'après sa lecture
// du code (attendu_agent), et le résultat RÉEL du TypeScript. En cas d'écart, le TypeScript fait foi.
type Triplet = { branche: string; champ: string; syracuse: string; sudoc: string; attendu_agent: string };
const t = (branche: string, champ: string, syracuse: string, sudoc: string, attendu_agent: string): Triplet =>
  ({ branche, champ, syracuse, sudoc, attendu_agent });

const AUTEUR = 'Auteur principal - Personne physique';
const triplets: Triplet[] = [
  // — vides (avant toute règle)
  t('vide-vide', 'Titre', '', '', 'IDENTIQUE'),
  t('vide-syracuse', 'Titre', '', 'x', 'MANQUANT_SYRACUSE'),
  t('vide-sudoc', 'Titre', 'x', '', 'ABSENT_SUDOC'),
  t('vide-vide', 'ISBN', '', '', 'IDENTIQUE'),
  t('vide-syracuse', 'ISBN', '', '9782111380808', 'MANQUANT_SYRACUSE'),
  t('vide-sudoc', 'ISBN', '9782111380808', '', 'ABSENT_SUDOC'),
  t('vide-syracuse', 'EAN', '', '9782111380808', 'MANQUANT_SYRACUSE'),
  t('vide-vide', 'Editeur', '', '', 'IDENTIQUE'),
  t('vide-syracuse', AUTEUR, '', 'Dupont', 'MANQUANT_SYRACUSE'),
  t('vide-sudoc', AUTEUR, 'Dupont', '', 'ABSENT_SUDOC'),
  t('vide-sudoc', 'Publié le', '2022', '', 'ABSENT_SUDOC'),
  t('vide-sudoc', 'Collection', ' ', '', 'ABSENT_SUDOC'),
  t('espace-seul', 'Collection', ' ', 'x', 'ERREUR'),
  // — champs non modifiables : vides testés avant, puis NON_VERIFIE si les deux sont remplis
  t('vide-syracuse', 'Identifiant', '', 'B', 'MANQUANT_SYRACUSE'),
  t('vide-sudoc', 'Filtre', 'SUDOC', '', 'ABSENT_SUDOC'),
  ...UNMODIFIABLE_FIELDS.map((champ) => t('non-modifiable', champ, 'a', 'b', 'NON_VERIFIE')),
  // — ISBN : tirets ignorés, espaces NON ignorés
  t('isbn', 'ISBN', '978-2-11-138080-8', '9782111380808', 'IDENTIQUE'),
  t('isbn', 'ISBN', '2-11-138080-1', '2111380801', 'IDENTIQUE'),
  t('isbn', 'ISBN', '978 2 11 138080 8', '9782111380808', 'ERREUR'),
  t('isbn', 'ISBN', '9782111380808', '9782111380809', 'ERREUR'),
  t('isbn', 'ISBN', '978-2-11-138080-8', '978-2-11-138080-8 ', 'ERREUR'),
  t('isbn', 'ISBN', '978–2–11', '978-2-11', 'ERREUR'),
  // — EAN : espaces ignorés (y compris tabulation), tirets NON ignorés
  t('ean', 'EAN', '978 2111 380808', '9782111380808', 'IDENTIQUE'),
  t('ean', 'EAN', '9782111380808', '9782111380808', 'IDENTIQUE'),
  t('ean', 'EAN', '9782111380808\t', '9782111380808', 'IDENTIQUE'),
  t('ean', 'EAN', '978-2111380808', '9782111380808', 'ERREUR'),
  t('ean', 'EAN', '9782111380808', '9782111380809', 'ERREUR'),
  // — année : premier groupe de 4 chiffres ASCII de chaque côté
  t('annee', 'Publié le', 'C 2022', '2022', 'IDENTIQUE'),
  t('annee', 'Publié le', '2022', '2023', 'ERREUR'),
  t('annee', 'Publié le', '2022, cop. 2021', '2022', 'IDENTIQUE'),
  t('annee', 'Publié le', 'sans date', '2022', 'ERREUR'),
  t('annee', 'Publié le', '202', '2022', 'ERREUR'),
  t('annee', 'Publié le', '12345', '1234', 'IDENTIQUE'),
  t('annee', 'Publié le', 'vers 1965 ?', '1965', 'IDENTIQUE'),
  t('annee', 'Publié le', 'XXXX', 'sans date', 'ERREUR'),
  t('annee', 'Publié le', '٢٠٢٢', '2022', 'ERREUR'), // chiffres arabo-indiques : \d JavaScript = ASCII
  t('annee', 'Publié le', 'cop. 2021, 2022', '2022', 'ERREUR'),
  // — auteurs : l'IdRef fait foi
  t('auteur-idref-commun', AUTEUR, 'Ledoux, Pierre (1932-2011) 026927438', 'Ledoux Pierre 1932-2011 026927438 070', 'DIFFERENCE_MINEURE'),
  t('auteur-idref-commun', AUTEUR, 'Dupont Jean 026927438', 'dupont jean 026927438', 'IDENTIQUE'),
  t('auteur-idref-commun', AUTEUR, 'Éluard Paul 026927438', 'Eluard Paul 026927438', 'IDENTIQUE'),
  t('auteur-idref-commun', 'Auteur secondaire - Personne physique', 'Éluard Paul 026927438', 'Eluard Paul 026927438', 'IDENTIQUE'),
  t('auteur-idref-commun', 'Auteur secondaire- Collectivité', 'Insee 026927438', 'INSEE 026927438', 'IDENTIQUE'),
  t('auteur-idref-commun', 'Autre auteur principal - Personne physique', 'Dupont J. 026927438', 'Dupont Jean 026927438 070', 'DIFFERENCE_MINEURE'),
  t('auteur-idref-commun', AUTEUR, 'A 026927438 ; B 070123456', 'A 026927438', 'DIFFERENCE_MINEURE'),
  t('auteur-idref-x-minuscule', AUTEUR, 'Nom 12345678x', 'Nom 12345678X', 'IDENTIQUE'),
  t('auteur-idref-differents', AUTEUR, 'Dupont Jean 026927438', 'Durand Paul 070123456', 'ERREUR'),
  t('auteur-idref-differents', 'Autre auteur principal - Collectivité', 'Insee 026927438', 'Ined 070123456', 'ERREUR'),
  t('auteur-idref-un-cote', AUTEUR, 'Dupont, Jean', 'Dupont Jean 026927438', 'ERREUR'),
  t('auteur-nombre-10-chiffres', AUTEUR, 'Nom 1234567890', 'Nom 1234567891', 'DIFFERENCE_MINEURE'),
  t('auteur-prefixe-sensible-casse', 'auteur principal', 'Dupont 026927438', 'Durand 070123456', 'ERREUR'),
  // — titre : normalisation, similarité > 0,9, inclusion
  t('titre-egal-normalise', 'Titre', 'Les comptes de la nation : édition 2022', 'Les comptes de la nation ; édition 2022', 'IDENTIQUE'),
  t('titre-egal-normalise', 'Titre', 'L’économie', "L'économie", 'IDENTIQUE'),
  t('titre-egal-normalise', 'Titre', 'Titre A', 'titre a', 'IDENTIQUE'),
  t('titre-egal-normalise', 'Titre', 'Le titre', 'Le titre', 'IDENTIQUE'),
  t('titre-egal-normalise', 'Titre', 'A;B', 'A B', 'IDENTIQUE'),
  t('titre-egal-normalise', 'Titre', 'ab', 'ab ', 'IDENTIQUE'),
  t('titre-inclusion', 'Titre', 'Les comptes de la nation', 'Les comptes de la nation 2022', 'DIFFERENCE_MINEURE'),
  t('titre-inclusion-chaine-vide', 'Titre', ':', 'abc', 'DIFFERENCE_MINEURE'),
  t('titre-similarite', 'Titre', 'Le recensement de la population de 1954', 'Le recensement de la population de 1955', 'DIFFERENCE_MINEURE'),
  t('titre-similarite', 'Titre', 'Les comptes de la nation édition 2022', 'Les comptes de la nations édition 2022', 'DIFFERENCE_MINEURE'),
  t('titre-erreur', 'Titre', 'Statistiques agricoles', 'Comptes nationaux', 'ERREUR'),
  t('titre-erreur', 'Titre', 'a', 'b', 'ERREUR'),
  t('titre-sans-diacritiques', 'Titre', 'Économie', 'Economie', 'ERREUR'),
  // — éditeur : minuscules + diacritiques, > 0,85 identique, > 0,5 mineure
  t('editeur-egal', 'Editeur', 'INSEE', 'Insee', 'IDENTIQUE'),
  t('editeur-egal', 'Editeur', 'Éditions du Seuil', 'Editions du Seuil', 'IDENTIQUE'),
  t('editeur-sim-haute', 'Editeur', 'La Découverte', 'Decouverte', 'IDENTIQUE'),
  t('editeur-sim-moyenne', 'Editeur', 'Gallimard', 'Gallimard Jeunesse', 'DIFFERENCE_MINEURE'),
  t('editeur-sim-moyenne', 'Editeur', 'Insee ; Eurostat', 'Insee : Eurostat', 'DIFFERENCE_MINEURE'), // pas de normalizeString : ; et : restent
  t('editeur-erreur', 'Editeur', 'Dunod', 'Hachette', 'ERREUR'),
  t('editeur-seuil-085', 'Editeur', a20, a20.slice(0, 18) + 'uvwx', 'DIFFERENCE_MINEURE'),      // 0,85 exactement : > strict
  t('editeur-seuil-05', 'Editeur', a11, a11.slice(0, 6) + 'lmnop', 'ERREUR'),                   // 0,5 exactement : > strict
  t('editeur-au-dessus-05', 'Editeur', a11, a11.slice(0, 7) + 'lmnop', 'DIFFERENCE_MINEURE'),
  // — champs génériques : normalisation puis > 0,9
  t('generique-egal', 'Collection', 'Insee références', 'Insee Références', 'IDENTIQUE'),
  t('generique-egal', 'Notes', 'a;b', 'a b', 'IDENTIQUE'),
  t('generique-egal', 'Prix', '22 EUR', '22 eur', 'IDENTIQUE'),
  t('generique-egal', 'Table des matières', 'Chap. 1 ; Chap. 2', 'Chap. 1 : Chap. 2', 'IDENTIQUE'),
  t('generique-seuil-09', 'Collection', a10, a10 + 'kl', 'ERREUR'),                             // 0,9 exactement : > strict
  t('generique-au-dessus-09', 'Collection', a10, a11, 'DIFFERENCE_MINEURE'),
  t('generique-mineure', 'Résumé', 'Synthèse annuelle des comptes nationaux.', 'Synthèse annuelle des comptes nationaux', 'DIFFERENCE_MINEURE'),
  t('generique-mineure', 'Vedette matière - Nom commun', 'Économie rameau', 'Economie rameau', 'DIFFERENCE_MINEURE'),
  t('generique-erreur', 'Résumé', 'Texte A', 'Texte B', 'ERREUR'),
  t('generique-erreur', 'Description matérielle', '1 volume (151 pages)', '1 volume (151 pages) ill.', 'ERREUR'),
  t('generique-hors-bmp', 'Collection', '😀😀', '😀😁', 'ERREUR'),
];

const ecartsAgent: string[] = [];
const compareFieldsRef = triplets.map((tr) => {
  const reel = compareFields(tr.champ, tr.syracuse, tr.sudoc);
  const ecart = reel.statut !== tr.attendu_agent;
  if (ecart) ecartsAgent.push(`[${tr.branche}] ${tr.champ} | ${JSON.stringify(tr.syracuse)} | ${JSON.stringify(tr.sudoc)} : attendu ${tr.attendu_agent}, TypeScript ${reel.statut}`);
  return { ...tr, statut: reel.statut, categorie: reel.categorie, ...(ecart ? { ecart_avec_attendu_agent: true } : {}) };
});
ecrireJson('compare_fields.json', compareFieldsRef);

// ─── 3. Lecture des fixtures ─────────────────────────────────────────────────
// Format neutre : les propriétés perdent le préfixe « @_ » de fast-xml-parser ; un attribut
// absent est écrit null (pour distinguer « absent » de « vide »). parsedXml n'est pas écrit.
const neutre = (xml: string) => {
  const { notices, countCatA, countCatB } = parseSyracuseNotices(xml);
  return {
    countCatA, countCatB,
    notices: notices.map((n: any) => ({
      ppn: n.ppn, titre: n.titre, identifiant: n.identifiant, categorie: n.categorie,
      syracuse: n.syracuse, itemType: n.itemType,
      properties: n.properties.map((p: any) => ({
        name: p['@_name'] ?? null, value: p['@_value'] ?? null, rank: p['@_rank'] ?? null,
        referentialType: p['@_referentialType'] ?? null, referentialName: p['@_referentialName'] ?? null,
      })),
    })),
  };
};
ecrireJson('syracuse.json', neutre(SYRACUSE));
ecrireJson('syracuse_cas_limites.json', neutre(SYRACUSE_LIM));
ecrireJson('sudoc.json', parseSudocXml(SUDOC));
ecrireJson('sudoc_cas_limites.json', parseSudocXml(SUDOC_LIM));
ecrireTexte('unimarc.txt', unimarcXmlToText(SUDOC));
ecrireTexte('unimarc_cas_limites.txt', unimarcXmlToText(SUDOC_LIM));

// ─── 4. ecarts.json ──────────────────────────────────────────────────────────
const parse = parseSyracuseNotices(SYRACUSE);
const parseLim = parseSyracuseNotices(SYRACUSE_LIM);
const sudocData = parseSudocXml(SUDOC);
const sudocDataLim = parseSudocXml(SUDOC_LIM);

// Variantes de la fixture Sudoc, fabriquées par remplacement de texte.
const AVANT_100 = '  <datafield tag="100"';
const variantes: Record<string, string> = {
  'fixture-avec-073-et-183': SUDOC.replace(AVANT_100,
    '  <datafield tag="073" ind1=" " ind2="0"><subfield code="a">9782111380808</subfield></datafield>\n' +
    '  <datafield tag="183" ind1=" " ind2=" "><subfield code="a">nga</subfield></datafield>\n' + AVANT_100),
  'fixture-215-sans-illustration': SUDOC.replace('    <subfield code="c">ill.</subfield>\n', ''),
  'fixture-isbn-10': SUDOC.replace('978-2-11-138080-8', '2-11-138080-1'),
};
for (const [nom, xml] of Object.entries(variantes)) {
  if (xml === SUDOC) throw new Error(`Variante « ${nom} » sans effet : la fixture a changé`);
}

const comparer = (properties: any[], sudoc: any) => compareNoticeWithSudoc(properties, sudoc);
const casEcarts = (parsed: ReturnType<typeof parseSyracuseNotices>, sudocNom: string, sudoc: any) =>
  parsed.notices.map((n: any) => ({ identifiant: n.identifiant, sudoc: sudocNom, ...comparer(n.properties, sudoc) }));

ecrireJson('ecarts.json', [
  ...casEcarts(parse, 'sudoc-267670346', sudocData), // notice A + deux notices B (simulation d'un rattachement)
  ...Object.entries(variantes).map(([nom, xml]) => ({
    identifiant: parse.notices[0].identifiant, sudoc: nom, ...comparer(parse.notices[0].properties, parseSudocXml(xml)),
  })),
  { identifiant: parse.notices[0].identifiant, sudoc: 'aucune-donnee-sudoc', ...comparer(parse.notices[0].properties, null) },
]);
ecrireJson('ecarts_cas_limites.json', casEcarts(parseLim, 'sudoc-cas-limites', sudocDataLim));

// ─── 5. Exports : session construite + jeu de décisions fixe ─────────────────
// Les routes de server/index.ts ne sont pas appelables (le fichier lance le serveur à
// l'import). Leur logique est donc RECOPIÉE ICI À L'IDENTIQUE, numéros de lignes d'origine en
// commentaire. server/index.ts n'est pas modifié.
type Decision =
  | { op: 'action'; identifiant: string; champ: string; action: string; valeurModifiee?: string }
  | { op: 'bulk'; identifiant: string; action: string }
  | { op: 'valider'; identifiant: string }
  | { op: 'rattacher'; identifiant: string; ppn: string }
  | { op: 'absent'; identifiant: string }
  | { op: 'vedette'; identifiant: string; texte: string }
  | { op: 'suggestions'; identifiant: string; suggestions: Array<{ text: string; selected: boolean }> };

function appliquerDecision(session: any, d: Decision) {
  const resultat = session.results.find((r: any) => r.identifiant === d.identifiant);
  if (!resultat) throw new Error(`Notice inconnue : ${d.identifiant}`);

  if (d.op === 'action') {
    // index.ts:243-264 (PUT /api/results/:sessionId/:identifiant/action)
    if (!resultat.ecarts) resultat.ecarts = [];
    let ecart = resultat.ecarts.find((e: any) => e.champ === d.champ);
    if (!ecart) {
      let sudocVal = '';
      if (resultat.sudoc) {
        const sudocKey = SYRACUSE_MAPPING[d.champ];
        if (sudocKey && resultat.sudoc[sudocKey]) sudocVal = String(resultat.sudoc[sudocKey]);
      }
      ecart = { champ: d.champ, valeurSyracuse: '', valeurSudoc: sudocVal, statut: 'MODIFIE', action: d.action };
      resultat.ecarts.push(ecart);
    }
    ecart.action = d.action;
    if (d.action === 'MODIFIER') ecart.valeurModifiee = d.valeurModifiee;
  } else if (d.op === 'bulk') {
    // index.ts:266-302 (POST /api/results/:sessionId/bulk-action, branche « ppn » renseigné)
    const action = d.action;
    const applyToEcart = (e: any) => {
      if (action === 'ACCEPTER_ERREURS' && e.statut === 'ERREUR') e.action = 'ACCEPTER';
      if (action === 'ACCEPTER_COMPLEMENTS' && e.statut === 'MANQUANT_SYRACUSE') e.action = 'ACCEPTER';
      if (action === 'TOUT_ACCEPTER' && ['ERREUR', 'MANQUANT_SYRACUSE', 'DIFFERENCE_MINEURE'].includes(e.statut)) e.action = 'ACCEPTER';
      if (action === 'TOUT_REJETER') e.action = 'CONSERVER';
    };
    if (resultat.categorie === 'B' && action === 'TOUT_ACCEPTER' && resultat.sudoc) {
      for (const [k, v] of Object.entries(resultat.sudoc)) {
        if (['ppn', 'recordData', 'raw', 'hasTypeSupport', 'eanGenerated', 'collation215'].includes(k)) continue;
        const sv = String(v ?? '').trim();
        if (!sv) continue;
        let champName = '';
        for (const [sn, sk] of Object.entries(SYRACUSE_MAPPING)) {
          if (sk === k) { champName = sn; break; }
        }
        if (!champName) continue;
        let ecart = resultat.ecarts.find((e: any) => e.champ === champName);
        if (!ecart) {
          ecart = { champ: champName, valeurSyracuse: '', valeurSudoc: sv, statut: 'MODIFIE', action: 'ACCEPTER' };
          resultat.ecarts.push(ecart);
        } else ecart.action = 'ACCEPTER';
      }
      resultat.ecarts.forEach((e: any) => e.action = 'ACCEPTER');
    } else resultat.ecarts.forEach(applyToEcart);
  } else if (d.op === 'valider') {
    // index.ts:172-189 (POST …/valider) — la recherche par ppn est écartée : on désigne par identifiant
    if (resultat.statutGlobal === 'VALIDE') {
      if (resultat.categorie === 'B') resultat.statutGlobal = 'RATTACHE_SRU';
      else {
        let statutGlobal = 'OK';
        if (resultat.nbErreurs > 0) statutGlobal = 'ERREUR';
        else if (resultat.nbComplements > 0) statutGlobal = 'COMPLEMENT';
        else if (resultat.nbMineures > 0) statutGlobal = 'DIFFERENCE_MINEURE'; // anomalie A1, reproduite telle quelle
        resultat.statutGlobal = statutGlobal;
      }
    } else resultat.statutGlobal = 'VALIDE';
  } else if (d.op === 'rattacher') {
    // index.ts:192-230 (POST …/rattacher). Le XML Sudoc vient de la fixture au lieu de
    // fetchSudocRecord (réseau interdit) : lignes 197-199 remplacées, le reste à l'identique.
    const nouveauPpn = padPpn(d.ppn);
    const sudocXml = SUDOC;
    const sudocDataR = parseSudocXml(sudocXml);
    const notice = resultat;
    notice.ppn = nouveauPpn;
    if (notice.syracuse && typeof notice.syracuse === 'object') notice.syracuse["Identifiant d'origine"] = nouveauPpn;
    notice.sudoc = sudocDataR;
    notice.sudocXml = sudocXml;
    notice.statutGlobal = 'RATTACHE_SRU';
    const origNotice = session.notices.find((n: any) => n.identifiant === d.identifiant);
    if (origNotice) {
      origNotice.ppn = nouveauPpn;
      if (origNotice.syracuse) origNotice.syracuse["Identifiant d'origine"] = nouveauPpn;
      if (Array.isArray(origNotice.properties)) {
        const origProp = origNotice.properties.find((p: any) => p['@_name'] === "Identifiant d'origine");
        if (origProp) origProp['@_value'] = nouveauPpn;
      }
    }
    const { ecarts, nbErreurs, nbComplements, nbMineures } =
      compareNoticeWithSudoc(origNotice?.properties || [], sudocDataR);
    notice.ecarts = ecarts;
    notice.nbErreurs = nbErreurs;
    notice.nbComplements = nbComplements;
    notice.nbMineures = nbMineures;
  } else if (d.op === 'absent') {
    // index.ts:233-241 (POST …/absent)
    resultat.statutGlobal = 'ABSENT_SUDOC';
    resultat.ecarts = [];
  } else if (d.op === 'vedette') {
    // index.ts:488-512 (PUT …/add-keyword)
    const notice = resultat;
    if (!notice.ecarts) notice.ecarts = [];
    const champVedettes = 'Vedette matière - Nom commun';
    let ecart = notice.ecarts.find((e: any) => e.champ === champVedettes);
    const currentValue = ecart
      ? (ecart.action === 'ACCEPTER' ? ecart.valeurSudoc : (ecart.action === 'MODIFIER' ? ecart.valeurModifiee : ecart.valeurSyracuse))
      : '';
    const newKeyword = d.texte.trim() + ' rameau';
    const newValue = currentValue ? currentValue + '; ' + newKeyword : newKeyword;
    if (!ecart) {
      ecart = { champ: champVedettes, valeurSyracuse: '', valeurSudoc: '', statut: 'MODIFIE', action: 'MODIFIER', valeurModifiee: newValue };
      notice.ecarts.push(ecart);
    } else {
      ecart.action = 'MODIFIER';
      ecart.valeurModifiee = newValue;
    }
  } else if (d.op === 'suggestions') {
    // index.ts:477-486 (PUT …/update-ai-suggestions)
    resultat.aiSuggestions = d.suggestions;
  }
}

function construireSession() {
  const { parsedXml, notices } = parseSyracuseNotices(SYRACUSE);
  // Notice A (SYR-001) : comme dans test/exports.test.ts et verify.ts:69-82
  const a = compareNoticeWithSudoc(notices[0].properties, sudocData);
  let statutA = 'OK';
  if (a.nbErreurs > 0) statutA = 'ERREUR';
  else if (a.nbComplements > 0) statutA = 'COMPLEMENT';
  else if (a.nbMineures > 0) statutA = 'MINEURE';
  const enAttente = (n: any, ppn: string) => ({
    ppn, titre: n.titre, identifiant: n.identifiant, categorie: 'B', syracuse: n.syracuse,
    statutGlobal: 'EN_ATTENTE_RATTACHEMENT', candidates: [], sruCandidates: [], ecarts: [],
  });
  return {
    originalXml: SYRACUSE, parsedXml, notices,
    results: [
      {
        ppn: '267670346', titre: notices[0].titre, identifiant: 'SYR-001', categorie: 'A',
        syracuse: notices[0].syracuse, sudoc: sudocData, sudocXml: SUDOC,
        statutGlobal: statutA, ...a,
      },
      enAttente(notices[1], '65493583'),
      enAttente(notices[2], '123456'),
    ],
    status: 'COMPLETED', progress: { current: 3, total: 3 },
  };
}

const decisions: Decision[] = [
  { op: 'action', identifiant: 'SYR-001', champ: 'Titre', action: 'ACCEPTER' },
  { op: 'action', identifiant: 'SYR-001', champ: 'Editeur', action: 'CONSERVER' },
  { op: 'action', identifiant: 'SYR-001', champ: 'Résumé', action: 'MODIFIER', valeurModifiee: 'Texte "modifié" & <testé> ; ok' },
  { op: 'vedette', identifiant: 'SYR-001', texte: '  Statistique publique ' },
  { op: 'suggestions', identifiant: 'SYR-001', suggestions: [
    { text: 'Comptabilité nationale Histoire', selected: true }, { text: 'Autre piste "non retenue"', selected: false },
  ] },
  { op: 'rattacher', identifiant: 'SYR-002', ppn: '267670346' },
  { op: 'bulk', identifiant: 'SYR-002', action: 'TOUT_ACCEPTER' },
  { op: 'action', identifiant: 'SYR-002', champ: 'Titre', action: 'CONSERVER' },
  { op: 'absent', identifiant: 'SYR-003' },
  { op: 'action', identifiant: 'SYR-003', champ: 'Résumé', action: 'MODIFIER', valeurModifiee: 'Ajout manuel' },
  { op: 'valider', identifiant: 'SYR-001' },
  { op: 'valider', identifiant: 'SYR-001' }, // bascule deux fois : valide puis dévalide
];
ecrireJson('export_decisions.json', decisions);

const session = construireSession();
for (const d of decisions) appliquerDecision(session, d);
ecrireTexte('export.xml', buildXmlExport(session as any));
ecrireTexte('export.csv', buildCsvExport(session as any));
ecrireTexte('export.txt', await buildTxtExport(session as any));

// ─── Contrôles de volume et bilan ────────────────────────────────────────────
if (similarite.length < 30) throw new Error(`similarite.json : ${similarite.length} paires (< 30)`);
if (compareFieldsRef.length < 60) throw new Error(`compare_fields.json : ${compareFieldsRef.length} triplets (< 60)`);
void PSEUDO_UNIMARC_FIELDS;

console.log(`similarite.json      : ${similarite.length} paires`);
console.log(`compare_fields.json  : ${compareFieldsRef.length} triplets`);
console.log(`écarts attendu_agent ≠ TypeScript : ${ecartsAgent.length}`);
for (const e of ecartsAgent) console.log(`  ÉCART ${e}`);
