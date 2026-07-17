/**
 * compare.ts — Cœur du diagnostic : comparer chaque champ d'une notice
 * Syracuse à la valeur correspondante du Sudoc et en déduire un statut
 * (IDENTIQUE, DIFFERENCE_MINEURE, ERREUR, MANQUANT_SYRACUSE...).
 *
 * Les seuils de similarité et les règles spéciales (ISBN, EAN, année, titre,
 * éditeur) sont repris tels quels du POC.
 */
import stringSimilarity from 'string-similarity';
import { SYRACUSE_MAPPING, UNMODIFIABLE_FIELDS } from './syracuse.ts';
import { normalizeDescription } from './marc.ts';

export function normalizeString(str: string) {
  if (!str) return '';
  return str.toLowerCase().replace(/[;:]/g, ' ').replace(/['']/g, "'").replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}
export function removeAccents(str: string) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function compareFields(champ: string, valSyracuse: any, valSudoc: any): { statut: string, categorie: string } {
  const s1 = valSyracuse !== undefined && valSyracuse !== null ? String(valSyracuse) : '';
  const s2 = valSudoc !== undefined && valSudoc !== null ? String(valSudoc) : '';
  if (!s1 && !s2) return { statut: 'IDENTIQUE', categorie: 'OK' };
  if (!s1 && s2) return { statut: 'MANQUANT_SYRACUSE', categorie: 'COMPLEMENT' };
  if (s1 && !s2) return { statut: 'ABSENT_SUDOC', categorie: 'OK' };
  if (UNMODIFIABLE_FIELDS.includes(champ)) return { statut: 'NON_VERIFIE', categorie: 'OK' };
  if (champ === 'ISBN') {
    const i1 = s1.replace(/-/g, ''); const i2 = s2.replace(/-/g, '');
    return i1 === i2 ? { statut: 'IDENTIQUE', categorie: 'OK' } : { statut: 'ERREUR', categorie: 'ERREUR' };
  }
  if (champ === 'EAN') {
    const e1 = s1.replace(/\s/g, ''); const e2 = s2.replace(/\s/g, '');
    return e1 === e2 ? { statut: 'IDENTIQUE', categorie: 'OK' } : { statut: 'ERREUR', categorie: 'ERREUR' };
  }
  if (champ === 'Publié le') {
    const y1 = (s1.match(/\d{4}/) || [''])[0]; const y2 = (s2.match(/\d{4}/) || [''])[0];
    if (y1 && y2 && y1 === y2) return { statut: 'IDENTIQUE', categorie: 'OK' };
    return { statut: 'ERREUR', categorie: 'ERREUR' };
  }
  if (champ === 'Titre') {
    const t1 = normalizeString(s1); const t2 = normalizeString(s2);
    if (t1 === t2) return { statut: 'IDENTIQUE', categorie: 'OK' };
    const sim = stringSimilarity.compareTwoStrings(t1, t2);
    if (sim > 0.9 || t1.includes(t2) || t2.includes(t1)) return { statut: 'DIFFERENCE_MINEURE', categorie: 'MINEURE' };
    return { statut: 'ERREUR', categorie: 'ERREUR' };
  }
  if (champ === 'Editeur') {
    const e1 = removeAccents(s1.toLowerCase()).trim(); const e2 = removeAccents(s2.toLowerCase()).trim();
    if (e1 === e2) return { statut: 'IDENTIQUE', categorie: 'OK' };
    const sim = stringSimilarity.compareTwoStrings(e1, e2);
    if (sim > 0.85) return { statut: 'IDENTIQUE', categorie: 'OK' };
    if (sim > 0.5) return { statut: 'DIFFERENCE_MINEURE', categorie: 'MINEURE' };
    return { statut: 'ERREUR', categorie: 'ERREUR' };
  }
  const n1 = normalizeString(s1); const n2 = normalizeString(s2);
  if (n1 === n2) return { statut: 'IDENTIQUE', categorie: 'OK' };
  const sim = stringSimilarity.compareTwoStrings(n1, n2);
  if (sim > 0.9) return { statut: 'DIFFERENCE_MINEURE', categorie: 'MINEURE' };
  return { statut: 'ERREUR', categorie: 'ERREUR' };
}

/**
 * Compare l'ensemble des champs d'une notice Syracuse aux données Sudoc et
 * renvoie la liste des écarts + les compteurs. Factorise le bloc identique
 * qui existait en double dans /api/verify (catégorie A) et /api/rattacher.
 */
export function compareNoticeWithSudoc(properties: any[], sudocData: any) {
  const ecarts: any[] = [];
  let nbErreurs = 0, nbComplements = 0, nbMineures = 0;
  for (const prop of properties) {
    const champName = prop['@_name'];
    const valSyracuse = prop['@_value'] !== undefined && prop['@_value'] !== null ? String(prop['@_value']) : '';
    if (UNMODIFIABLE_FIELDS.includes(champName)) continue;
    const sudocKey = SYRACUSE_MAPPING[champName];
    let valSudoc = sudocKey && sudocData && sudocData[sudocKey] !== undefined && sudocData[sudocKey] !== null ? String(sudocData[sudocKey]) : '';
    let statut = '', action = 'CONSERVER';
    if (champName === 'EAN' && !valSyracuse && sudocData?.eanGenerated) {
      statut = 'GENERE_AUTO'; action = 'ACCEPTER'; valSudoc = sudocData.ean;
    } else if (champName === 'Description matérielle') {
      const normSyracuse = normalizeDescription(valSyracuse);
      if (!valSyracuse && valSudoc) { statut = 'MANQUANT_SYRACUSE'; }
      else if (valSyracuse && normSyracuse !== valSyracuse) {
        statut = 'NORMALISE'; action = 'ACCEPTER'; valSudoc = normSyracuse;
      } else { statut = compareFields(champName, valSyracuse, valSudoc).statut; }
    } else {
      statut = compareFields(champName, valSyracuse, valSudoc).statut;
    }
    if (statut === 'ERREUR') nbErreurs++;
    if (statut === 'MANQUANT_SYRACUSE') nbComplements++;
    if (statut === 'DIFFERENCE_MINEURE') nbMineures++;
    ecarts.push({ champ: champName, valeurSyracuse: valSyracuse, valeurSudoc: valSudoc, statut, action });
  }
  return { ecarts, nbErreurs, nbComplements, nbMineures };
}
