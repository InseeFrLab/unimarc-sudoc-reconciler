/**
 * version.ts — Identité de la version en cours d'exécution.
 *
 * Sert à répondre à une question d'exploitation : « le site déployé
 * correspond-il bien au dernier code commité ? ». Recouper le tag de l'image
 * et l'empreinte du conteneur est indirect ; ici c'est l'application
 * elle-même qui déclare sur quel commit elle a été construite, ce qui ne
 * peut pas mentir.
 *
 * `GIT_SHA` est injecté à la construction de l'image (Dockerfile + workflow
 * GitHub Actions). Hors conteneur — en développement — la variable est
 * absente : on retombe alors sur le commit du dépôt local, et à défaut sur
 * « inconnu ».
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

export interface VersionInfo {
  /** Version déclarée dans package.json (ex. « 1.4.0 »). */
  version: string;
  /** SHA complet du commit dont ce code est issu, ou « inconnu ». */
  commit: string;
  /** Provenance du SHA : utile pour savoir si l'on lit une image ou un dépôt. */
  source: 'image' | 'dépôt local' | 'inconnu';
  /** Date de démarrage du processus, en ISO 8601. */
  demarrage: string;
}

const demarrage = new Date().toISOString();

function lireVersionPackage(): string {
  try {
    const brut = readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
    return JSON.parse(brut).version ?? 'inconnue';
  } catch {
    return 'inconnue';
  }
}

function lireCommitLocal(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Construit la réponse de `GET /api/version`. */
export function getVersionInfo(): VersionInfo {
  // Le Dockerfile écrit GIT_SHA ; sa valeur par défaut est vide, d'où le test
  // sur la chaîne non vide et pas seulement sur la présence de la variable.
  const injecte = process.env.GIT_SHA?.trim();
  if (injecte) return { version: lireVersionPackage(), commit: injecte, source: 'image', demarrage };

  const local = lireCommitLocal();
  if (local) return { version: lireVersionPackage(), commit: local, source: 'dépôt local', demarrage };

  return { version: lireVersionPackage(), commit: 'inconnu', source: 'inconnu', demarrage };
}
