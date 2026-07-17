/**
 * sessions.ts — Stockage en mémoire des traitements en cours.
 *
 * Volontairement PAS de base de données : chaque upload crée une "session"
 * (identifiée par un UUID) qui vit dans cette Map le temps du traitement et de
 * la revue. Les données disparaissent au redémarrage du serveur — c'est le
 * comportement voulu pour un outil "un fichier en entrée, un fichier en sortie".
 */
export interface Session {
  originalXml: string;
  parsedXml: any;
  notices: any[];
  results: any[];
  status: 'UPLOADED' | 'VERIFYING' | 'COMPLETED' | 'ERROR';
  progress: { current: number; total: number; currentPpn?: string };
}

export const sessions = new Map<string, Session>();
