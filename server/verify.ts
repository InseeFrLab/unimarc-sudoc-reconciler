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
import { fetchSudocRecord, parseSudocXml, buildSruQuery, searchSru } from './marc.ts';
import { compareNoticeWithSudoc } from './compare.ts';

export async function verifyNotice(notice: any) {
  const base = { ppn: notice.ppn, titre: notice.titre, identifiant: notice.identifiant };
  try {
    const categorie = detectCategory(notice.syracuse);

    if (categorie === 'A') {
      const sudocXml = await fetchSudocRecord(notice.ppn);
      if (!sudocXml) {
        return { ...base, categorie: 'A', statutGlobal: 'NON_TROUVE', ecarts: [] };
      }
      const sudocData = parseSudocXml(sudocXml);
      const { ecarts, nbErreurs, nbComplements, nbMineures } =
        compareNoticeWithSudoc(notice.properties, sudocData);
      let statutGlobal = 'OK';
      if (nbErreurs > 0) statutGlobal = 'ERREUR';
      else if (nbComplements > 0) statutGlobal = 'COMPLEMENT';
      else if (nbMineures > 0) statutGlobal = 'MINEURE';
      return {
        ...base, categorie: 'A', syracuse: notice.syracuse, sudoc: sudocData, sudocXml,
        statutGlobal, nbErreurs, nbComplements, nbMineures, ecarts,
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
