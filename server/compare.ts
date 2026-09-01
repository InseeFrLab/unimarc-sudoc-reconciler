/**
 * compare.ts — Cœur du diagnostic : comparer chaque champ d'une notice
 * Syracuse à la valeur correspondante du Sudoc et en déduire un statut
 * (IDENTIQUE, DIFFERENCE_MINEURE, ERREUR, MANQUANT_SYRACUSE...).
 *
 * Les seuils de similarité et les règles spéciales (ISBN, EAN, année, titre,
 * éditeur) sont repris tels quels du POC.
 */
import stringSimilarity from 'string-similarity';
import { CHAMP_TYPE_SUPPORT, LIGNE_183_DEFAUT, SYRACUSE_MAPPING, UNMODIFIABLE_FIELDS } from './syracuse.ts';
import { buildFusedCollation, normalizeDescription } from './marc.ts';

export function normalizeString(str: string) {
  if (!str) return '';
  return str.toLowerCase().replace(/[;:]/g, ' ').replace(/['']/g, "'").replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}
export function removeAccents(str: string) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Extrait les IdRef (identifiants d'autorité, 9 caractères comme un PPN) d'une
 * chaîne d'auteur. Côté Sudoc ils viennent de la sous-zone $3, côté Syracuse ils
 * sont noyés dans la concaténation "Nom Prénom dates IdRef code_fonction".
 */
export function extractIdrefs(value: any): string[] {
  const matches = String(value ?? '').toUpperCase().match(/(?<!\d)\d{8}[\dX](?!\d)/g) || [];
  return [...new Set(matches)];
}

/** Champs dont la valeur décrit un auteur (zones 700/701/702, 710/711/712). */
export function isAuthorField(champ: string): boolean {
  return /^(Auteur|Autre auteur)/.test(champ || '');
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
  if (isAuthorField(champ)) {
    // L'IdRef fait foi : même identifiant = même personne, quelle que soit la
    // graphie. C'est ce qui évite de signaler en ERREUR un "Dupont, Jean" contre
    // un "Dupont Jean 1932-2011 026927438 070".
    const idref1 = extractIdrefs(s1); const idref2 = extractIdrefs(s2);
    if (idref1.length && idref2.length) {
      const memeAutorite = idref1.some((id) => idref2.includes(id));
      if (!memeAutorite) return { statut: 'ERREUR', categorie: 'ERREUR' };
      const a1 = normalizeString(removeAccents(s1)); const a2 = normalizeString(removeAccents(s2));
      return a1 === a2
        ? { statut: 'IDENTIQUE', categorie: 'OK' }
        : { statut: 'DIFFERENCE_MINEURE', categorie: 'MINEURE' };
    }
    // Pas d'IdRef d'un côté au moins : on retombe sur la comparaison générique.
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
    let unimarc: { tag: string; subfields: Record<string, string> } | undefined;
    if (champName === 'EAN' && !valSyracuse && sudocData?.eanGenerated) {
      statut = 'GENERE_AUTO'; action = 'ACCEPTER'; valSudoc = sudocData.ean;
    } else if (champName === 'Description matérielle') {
      const normSyracuse = normalizeDescription(valSyracuse);
      // Fusion des mentions d'illustrations : Syracuse en porte parfois que le
      // Sudoc ignore (« Tableaux »). On propose l'union plutôt que d'écraser.
      const fusion = valSyracuse ? buildFusedCollation(sudocData?.collation215, valSyracuse) : null;
      if (!valSyracuse && valSudoc) { statut = 'MANQUANT_SYRACUSE'; }
      else if (fusion) {
        statut = 'FUSION'; action = 'ACCEPTER'; valSudoc = fusion.value;
        unimarc = { tag: '215', subfields: fusion.subfields };
      }
      else if (valSyracuse && normSyracuse !== valSyracuse) {
        statut = 'NORMALISE'; action = 'ACCEPTER'; valSudoc = normSyracuse;
      } else { statut = compareFields(champName, valSyracuse, valSudoc).statut; }
    } else {
      statut = compareFields(champName, valSyracuse, valSudoc).statut;
    }
    if (statut === 'ERREUR') nbErreurs++;
    if (statut === 'MANQUANT_SYRACUSE') nbComplements++;
    if (statut === 'DIFFERENCE_MINEURE') nbMineures++;
    ecarts.push({
      champ: champName, valeurSyracuse: valSyracuse, valeurSudoc: valSudoc, statut, action,
      ...(unimarc ? { unimarc } : {}),
    });
  }
  // Proposition de zone 183 (type de support matériel) quand la notice Sudoc n'en
  // a pas. Pseudo-champ : il ne concerne que l'export UNIMARC, jamais le XML
  // Syracuse. Non compté dans les compteurs, comme l'EAN généré : c'est une
  // proposition technique, pas un écart entre les deux catalogues.
  if (sudocData && sudocData.hasTypeSupport === false) {
    ecarts.push({
      champ: CHAMP_TYPE_SUPPORT, valeurSyracuse: '', valeurSudoc: LIGNE_183_DEFAUT,
      statut: 'GENERE_AUTO', action: 'ACCEPTER',
    });
  }
  return { ecarts, nbErreurs, nbComplements, nbMineures };
}
