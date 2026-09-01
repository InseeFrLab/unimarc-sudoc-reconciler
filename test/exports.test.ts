/**
 * Tests du module exports.ts : XML Syracuse corrigé, CSV des écarts, texte
 * UNIMARC pour WINIBW. Aucun accès réseau : les sessions de test portent déjà
 * leur XML Sudoc.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildCsvExport, buildTxtExport, buildXmlExport } from '../server/exports.ts';
import { compareNoticeWithSudoc } from '../server/compare.ts';
import { parseSudocXml } from '../server/marc.ts';
import { CHAMP_TYPE_SUPPORT, parseSyracuseNotices } from '../server/syracuse.ts';
import type { Session } from '../server/sessions.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const NOTICE_SUDOC = readFileSync(path.join(dir, 'fixtures', 'sudoc-267670346.xml'), 'utf8');
const EXPORT_SYRACUSE = readFileSync(path.join(dir, 'fixtures', 'syracuse-echantillon.xml'), 'utf8');

/** Session de test : la notice A comparée à sa notice Sudoc. */
function makeSession(): Session {
  const { parsedXml, notices } = parseSyracuseNotices(EXPORT_SYRACUSE);
  const sudocData = parseSudocXml(NOTICE_SUDOC);
  const { ecarts, nbErreurs, nbComplements, nbMineures } = compareNoticeWithSudoc(notices[0].properties, sudocData);
  return {
    originalXml: EXPORT_SYRACUSE,
    parsedXml,
    notices,
    results: [{
      ppn: '267670346', identifiant: 'SYR-001', titre: notices[0].titre, categorie: 'A',
      syracuse: notices[0].syracuse, sudoc: sudocData, sudocXml: NOTICE_SUDOC,
      statutGlobal: 'COMPLEMENT', ecarts, nbErreurs, nbComplements, nbMineures,
    }],
    status: 'COMPLETED',
    progress: { current: 3, total: 3 },
  };
}

const ecartDe = (session: Session, champ: string) =>
  session.results[0].ecarts.find((e: any) => e.champ === champ);

describe('buildXmlExport — XML Syracuse réimportable', () => {
  const session = makeSession();
  const xml = buildXmlExport(session);

  it('émet la déclaration XML et la structure items/item/property', () => {
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.ok(xml.includes('<items>') && xml.includes('</items>'));
    assert.equal((xml.match(/<item type="GESMARC">/g) || []).length, 3);
  });
  it('applique les valeurs acceptées', () => {
    assert.ok(xml.includes('name="EAN" value="9782111380808"'), xml);
    assert.ok(xml.includes('value="1 volume (151 pages) ill., Tableaux 22 cm"'), xml);
  });
  it('laisse intacts les écarts conservés', () => {
    // Le résumé est un complément proposé, action par défaut CONSERVER.
    assert.ok(xml.includes('name="Résumé" value=""'), xml);
  });
  it('préserve rank, referentialType et referentialName', () => {
    assert.ok(xml.includes('rank="5" referentialType="Autorité" referentialName="Personnes"'), xml);
  });
  it('n’écrit JAMAIS un pseudo-champ UNIMARC dans le XML Syracuse', () => {
    assert.equal(xml.includes(CHAMP_TYPE_SUPPORT), false, xml);
    assert.equal(xml.includes('183'), false, xml);
  });
  it('échappe les caractères réservés', () => {
    const s = makeSession();
    ecartDe(s, 'Résumé').action = 'MODIFIER';
    ecartDe(s, 'Résumé').valeurModifiee = 'Comptes & <nation>';
    assert.ok(buildXmlExport(s).includes('value="Comptes &amp; &lt;nation&gt;"'));
  });
});

describe('buildCsvExport — rapport d’écarts', () => {
  const csv = buildCsvExport(makeSession());

  it('commence par un BOM UTF-8 (lisibilité Excel)', () => {
    assert.equal(csv[0], '﻿');
  });
  it('porte l’en-tête attendu, séparateur point-virgule', () => {
    assert.ok(csv.replace(/^\uFEFF/, '').split('\n')[0].startsWith('PPN;Identifiant_Syracuse;Champ;'));
  });
  it('liste les écarts qui méritent une décision', () => {
    assert.ok(csv.includes('Description matérielle'), csv);
    assert.ok(csv.includes('FUSION'), csv);
    assert.ok(csv.includes('MANQUANT_SYRACUSE'), csv);
  });
  it('n’encombre pas le rapport avec les champs identiques', () => {
    assert.equal(csv.includes('IDENTIQUE'), false, csv);
    assert.equal(csv.includes('NON_VERIFIE'), false, csv);
  });
});

describe('buildTxtExport — notation UNIMARC pour WINIBW', () => {
  it('réécrit la zone 215 complète à partir des sous-zones fusionnées', async () => {
    const txt = await buildTxtExport(makeSession());
    assert.ok(txt.includes('215 ##$a1 volume (151 pages)$cill., Tableaux$d22 cm'), txt);
    // et ne laisse pas la collation entière dans $a
    assert.equal(txt.includes('$a1 volume (151 pages) ill., Tableaux 22 cm'), false, txt);
  });
  it('ajoute la zone absente du XML d’origine (EAN accepté → 073)', async () => {
    const txt = await buildTxtExport(makeSession());
    assert.ok(txt.includes('073 ##$a9782111380808'), txt);
  });
  it('ajoute la zone 183 proposée quand elle est acceptée', async () => {
    const txt = await buildTxtExport(makeSession());
    assert.ok(txt.includes('183 ##$P01$anga'), txt);
  });
  it('n’ajoute pas la zone 183 si la documentaliste la refuse', async () => {
    const session = makeSession();
    ecartDe(session, CHAMP_TYPE_SUPPORT).action = 'CONSERVER';
    const txt = await buildTxtExport(session);
    assert.equal(txt.includes('183'), false, txt);
  });
  it('remplace la valeur d’une zone existante sans toucher aux autres', async () => {
    const session = makeSession();
    const titre = ecartDe(session, 'Titre');
    titre.action = 'MODIFIER';
    titre.valeurModifiee = 'Les comptes de la nation, édition 2022';
    const txt = await buildTxtExport(session);
    assert.ok(txt.includes('200 1#$aLes comptes de la nation, édition 2022$eédition 2022'), txt);
  });
  it('sépare les notices par un trait et n’exporte que celles ayant des données Sudoc', async () => {
    const session = makeSession();
    session.results.push({ ...session.results[0], identifiant: 'SYR-002', ppn: '065493583' });
    const txt = await buildTxtExport(session);
    assert.equal(txt.split('----------------------------------------').length, 2);
  });
  it('reste explicite quand il n’y a rien à exporter', async () => {
    const session = makeSession();
    session.results = [{ identifiant: 'SYR-003', ppn: null, ecarts: [], statutGlobal: 'ABSENT_SUDOC' }];
    const txt = await buildTxtExport(session);
    assert.match(txt, /Aucune notice/);
  });
});
