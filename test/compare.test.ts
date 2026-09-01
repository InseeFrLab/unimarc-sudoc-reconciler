/**
 * Tests du module compare.ts : règles de comparaison champ à champ, IdRef,
 * fusion de la collation, proposition de zone 183.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';
import { compareFields, compareNoticeWithSudoc, extractIdrefs, isAuthorField } from '../server/compare.ts';
import { parseSudocXml } from '../server/marc.ts';
import { CHAMP_TYPE_SUPPORT, LIGNE_183_DEFAUT, parseSyracuseNotices } from '../server/syracuse.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const NOTICE_SUDOC = readFileSync(path.join(dir, 'fixtures', 'sudoc-267670346.xml'), 'utf8');
const EXPORT_SYRACUSE = readFileSync(path.join(dir, 'fixtures', 'syracuse-echantillon.xml'), 'utf8');

const statut = (champ: string, syr: any, sud: any) => compareFields(champ, syr, sud).statut;

describe('compareFields — règles par champ (§4.4)', () => {
  it('ISBN : compare les formes numériques', () => {
    assert.equal(statut('ISBN', '9782111380808', '978-2-11-138080-8'), 'IDENTIQUE');
    assert.equal(statut('ISBN', '9782111380808', '978-2-11-138081-5'), 'ERREUR');
  });
  it('EAN : ignore les espaces', () => {
    assert.equal(statut('EAN', '978 2111380808', '9782111380808'), 'IDENTIQUE');
  });
  it('Publié le : ignore le préfixe de copyright', () => {
    assert.equal(statut('Publié le', 'C 2022', '2022'), 'IDENTIQUE');
    assert.equal(statut('Publié le', '2021', '2022'), 'ERREUR');
  });
  it('Titre : tolère ponctuation et espaces', () => {
    assert.equal(statut('Titre', 'Les comptes de la nation : édition 2022', 'Les comptes de la nation édition 2022'), 'IDENTIQUE');
    assert.equal(statut('Titre', 'Les comptes de la nation', 'Les comptes de la nation en 2022'), 'DIFFERENCE_MINEURE');
    assert.equal(statut('Titre', 'Les comptes de la nation', 'Atlas des régions'), 'ERREUR');
  });
  it('Editeur : ignore casse et diacritiques, tolère les variantes proches', () => {
    assert.equal(statut('Editeur', 'INSEE', 'Insee'), 'IDENTIQUE');
    assert.equal(statut('Editeur', 'Editions du Seuil', 'Éditions du Seuil'), 'IDENTIQUE');
    assert.equal(statut('Editeur', 'Insee', 'Gallimard'), 'ERREUR');
  });
  it('champ vide d’un côté : complément ou absence, jamais une erreur', () => {
    assert.equal(statut('Résumé', '', 'Un résumé'), 'MANQUANT_SYRACUSE');
    assert.equal(statut('Résumé', 'Un résumé', ''), 'ABSENT_SUDOC');
    assert.equal(statut('Résumé', '', ''), 'IDENTIQUE');
  });
  it('champ non modifiable : non vérifié', () => {
    assert.equal(statut('Filtre', 'SUDOC', 'autre'), 'NON_VERIFIE');
  });
});

describe('extractIdrefs — l’IdRef comme clé fiable (§4.4)', () => {
  it('repère les identifiants d’autorité à 9 caractères', () => {
    assert.deepEqual(extractIdrefs('Ledoux Pierre 1932-2011 026927438 070'), ['026927438']);
    assert.deepEqual(extractIdrefs('Ledoux, Pierre (1932-2011) 026927438'), ['026927438']);
  });
  it('ne confond pas une plage de dates avec un IdRef', () => {
    assert.deepEqual(extractIdrefs('Ledoux Pierre 1932-2011'), []);
  });
  it('dédoublonne', () => {
    assert.deepEqual(extractIdrefs('026927438 ; 026927438'), ['026927438']);
  });
  it('identifie les champs d’auteur', () => {
    assert.equal(isAuthorField('Auteur principal - Personne physique'), true);
    assert.equal(isAuthorField('Autre auteur principal - Collectivité'), true);
    assert.equal(isAuthorField('Titre'), false);
  });
});

describe('compareFields — auteurs départagés par l’IdRef', () => {
  const sudoc = 'Ledoux Pierre 1932-2011 026927438 070';
  it('même IdRef, graphie différente : différence mineure, pas une erreur', () => {
    assert.equal(statut('Auteur principal - Personne physique', 'Ledoux, Pierre (1932-2011) 026927438', sudoc), 'DIFFERENCE_MINEURE');
  });
  it('même IdRef, même graphie : identique', () => {
    assert.equal(statut('Auteur principal - Personne physique', sudoc, sudoc), 'IDENTIQUE');
  });
  it('IdRef différents : erreur, même si les noms se ressemblent', () => {
    assert.equal(statut('Auteur principal - Personne physique', 'Ledoux Pierre 1932-2011 111111119 070', sudoc), 'ERREUR');
  });
  it('sans IdRef d’un côté : on retombe sur la comparaison de chaînes', () => {
    assert.equal(statut('Auteur principal - Personne physique', 'Ledoux Pierre 1932-2011', sudoc), 'ERREUR');
    assert.equal(statut('Auteur principal - Personne physique', 'Martin Paul', 'Martin Paul'), 'IDENTIQUE');
  });
});

describe('compareNoticeWithSudoc — notice complète', () => {
  const { notices } = parseSyracuseNotices(EXPORT_SYRACUSE);
  const noticeA = notices[0];
  const sudocData = parseSudocXml(NOTICE_SUDOC);
  const { ecarts, nbErreurs, nbComplements, nbMineures } = compareNoticeWithSudoc(noticeA.properties, sudocData);
  const ecart = (champ: string) => ecarts.find((e: any) => e.champ === champ);

  it('ignore les champs non modifiables', () => {
    for (const champ of ['Identifiant', "Identifiant d'origine", 'Filtre', 'Tome', "Nombre d'exemplaires"]) {
      assert.equal(ecart(champ), undefined, champ);
    }
  });
  it('compte les écarts par nature', () => {
    assert.equal(nbErreurs, 0);
    assert.equal(nbComplements, 1);   // Résumé absent de Syracuse
    assert.equal(nbMineures, 1);      // Auteur : même IdRef, graphie différente
  });
  it('propose l’EAN généré depuis l’ISBN', () => {
    assert.equal(ecart('EAN').statut, 'GENERE_AUTO');
    assert.equal(ecart('EAN').valeurSudoc, '9782111380808');
    assert.equal(ecart('EAN').action, 'ACCEPTER');
  });
  it('fusionne les mentions d’illustrations plutôt que d’écraser Syracuse', () => {
    const dm = ecart('Description matérielle');
    assert.equal(dm.statut, 'FUSION');
    assert.equal(dm.valeurSudoc, '1 volume (151 pages) ill., Tableaux 22 cm');
    assert.deepEqual(dm.unimarc, { tag: '215', subfields: { a: '1 volume (151 pages)', c: 'ill., Tableaux', d: '22 cm' } });
  });
  it('propose la zone 183 absente de la notice Sudoc', () => {
    const support = ecart(CHAMP_TYPE_SUPPORT);
    assert.equal(support.statut, 'GENERE_AUTO');
    assert.equal(support.valeurSudoc, LIGNE_183_DEFAUT);
  });
  it('ne propose pas de 183 quand la notice Sudoc en a une', () => {
    const avec183 = { ...sudocData, hasTypeSupport: true };
    const { ecarts: sansProposition } = compareNoticeWithSudoc(noticeA.properties, avec183);
    assert.equal(sansProposition.find((e: any) => e.champ === CHAMP_TYPE_SUPPORT), undefined);
  });
  it('signale le résumé absent de Syracuse comme complément', () => {
    assert.equal(ecart('Résumé').statut, 'MANQUANT_SYRACUSE');
  });
});
