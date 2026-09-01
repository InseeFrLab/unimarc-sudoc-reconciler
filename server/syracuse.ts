/**
 * syracuse.ts — Côté Syracuse (le SIGB source, export XML "items/property").
 *
 * - detectCategory : une notice a-t-elle déjà un PPN Sudoc (catégorie "A")
 *   ou faut-il la rechercher (catégorie "B", identifiants PMB) ?
 * - parseSyracuseNotices : lit le XML uploadé et en extrait la liste des notices.
 * - Les tables de correspondance entre les libellés de champs Syracuse et,
 *   d'une part les clés internes du Sudoc (SYRACUSE_MAPPING), d'autre part les
 *   zones UNIMARC (SYRACUSE_TO_UNIMARC).
 */
import { XMLParser } from 'fast-xml-parser';

// Détermine la catégorie A (déjà liée au Sudoc) ou B (à rechercher).
export function detectCategory(notice: any) {
  const filtre = (notice['Filtre'] || '').toUpperCase();
  const id = notice["Identifiant d'origine"] || '';
  if (filtre.includes('SUDOC') || /^[0-9]{8}[0-9X]$/.test(id)) {
    return 'A';
  }
  return 'B';
}

export const SYRACUSE_MAPPING: Record<string, string> = {
  "Titre": "titre",
  "Auteur principal - Personne physique": "auteurPrincipal",
  "Autre auteur principal - Personne physique": "autresAuteurs",
  "Auteur secondaire - Personne physique": "auteursSecondaires",
  "Auteur principal - Collectivité ": "auteurPrincipalCollectivite",
  "Autre auteur principal - Collectivité": "autreAuteurPrincipalCollectivite",
  "Auteur secondaire- Collectivité": "auteurSecondaireCollectivite",
  "Editeur": "editeur", "Publié le": "annee", "ISBN": "isbn", "EAN": "ean",
  "Collection": "collection", "Description matérielle": "descriptionMaterielle",
  "Résumé": "resume", "Table des matières": "tableDesMatieres",
  "Vedette matière - Nom commun": "vedetteNomCommun",
  "Vedette matière - Nom de personne": "vedettePersonne",
  "Vedette matière - Nom de collectivité": "vedetteCollectivite",
  "Vedette matière - Nom géographique": "vedetteGeo",
  "Vedette matière - Forme, genre": "vedetteFormeGenre",
  "Prix": "prix", "Notes": "notes"
};

/**
 * Mapping inverse Syracuse → UNIMARC pour appliquer les corrections utilisateur
 * sur le texte UNIMARC exporté.
 * Permet de retrouver la zone et le code de subfield à partir du nom du champ Syracuse.
 */
export const SYRACUSE_TO_UNIMARC: Record<string, { tag: string; code: string }> = {
  "Titre": { tag: "200", code: "a" },
  "ISBN": { tag: "010", code: "a" },
  "EAN": { tag: "073", code: "a" },
  "Editeur": { tag: "214", code: "c" },
  "Publié le": { tag: "214", code: "d" },
  "Description matérielle": { tag: "215", code: "a" },
  "Collection": { tag: "225", code: "a" },
  "Résumé": { tag: "330", code: "a" },
  "Table des matières": { tag: "327", code: "a" },
  "Auteur principal - Personne physique": { tag: "700", code: "a" },
  "Vedette matière - Nom commun": { tag: "606", code: "a" },
  "Vedette matière - Nom géographique": { tag: "607", code: "a" },
  "Vedette matière - Forme, genre": { tag: "608", code: "a" },
  "Vedette matière - Nom de personne": { tag: "600", code: "a" },
  "Vedette matière - Nom de collectivité": { tag: "601", code: "a" },
  "Notes": { tag: "300", code: "a" },
  "Prix": { tag: "010", code: "d" }
};

export const UNMODIFIABLE_FIELDS = [
  "Identifiant", "Identifiant d'origine", "Filtre", "Règle", 
  "Nombre d'exemplaires", "Référence commerciale", "Référence éditoriale", 
  "EAN (valeur)", "UPC", "Document", "Type de notice"
];

// ─── Pseudo-champs ───────────────────────────────────────────────────────────
// Certaines propositions ne correspondent à AUCUN champ Syracuse : elles ne
// concernent que la notice UNIMARC destinée à WINIBW. On les fait circuler dans
// la liste des écarts (pour que la documentaliste puisse les accepter ou les
// refuser), mais elles ne doivent jamais être écrites dans le XML Syracuse.
export const CHAMP_TYPE_SUPPORT = 'Type de support (183)';
export const LIGNE_183_DEFAUT = '183 ##$P01$anga'; // volume imprimé, code RDA
export const PSEUDO_UNIMARC_FIELDS = new Set<string>([CHAMP_TYPE_SUPPORT]);

/**
 * Lit le contenu XML d'un export Syracuse et renvoie la liste des notices
 * exploitables (celles possédant un "Identifiant"), plus le décompte par
 * catégorie. Logique reprise à l'identique de la route /api/upload d'origine.
 */
export function parseSyracuseNotices(xmlString: string) {
  // parseAttributeValue: false (défaut, rendu explicite) — sans quoi un
  // "Identifiant d'origine" comme 065493583 serait converti en nombre et
  // perdrait son zéro initial.
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_',
    preserveOrder: false, parseAttributeValue: false, parseTagValue: false,
  });
  const parsedXml = parser.parse(xmlString);

  // Le XML Syracuse imbrique les notices sous des noeuds "item" contenant des
  // "property". On parcourt récursivement l'arbre pour les retrouver, quelle
  // que soit la profondeur exacte du document.
  const items: any[] = [];
  const searchItems = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.property && (Array.isArray(node.property) || typeof node.property === 'object')) {
      items.push(node);
      return;
    }
    if (Array.isArray(node)) node.forEach(searchItems);
    else Object.values(node).forEach(searchItems);
  };
  searchItems(parsedXml);

  const notices = items.map((item: any) => {
    const properties = Array.isArray(item.property) ? item.property : (item.property ? [item.property] : []);
    const ppnProp = properties.find((p: any) => p['@_name'] === "Identifiant d'origine");
    const titreProp = properties.find((p: any) => p['@_name'] === "Titre");
    const idProp = properties.find((p: any) => p['@_name'] === "Identifiant");
    const parsedNotice: any = {};
    properties.forEach((p: any) => {
      if (p['@_name'] && p['@_value'] !== undefined) parsedNotice[p['@_name']] = p['@_value'];
    });
    const categorie = detectCategory(parsedNotice);
    return {
      ppn: ppnProp && ppnProp['@_value'] !== undefined ? String(ppnProp['@_value']) : null,
      titre: titreProp && titreProp['@_value'] !== undefined ? String(titreProp['@_value']) : null,
      identifiant: idProp && idProp['@_value'] !== undefined ? String(idProp['@_value']) : null,
      categorie,
      syracuse: parsedNotice,
      properties,
      itemType: item['@_type'] || 'GESMARC',
    };
  }).filter((n: any) => n.identifiant);

  const countCatA = notices.filter((n) => n.categorie === 'A').length;
  const countCatB = notices.filter((n) => n.categorie === 'B').length;
  return { parsedXml, notices, countCatA, countCatB };
}
