/**
 * marc.ts — Tout ce qui touche au catalogue Sudoc (ABES) et au format UNIMARC.
 *
 * Deux familles de fonctions :
 *   1. Accès réseau au Sudoc : recherche SRU (par titre/auteur/année) et
 *      récupération d'une notice par son PPN.
 *   2. Conversion UNIMARC : XML Sudoc -> objet structuré (champs "Syracuse"),
 *      et XML Sudoc -> notation texte WINIBW (pour l'export .txt).
 *
 * La logique de parsing est du savoir bibliothéconomique : elle est reprise
 * telle quelle du POC d'origine et ne doit être modifiée qu'avec précaution.
 */
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

/**
 * Options de parsing des XML du Sudoc.
 *
 * `parseTagValue: false` est CRUCIAL : par défaut fast-xml-parser convertit
 * "026927438" en nombre 26927438 et "070" en 70, ce qui détruit les zéros
 * initiaux. C'est exactement ce qui tronquait les PPN de la zone 001 des
 * réponses SRU et les IdRef de la sous-zone $3. Tout reste en chaîne.
 */
export const SUDOC_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
} as const;

// --- Constantes & utilitaires ---
export const SUDOC_BASE_URL = 'https://www.sudoc.fr';
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Un PPN Sudoc fait TOUJOURS 9 caractères (8 chiffres + 1 caractère de
 * contrôle, chiffre ou X). Le zéro initial est fréquemment perdu en route
 * (identifiant stocké comme entier, réponse SRU tronquée...). Sans ce padding,
 * https://www.sudoc.fr/{PPN}.xml répond 404.
 * À appliquer sur TOUT PPN avant un appel réseau ou un affichage.
 */
export function padPpn(ppn: string | number | null | undefined): string {
  if (ppn === null || ppn === undefined) return '';
  const s = String(ppn).trim().toUpperCase();
  if (/^[0-9]{7}[0-9X]$/.test(s)) return '0' + s; // 8 caractères -> 9
  return s;
}

/** Le PPN a-t-il la forme attendue (une fois paddé) ? */
export function isPpn(ppn: string | number | null | undefined): boolean {
  return /^[0-9]{8}[0-9X]$/.test(padPpn(ppn));
}

/**
 * L'identifiant ressemble-t-il à un PPN amputé de son zéro initial ?
 * Attention : un identifiant PMB à 8 chiffres a exactement la même forme. On ne
 * s'en sert donc JAMAIS pour classer une notice en catégorie A — seulement pour
 * proposer un candidat que la documentaliste validera.
 */
export function looksLikeTruncatedPpn(id: string | number | null | undefined): boolean {
  return /^[0-9]{7}[0-9X]$/.test(String(id ?? '').trim().toUpperCase());
}

// Mots vides ignorés lors de la construction d'une requête SRU.
export const STOP_WORDS = new Set([
  'the','a','an','of','in','on','to','for','and','or','its','by','with','from',
  'le','la','les','de','du','des','un','une','et','en','au','aux','dans','par','sur',
  'der','die','das','und','zu','von','im','ein','eine','für','mit'
]);

// --- Normalisations ---
export function normalizeDescription(desc: string) {
  if (!desc) return desc;
  let result = desc;
  result = result.replace(/\b1\s*vol(?:ume)?\.?/gi, '1 volume');
  result = result.replace(/(\d+)\s+p\.\)/g, '$1 pages)');
  result = result.replace(/(\d+)\s+p\.(\s|$)/g, '$1 pages$2');
  if (!/volume/i.test(result) && /\d+\s+pages/i.test(result)) {
    result = '1 volume ' + result;
  }
  result = result.replace(/volume\s+((?:[IVXLCDM]+-?)?\d[\w-]*\s+pages)/i, 'volume ($1)');
  return result;
}

export function generateEanFromIsbn(isbn: string) {
  if (!isbn) return '';
  const ean = isbn.replace(/[-\s]/g, '');
  if (/^\d{13}$/.test(ean)) return ean;
  return '';
}

// --- Parsing d'une notice UNIMARC Sudoc en objet structuré ---
export function parseSudocRecord(record: any) {
  if (!record) return null;
  const datafields = Array.isArray(record.datafield) ? record.datafield : (record.datafield ? [record.datafield] : []);
  const findDatafield = (tag: string) => datafields.find((df: any) => df['@_tag'] === tag);
  const findAllDatafields = (tag: string) => datafields.filter((df: any) => df['@_tag'] === tag);
  const getSubfield = (df: any, code: string) => {
    if (!df || !df.subfield) return null;
    const subfields = Array.isArray(df.subfield) ? df.subfield : [df.subfield];
    const sf = subfields.find((s: any) => String(s['@_code']) === String(code));
    return sf && sf['#text'] !== undefined && sf['#text'] !== null ? String(sf['#text']) : null;
  };
  const result: any = {};
  const zone200 = findDatafield('200');
  if (zone200) {
    const titreA = getSubfield(zone200, 'a') || '';
    const titreE = getSubfield(zone200, 'e') || '';
    result.titre = [titreA, titreE].filter(Boolean).join(' ');
  }
  const zone010 = findDatafield('010');
  if (zone010) {
    result.isbn = getSubfield(zone010, 'a') || '';
    result.prix = getSubfield(zone010, 'd') || '';
    let reliure = getSubfield(zone010, 'b') || '';
    // Pas de \b après le point : "br." en fin de chaîne ne matcherait jamais.
    reliure = reliure.replace(/\bbr\./gi, 'broché').replace(/\brel\./gi, 'relié');
    result.reliure = reliure;
  }
  const zone073 = findDatafield('073');
  if (zone073) result.ean = getSubfield(zone073, 'a') || '';
  if (!result.ean && result.isbn) {
    const eanFromIsbn = generateEanFromIsbn(result.isbn);
    if (eanFromIsbn) { result.ean = eanFromIsbn; result.eanGenerated = true; }
  }
  const zone183 = findDatafield('183');
  result.hasTypeSupport = !!zone183;
  const zone214 = findDatafield('214');
  const zone210 = findDatafield('210');
  const zoneEdition = zone214 || zone210;
  if (zoneEdition) {
    result.editeur = getSubfield(zoneEdition, 'c') || '';
    result.annee = getSubfield(zoneEdition, 'd') || '';
  }
  const zone215 = findDatafield('215');
  if (zone215) {
    const a = getSubfield(zone215, 'a') || '';
    const c = getSubfield(zone215, 'c') || '';
    const d = getSubfield(zone215, 'd') || '';
    const normalizedA = normalizeDescription(a);
    result.descriptionMaterielle = [normalizedA, c, d].filter(Boolean).join(' ');
  }
  const zones225 = findAllDatafields('225');
  result.collection = zones225.map((z: any) => getSubfield(z, 'a')).filter(Boolean).join(' ; ');
  const zone330 = findDatafield('330');
  result.resume = zone330 ? getSubfield(zone330, 'a') || '' : '';
  const zone327 = findDatafield('327');
  result.tableDesMatieres = zone327 ? getSubfield(zone327, 'a') || '' : '';
  const zone700 = findDatafield('700');
  if (zone700) {
    const nom = getSubfield(zone700, 'a') || '';
    const prenom = getSubfield(zone700, 'b') || '';
    const dates = getSubfield(zone700, 'f') || '';
    const idref = getSubfield(zone700, '3') || '';
    const code = getSubfield(zone700, '4') || '';
    result.auteurPrincipal = [nom, prenom, dates, idref, code].filter(Boolean).join(' ');
  }
  const zones701 = findAllDatafields('701');
  result.autresAuteurs = zones701.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b'), getSubfield(z,'f'), getSubfield(z,'3'), getSubfield(z,'4')].filter(Boolean).join(' ')).join(' ; ');
  const zones702 = findAllDatafields('702');
  result.auteursSecondaires = zones702.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b'), getSubfield(z,'f'), getSubfield(z,'3'), getSubfield(z,'4')].filter(Boolean).join(' ')).join(' ; ');
  const zones710 = findAllDatafields('710');
  result.auteurPrincipalCollectivite = zones710.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b'), getSubfield(z,'3'), getSubfield(z,'4')].filter(Boolean).join(' ')).join(' ; ');
  const zones711 = findAllDatafields('711');
  result.autreAuteurPrincipalCollectivite = zones711.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b'), getSubfield(z,'3'), getSubfield(z,'4')].filter(Boolean).join(' ')).join(' ; ');
  const zones712 = findAllDatafields('712');
  result.auteurSecondaireCollectivite = zones712.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b'), getSubfield(z,'3'), getSubfield(z,'4')].filter(Boolean).join(' ')).join(' ; ');
  const zones606 = findAllDatafields('606');
  result.vedetteNomCommun = zones606.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'x'), getSubfield(z,'y'), getSubfield(z,'z')].filter(Boolean).join(' ') + ' rameau').join('; ');
  const zones607 = findAllDatafields('607');
  result.vedetteGeo = zones607.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'x')].filter(Boolean).join(' ') + ' rameau').join('; ');
  const zones608 = findAllDatafields('608');
  result.vedetteFormeGenre = zones608.map((z: any) => (getSubfield(z,'a') || '') + ' rameau').join('; ');
  const zones600 = findAllDatafields('600');
  result.vedettePersonne = zones600.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b'), getSubfield(z,'f')].filter(Boolean).join(' ')).join('; ');
  const zones601 = findAllDatafields('601');
  result.vedetteCollectivite = zones601.map((z: any) => [getSubfield(z,'a'), getSubfield(z,'b')].filter(Boolean).join(' ')).join('; ');
  const noteTags = ['300','301','302','303','304','305'];
  const notes: string[] = [];
  for (const tag of noteTags) {
    const zones = findAllDatafields(tag);
    zones.forEach((z: any) => {
      const a = getSubfield(z, 'a');
      if (a) notes.push(a);
    });
  }
  result.notes = notes.join(' ; ');
  return result;
}

export function parseSudocXml(xmlString: string) {
  const parser = new XMLParser(SUDOC_PARSER_OPTIONS);
  const parsed = parser.parse(xmlString);
  return parseSudocRecord(parsed.record);
}

// --- Recherche SRU dans le Sudoc ---
export function parseSruResponse(xmlString: string) {
  const parser = new XMLParser(SUDOC_PARSER_OPTIONS);
  const data = parser.parse(xmlString);
  const root = data['srw:searchRetrieveResponse'];
  const count = parseInt(root?.['srw:numberOfRecords'] || '0');
  if (count === 0) return { count: 0, candidates: [] };
  let records = root?.['srw:records']?.['srw:record'];
  if (!Array.isArray(records)) records = records ? [records] : [];
  const candidates = records.map((rec: any) => {
    const record = rec?.['srw:recordData']?.['record'];
    if (!record) return null;
    let ppn = '';
    let controlfields = record['controlfield'];
    if (!Array.isArray(controlfields)) controlfields = controlfields ? [controlfields] : [];
    for (const cf of controlfields) {
      if (cf['@_tag'] === '001') {
        ppn = cf['#text'] || cf || '';
        break;
      }
    }
    const parsedRecord = parseSudocRecord(record);
    // Le SRU renvoie parfois le PPN amputé de son zéro initial.
    return { ppn: padPpn(ppn), ...parsedRecord };
  }).filter(Boolean);
  return { count, candidates };
}

export function buildSruQuery(notice: any) {
  const titre = notice['Titre'] || '';
  const auteurPP = notice['Auteur principal - Personne physique'] || '';
  const auteurColl = notice['Auteur principal - Collectivité '] || '';
  const annee = notice['Publié le'] || '';
  const motsTitre = titre
    .replace(/[:\-\.,;!?'"()]/g, ' ')
    .split(/\s+/)
    .filter((w: string) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 5)
    .join('+');
  let nomAuteur = '';
  if (auteurPP) {
    nomAuteur = auteurPP.split(/[,\s]+/)[0];
  } else if (auteurColl) {
    nomAuteur = auteurColl.split(/\s+/).filter((w: string) => w.length > 2).slice(0, 2).join('+');
  }
  return { motsTitre, nomAuteur, annee };
}

export async function searchSru(motsTitre: string, nomAuteur: string, annee: string) {
  const baseUrl = 'https://www.sudoc.abes.fr/cbs/sru/?operation=searchRetrieve&version=1.1&recordSchema=unimarc&maximumRecords=10&query=';
  let query = `mti%3D${motsTitre}`;
  if (nomAuteur) query += `+aut%3D${nomAuteur}`;
  if (annee) query += `+apu%3D${annee}`;
  let response = await axios.get(baseUrl + query, { timeout: 15000 });
  let results = parseSruResponse(response.data);
  if (results.count > 0) return results;
  query = `mti%3D${motsTitre}`;
  if (annee) query += `+apu%3D${annee}`;
  response = await axios.get(baseUrl + query, { timeout: 15000 });
  results = parseSruResponse(response.data);
  if (results.count > 0) return results;
  query = `mti%3D${motsTitre}`;
  response = await axios.get(baseUrl + query, { timeout: 15000 });
  return parseSruResponse(response.data);
}

// --- Récupération d'une notice Sudoc par PPN (gère les PPN fusionnés) ---
export async function fetchSudocRecord(ppnBrut: string): Promise<string | null> {
  const ppn = padPpn(ppnBrut); // 8 caractères -> 9, sinon 404 garanti
  if (!ppn) return null;
  try {
    const response = await axios.get(`${SUDOC_BASE_URL}/${ppn}.xml`, { timeout: 15000 });
    return response.data;
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      try {
        const mergedResponse = await axios.get(`${SUDOC_BASE_URL}/services/merged/${ppn}`, { timeout: 15000 });
        const mergedXml = mergedResponse.data;
        const parser = new XMLParser(SUDOC_PARSER_OPTIONS);
        const parsedMerged = parser.parse(mergedXml);
        if (parsedMerged.sudoc && parsedMerged.sudoc.query && parsedMerged.sudoc.query.result && parsedMerged.sudoc.query.result.ppn) {
           const newPpn = parsedMerged.sudoc.query.result.ppn;
           if (padPpn(newPpn) === ppn) return null; // garde-fou anti-boucle
           return await fetchSudocRecord(newPpn);
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }
}

// --- Conversion UNIMARC XML -> texte WINIBW (export .txt) ---
// Zones absentes de l'export WINIBW : techniques, de gestion, ou déjà présentes
// dans la notice Sudoc que l'on vient corriger (000 leader, 008 type de notice).
export const EXCLUDED_TAGS = new Set(['000', '004', '005', '006', '007', '008', '020', '579', '676', '680', '686', '801', '931', '990', '992']);
export const HOLDINGS_TAGS = new Set(['915', '917', '930', '940', '941', '991', '999']);

export function unimarcXmlToText(xmlString: string): string {
  const parser = new XMLParser(SUDOC_PARSER_OPTIONS);
  const parsed = parser.parse(xmlString);
  const record = parsed.record;
  if (!record) return '';
  
  const lines: string[] = [];

  // 1. Le leader (000) et la zone 008 ne sont PAS exportés — décision assumée :
  //    ce fichier sert à corriger dans WINIBW une notice Sudoc qui existe déjà
  //    (elle vient du Sudoc), pas à en créer une de zéro. Ces deux zones y sont
  //    donc déjà, et les recopier n'apporterait que du bruit à coller.
  //    Si le besoin de créer des notices apparaît : retirer '000' et '008' de
  //    EXCLUDED_TAGS et rétablir leur mise en forme (000 $0…, 008 $a…).

  // 2. Controlfields (001, 003, ...) — pas d'indicateurs ni de sous-zones
  let controlfields = record.controlfield;
  if (controlfields) {
    if (!Array.isArray(controlfields)) controlfields = [controlfields];
    for (const cf of controlfields) {
      const tag = cf['@_tag'] || '';
      if (EXCLUDED_TAGS.has(tag)) continue;
      
      const value = (cf['#text'] !== undefined ? String(cf['#text']) : String(cf || '')).trim();
      if (tag && value) lines.push(`${tag} ${value}`);
    }
  }
  
  // 3. Datafields (toutes les autres zones avec indicateurs et subfields)
  let datafields = record.datafield;
  if (datafields) {
    if (!Array.isArray(datafields)) datafields = [datafields];
    for (const df of datafields) {
      const tag = df['@_tag'] || '';
      if (HOLDINGS_TAGS.has(tag) || EXCLUDED_TAGS.has(tag)) continue;  // filtrer les zones d'exemplaires et exclues

      // Indicateurs : WINIBW en attend TOUJOURS deux caractères, '#' tenant lieu
      // d'espace. Attention : le parser XML trime les attributs, donc ind1=" "
      // arrive ici sous la forme d'une chaîne vide — la tester contre ' ' seul
      // laissait passer des lignes malformées du type "010 $a..." au lieu de
      // "010 ##$a...".
      const indicateur = (v: any) => {
        const s = v === undefined || v === null ? '' : String(v);
        return s.trim() === '' ? '#' : s.trim();
      };
      const indStr = indicateur(df['@_ind1']) + indicateur(df['@_ind2']);
      
      // Extraire les subfields
      let subfields = df.subfield;
      if (!subfields) continue;
      if (!Array.isArray(subfields)) subfields = [subfields];
      
      const subfieldParts: string[] = [];
      for (const sf of subfields) {
        const code = sf['@_code'] !== undefined ? String(sf['@_code']) : '';
        const text = sf['#text'] !== undefined ? String(sf['#text']) : (typeof sf === 'string' ? sf : '');
        if (code) {
          subfieldParts.push(`$${code}${text}`);
        }
      }
      
      // Cas spécial : zone 100 — convertir UNIMARC standard → format Sudoc
      if (tag === '100' && subfieldParts.length === 1 && subfieldParts[0].startsWith('$a')) {
        const aValue = subfieldParts[0].substring(2); // valeur après "$a"
        if (aValue.length >= 17) {
          const dateCode = aValue.charAt(8);          // position 8
          const date1 = aValue.substring(9, 13).trim();   // positions 9-12
          const date2 = aValue.substring(13, 17).trim();  // positions 13-16
          
          // Filtrer les valeurs non significatives (espaces, X seuls, etc.)
          const isValid = (d: string) => /^[0-9X]{4}$/i.test(d);
          
          let sudocInd1 = '#';
          const sudocSubfields: string[] = [];
          
          if (isValid(date1)) sudocSubfields.push(`$a${date1}`);
          
          switch (dateCode) {
            case 'a':
              sudocInd1 = '1';
              if (isValid(date2)) sudocSubfields.push(`$b${date2}`);
              break;
            case 'b':
              sudocInd1 = '1';
              if (isValid(date2)) sudocSubfields.push(`$d${date2}-...`);
              break;
            case 'd':
            case 'e':
            case 'j':
              sudocInd1 = '0';
              // pas de 2ème date
              break;
            case 'f':
              sudocInd1 = '1';
              if (isValid(date2)) sudocSubfields.push(`$c${date2}`);
              break;
            case 'g':
              sudocInd1 = '0';
              if (isValid(date2)) sudocSubfields.push(`$b${date2}`);
              break;
            case 'h':
              sudocInd1 = '0';
              if (isValid(date2)) sudocSubfields.push(`$f${date2}`);
              break;
            default:
              sudocInd1 = '#';
          }
          
          if (sudocSubfields.length > 0) {
            lines.push(`100 ${sudocInd1}#${sudocSubfields.join('')}`);
            continue; // passer à la zone suivante, ne pas faire le push standard
          }
        }
      }

      // Cas standard : push habituel
      if (tag) {
        lines.push(`${tag} ${indStr}${subfieldParts.join('')}`);
      }
    }
  }
  
  // Joindre les lignes avec un seul saut de ligne
  return lines.join('\n');
}
