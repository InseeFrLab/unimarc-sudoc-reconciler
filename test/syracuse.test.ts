/**
 * Tests du module syracuse.ts : lecture de l'export XML et catégorisation A/B.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CHAMP_TYPE_SUPPORT, PSEUDO_UNIMARC_FIELDS, SYRACUSE_TO_UNIMARC, UNMODIFIABLE_FIELDS,
  detectCategory, parseSyracuseNotices,
} from '../server/syracuse.ts';

const EXPORT_SYRACUSE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'syracuse-echantillon.xml'),
  'utf8',
);

describe('detectCategory (§2.5)', () => {
  it('classe en A une notice dont le filtre contient SUDOC', () => {
    assert.equal(detectCategory({ Filtre: 'SUDOC', "Identifiant d'origine": '267670346' }), 'A');
    assert.equal(detectCategory({ Filtre: 'INSEESUDOC', "Identifiant d'origine": '123456' }), 'A');
  });
  it('classe en A une notice dont l’identifiant est un PPN complet', () => {
    assert.equal(detectCategory({ Filtre: 'PMB.BIB', "Identifiant d'origine": '267670346' }), 'A');
    assert.equal(detectCategory({ Filtre: '', "Identifiant d'origine": '06549358X' }), 'A');
  });
  it('classe en B une notice PMB', () => {
    assert.equal(detectCategory({ Filtre: 'PMB.BIB', "Identifiant d'origine": '123456' }), 'B');
  });
  it('classe en B un identifiant à 8 chiffres — comportement assumé', () => {
    // Un PPN amputé de son zéro et un identifiant PMB ont la même forme : on ne
    // peut pas trancher ici. La piste du PPN paddé est proposée plus tard comme
    // candidat, à valider par la documentaliste (voir verify.ts).
    assert.equal(detectCategory({ Filtre: 'PMB.BIB', "Identifiant d'origine": '65493583' }), 'B');
  });
});

describe('parseSyracuseNotices', () => {
  const { notices, countCatA, countCatB } = parseSyracuseNotices(EXPORT_SYRACUSE);

  it('extrait toutes les notices et les compte par catégorie', () => {
    assert.equal(notices.length, 3);
    assert.equal(countCatA, 1);
    assert.equal(countCatB, 2);
  });
  it('utilise l’identifiant Syracuse comme clé', () => {
    assert.deepEqual(notices.map((n: any) => n.identifiant), ['SYR-001', 'SYR-002', 'SYR-003']);
  });
  it('conserve les zéros initiaux des identifiants (pas de conversion en nombre)', () => {
    assert.equal(typeof notices[1].ppn, 'string');
    assert.equal(notices[1].ppn, '65493583');
  });
  it('conserve les propriétés brutes avec leurs attributs', () => {
    const auteur = notices[0].properties.find((p: any) => p['@_name'] === 'Auteur principal - Personne physique');
    assert.equal(auteur['@_referentialType'], 'Autorité');
    assert.equal(auteur['@_rank'], '5');
  });
  it('renvoie le type d’item', () => {
    assert.equal(notices[0].itemType, 'GESMARC');
  });
});

describe('tables de correspondance', () => {
  it('exclut de la vérification les champs administratifs (§5.3)', () => {
    for (const champ of ['Identifiant', "Identifiant d'origine", 'Filtre', 'Tome', 'Titre uniforme', 'Nom - Responsabiblité']) {
      assert.ok(UNMODIFIABLE_FIELDS.includes(champ), champ);
    }
  });
  it('déclare le pseudo-champ 183 comme non écrivable dans Syracuse', () => {
    assert.ok(PSEUDO_UNIMARC_FIELDS.has(CHAMP_TYPE_SUPPORT));
    assert.equal(SYRACUSE_TO_UNIMARC[CHAMP_TYPE_SUPPORT], undefined);
  });
});
