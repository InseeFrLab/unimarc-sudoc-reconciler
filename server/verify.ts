/**
 * verify.ts — Vérification d'UNE notice contre le Sudoc.
 *
 * Catégorie A (PPN connu) : on récupère la notice Sudoc et on compare champ
 *   à champ -> statut global OK / MINEURE / COMPLEMENT / ERREUR, ou NON_TROUVE.
 * Catégorie B (identifiant PMB) : on lance une recherche SRU. Le résultat n'est
 *   PAS tranché automatiquement : on renvoie les candidats pour que la
 *   bibliothécaire choisisse le bon PPN (statut EN_ATTENTE_RATTACHEMENT), ou
 *   ABSENT_SUDOC si rien n'est trouvé.
 *
 * La fonction renvoie l'objet "résultat" ; l'orchestration (boucle sur toutes
 * les notices, progression, stockage) reste dans index.ts.
 */
import { detectCategory } from './syracuse.ts';
import {
  buildSruQuery, fetchSudocRecord, looksLikeTruncatedPpn, padPpn, parseSudocXml,
  ppnFromEan, ppnFromIsbn, searchSru,
} from './marc.ts';
import { compareNoticeWithSudoc } from './compare.ts';

/**
 * Secours quand le PPN ne ramène rien : l'ISBN, puis l'EAN. Renvoie le premier
 * couple (PPN, XML) qui répond, ou null. Silencieux par construction : un ISBN
 * inconnu du Sudoc n'est pas une erreur.
 */
async function retrouverParIsbnOuEan(syracuse: any, ppnEcarte: string) {
  const pistes: Array<{ source: string; valeur: string; chercher: (v: string) => Promise<string[]> }> = [
    { source: 'isbn2ppn', valeur: syracuse?.['ISBN'] || '', chercher: ppnFromIsbn },
    { source: 'ean2ppn', valeur: syracuse?.['EAN'] || '', chercher: ppnFromEan },
  ];
  for (const piste of pistes) {
    if (!piste.valeur) continue;
    const candidats = await piste.chercher(piste.valeur);
    for (const candidat of candidats) {
      if (candidat === ppnEcarte) continue; // déjà tenté, inutile de rejouer
      const xml = await fetchSudocRecord(candidat);
      if (xml) return { ppn: candidat, xml, source: piste.source };
    }
  }
  return null;
}

export async function verifyNotice(notice: any) {
  const base = { ppn: notice.ppn, titre: notice.titre, identifiant: notice.identifiant };
  try {
    const categorie = detectCategory(notice.syracuse);

    if (categorie === 'A') {
      const ppnInitial = padPpn(notice.ppn);
      let ppnUtilise = ppnInitial;
      let sudocXml = await fetchSudocRecord(ppnInitial);
      let ppnSourceSecours: string | undefined;

      if (!sudocXml) {
        const secours = await retrouverParIsbnOuEan(notice.syracuse, ppnInitial);
        if (secours) {
          sudocXml = secours.xml;
          ppnUtilise = secours.ppn;
          ppnSourceSecours = secours.source;
        }
      }

      if (!sudocXml) {
        return { ...base, ppn: ppnInitial, categorie: 'A', statutGlobal: 'NON_TROUVE', ecarts: [] };
      }
      const sudocData = parseSudocXml(sudocXml);
      const { ecarts, nbErreurs, nbComplements, nbMineures } =
        compareNoticeWithSudoc(notice.properties, sudocData);
      let statutGlobal = 'OK';
      if (nbErreurs > 0) statutGlobal = 'ERREUR';
      else if (nbComplements > 0) statutGlobal = 'COMPLEMENT';
      else if (nbMineures > 0) statutGlobal = 'MINEURE';
      return {
        ...base, ppn: ppnUtilise, categorie: 'A', syracuse: notice.syracuse, sudoc: sudocData, sudocXml,
        statutGlobal, nbErreurs, nbComplements, nbMineures, ecarts,
        // Renseignés seulement si le PPN d'origine était muet : la documentaliste
        // doit voir que le rattachement vient de l'ISBN/EAN, pas du PPN Syracuse.
        ...(ppnSourceSecours ? { ppnSourceSecours, ppnOrigine: ppnInitial } : {}),
      };
    }

    // Catégorie B : recherche SRU
    const { motsTitre, nomAuteur, annee } = buildSruQuery(notice.syracuse);
    if (!motsTitre) {
      return { ...base, categorie: 'B', syracuse: notice.syracuse, statutGlobal: 'ABSENT_SUDOC', ecarts: [] };
    }
    const sruResults = await searchSru(motsTitre, nomAuteur, annee);
    if (sruResults.count === 0) {
      return { ...base, categorie: 'B', syracuse: notice.syracuse, statutGlobal: 'ABSENT_SUDOC', ecarts: [] };
    }
    return {
      ...base, categorie: 'B', syracuse: notice.syracuse,
      statutGlobal: 'EN_ATTENTE_RATTACHEMENT',
      candidates: sruResults.candidates, sruCandidates: sruResults.candidates, ecarts: [],
    };
  } catch (err: any) {
    return {
      ...base, categorie: detectCategory(notice.syracuse), syracuse: notice.syracuse,
      statutGlobal: 'ERREUR', nbErreurs: 1, nbComplements: 0, nbMineures: 0,
      ecarts: [{ champ: 'Erreur Interne', valeurSyracuse: '', valeurSudoc: err.message || 'Erreur', statut: 'ERREUR', action: 'CONSERVER' }],
    };
  }
}
