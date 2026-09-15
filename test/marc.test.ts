/**
 * Tests du module marc.ts : PPN, services isbn2ppn/ean2ppn, normalisation de la
 * collation, fusion des illustrations, parsing UNIMARC et export WINIBW.
 *
 * Aucun accès réseau : tout part de notices figées dans test/fixtures/.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildFusedCollation, buildSruQuery, extractIllustrationMentions, generateEanFromIsbn,
  isPpn, looksLikeTruncatedPpn, normalizeDescription, padPpn, parsePpn2Response,
  parseSudocRecord, parseSudocXml, unimarcXmlToText,
} from '../server/marc.ts';

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

const NOTICE_SUDOC = fixture('sudoc-267670346.xml');

describe('padPpn — un PPN fait toujours 9 caractères', () => {
  it('ajoute le zéro initial perdu sur 8 caractères', () => {
    assert.equal(padPpn('65493583'), '065493583');
  });
  it('laisse intact un PPN déjà complet', () => {
    assert.equal(padPpn('267670346'), '267670346');
    assert.equal(padPpn('06549358X'), '06549358X');
  });
  it('gère le caractère de contrôle X sur 8 caractères', () => {
    assert.equal(padPpn('6549358x'), '06549358X');
  });
  it('accepte un nombre (cas du PPN stocké comme entier)', () => {
    assert.equal(padPpn(65493583), '065493583');
  });
  it('ne touche pas à ce qui n’est pas un PPN tronqué', () => {
    assert.equal(padPpn('123456'), '123456');
    assert.equal(padPpn(''), '');
    assert.equal(padPpn(null), '');
    assert.equal(padPpn(undefined), '');
  });
  it('reconnaît la forme d’un PPN', () => {
    assert.equal(isPpn('65493583'), true);       // paddé puis validé
    assert.equal(isPpn('123456'), false);
    assert.equal(looksLikeTruncatedPpn('65493583'), true);
    assert.equal(looksLikeTruncatedPpn('267670346'), false);
    assert.equal(looksLikeTruncatedPpn('123456'), false);
  });
});

describe('parsePpn2Response — services isbn2ppn / ean2ppn', () => {
  it('extrait un PPN unique', () => {
    const xml = '<sudoc><query><isbn>2111380808</isbn><result><ppn>013955896</ppn></result></query></sudoc>';
    assert.deepEqual(parsePpn2Response(xml), ['013955896']);
  });
  it('extrait plusieurs PPN et les dédoublonne', () => {
    const xml = `<sudoc><query><result><ppn>013955896</ppn><ppn>267670346</ppn><ppn>013955896</ppn></result></query></sudoc>`;
    assert.deepEqual(parsePpn2Response(xml), ['013955896', '267670346']);
  });
  it('padde un PPN renvoyé tronqué', () => {
    const xml = '<sudoc><query><result><ppn>65493583</ppn></result></query></sudoc>';
    assert.deepEqual(parsePpn2Response(xml), ['065493583']);
  });
  it('renvoie une liste vide sur une réponse d’erreur', () => {
    assert.deepEqual(parsePpn2Response('<sudoc><error>Not found</error></sudoc>'), []);
  });
  it('ne jette jamais sur une réponse inattendue', () => {
    assert.deepEqual(parsePpn2Response('pas du xml'), []);
    assert.deepEqual(parsePpn2Response(''), []);
  });
});

describe('normalizeDescription — collation Syracuse (§4bis.4)', () => {
  it('développe les abréviations et parenthèse la pagination', () => {
    assert.equal(normalizeDescription('1 vol. (151 p.) Tableaux 22 cm'), '1 volume (151 pages) Tableaux 22 cm');
    assert.equal(normalizeDescription('220 pages 24 cm'), '1 volume (220 pages) 24 cm');
    assert.equal(normalizeDescription('1 volume 220 pages 24 cm'), '1 volume (220 pages) 24 cm');
  });
  it('laisse une chaîne vide tranquille', () => {
    assert.equal(normalizeDescription(''), '');
  });
});

describe('generateEanFromIsbn (§4bis.2)', () => {
  it('génère un EAN à 13 chiffres depuis un ISBN-13', () => {
    assert.equal(generateEanFromIsbn('978-2-3260-0345-3'), '9782326003453');
  });
  it('refuse un ISBN-10 (pas 13 chiffres)', () => {
    assert.equal(generateEanFromIsbn('2-11-138080-8'), '');
  });
});

describe('extractIllustrationMentions (§4bis.5)', () => {
  it('repère une mention noyée dans la collation', () => {
    assert.deepEqual(extractIllustrationMentions('1 vol. (151 p.) Tableaux 22 cm'), ['Tableaux']);
  });
  it('préfère la mention longue à la courte qu’elle contient', () => {
    assert.deepEqual(extractIllustrationMentions('1 vol. couv. ill. 22 cm'), ['couv. ill.']);
  });
  it('ne trouve rien quand il n’y a rien', () => {
    assert.deepEqual(extractIllustrationMentions('1 vol. (151 p.) 22 cm'), []);
    assert.deepEqual(extractIllustrationMentions(''), []);
  });
});

describe('buildFusedCollation — fusion Sudoc + Syracuse (§4bis.5)', () => {
  const collation = { a: '1 vol. (151 p.)', c: 'ill.', d: '22 cm' };
  it('ajoute la mention que seule Syracuse porte, Sudoc en premier', () => {
    const fusion = buildFusedCollation(collation, '1 vol. (151 p.) Tableaux 22 cm');
    assert.ok(fusion);
    assert.deepEqual(fusion.added, ['Tableaux']);
    assert.equal(fusion.value, '1 volume (151 pages) ill., Tableaux 22 cm');
  });
  it('ne propose rien quand Syracuse n’apporte aucune mention', () => {
    assert.equal(buildFusedCollation(collation, '1 vol. (151 p.) ill. 22 cm'), null);
    assert.equal(buildFusedCollation(collation, '1 vol. (151 p.) 22 cm'), null);
  });
  it('ne propose rien sans collation Sudoc', () => {
    assert.equal(buildFusedCollation(null, '1 vol. Tableaux'), null);
  });
});

describe('parseSudocRecord — lecture d’une notice UNIMARC', () => {
  const data = parseSudocXml(NOTICE_SUDOC)!;
  it('concatène 200 $a et $e pour le titre', () => {
    assert.equal(data.titre, 'Les comptes de la nation édition 2022');
  });
  it('lit ISBN, prix et développe la reliure', () => {
    assert.equal(data.isbn, '978-2-11-138080-8');
    assert.equal(data.prix, '22 EUR');
    assert.equal(data.reliure, 'broché');
  });
  it('génère l’EAN depuis l’ISBN et le signale', () => {
    assert.equal(data.ean, '9782111380808');
    assert.equal(data.eanGenerated, true);
  });
  it('normalise la collation et conserve les sous-zones', () => {
    assert.equal(data.descriptionMaterielle, '1 volume (151 pages) ill. 22 cm');
    assert.deepEqual(data.collation215, { a: '1 vol. (151 p.)', c: 'ill.', d: '22 cm' });
  });
  it('signale l’absence de zone 183', () => {
    assert.equal(data.hasTypeSupport, false);
  });
  it('concatène l’auteur avec son IdRef', () => {
    assert.equal(data.auteurPrincipal, 'Ledoux Pierre 1932-2011 026927438 070');
  });
  it('suffixe les vedettes RAMEAU', () => {
    assert.equal(data.vedetteNomCommun, 'Comptabilité nationale France rameau');
  });
  it('renvoie null sans notice', () => {
    assert.equal(parseSudocRecord(null), null);
  });
});

describe('unimarcXmlToText — export WINIBW', () => {
  const texte = unimarcXmlToText(NOTICE_SUDOC);
  const lignes = texte.split('\n');

  it('convertit la zone 100 du format UNIMARC standard vers le format Sudoc', () => {
    assert.ok(lignes.includes('100 0#$a2022$f2022'), texte);
  });
  it('met en forme les zones avec indicateurs et sous-zones collées', () => {
    assert.ok(lignes.includes('200 1#$aLes comptes de la nation$eédition 2022'), texte);
    assert.ok(lignes.includes('010 ##$a978-2-11-138080-8$bbr.$d22 EUR'), texte);
    assert.ok(lignes.includes('214 #0$cInsee$d2022'), texte);
  });
  it('rend TOUJOURS deux caractères d’indicateur (# pour un espace)', () => {
    // Régression : le parser XML trime les attributs, ind1=" " arrivait vide et
    // la ligne sortait sans indicateurs — illisible pour WINIBW.
    for (const ligne of lignes) {
      if (/^00\d /.test(ligne)) continue; // controlfields : pas d'indicateurs
      assert.match(ligne, /^\d{3} [\d#]{2}\$/, `indicateurs manquants : ${ligne}`);
    }
  });
  it('conserve les zéros initiaux des IdRef (pas de conversion en nombre)', () => {
    assert.ok(lignes.includes('700 #1$aLedoux$bPierre$f1932-2011$3026927438$4070'), texte);
  });
  it('exporte les controlfields sans sous-zone', () => {
    assert.ok(lignes.includes('001 267670346'), texte);
    assert.ok(lignes.includes('003 http://www.sudoc.fr/267670346'), texte);
  });
  it('filtre les zones d’exemplaires (915)', () => {
    assert.equal(lignes.some((l) => l.startsWith('915')), false, texte);
  });
  it('n’exporte ni le leader (000) ni la zone 008 — décision assumée', () => {
    assert.equal(lignes.some((l) => l.startsWith('000')), false, texte);
    assert.equal(lignes.some((l) => l.startsWith('008')), false, texte);
    assert.equal(lignes.some((l) => l.startsWith('005')), false, texte);
  });
  it('renvoie une chaîne vide sans notice', () => {
    assert.equal(unimarcXmlToText('<autre/>'), '');
  });
});

describe('buildSruQuery — critères de recherche par contenu (§3.3.2)', () => {
  it('retient les mots significatifs, le nom de l’auteur et l’année', () => {
    const q = buildSruQuery({
      'Titre': 'La comptabilité des entreprises en France',
      'Auteur principal - Personne physique': 'Martin, Paul',
      'Publié le': '1965',
    });
    assert.equal(q.motsTitre, 'comptabilité+entreprises+France');
    assert.equal(q.nomAuteur, 'Martin');
    assert.equal(q.annee, '1965');
  });
  it('extrait 4 chiffres d’une année préfixée « C » (copyright)', () => {
    const q = buildSruQuery({ 'Titre': 'Les comptes de la nation', 'Publié le': 'C 2022' });
    assert.equal(q.annee, '2022');
  });
  it('ne plafonne pas au-delà de 5 mots de titre', () => {
    const q = buildSruQuery({ 'Titre': 'alpha beta gamma delta epsilon zeta eta theta' });
    assert.equal(q.motsTitre.split('+').length, 5);
  });
  // Le libellé porte un espace final dans le XML, que fast-xml-parser trime :
  // la notice qui parvient ici est donc indexée sans cet espace.
  it('retombe sur l’auteur collectivité quand la personne physique manque', () => {
    const q = buildSruQuery({
      'Titre': 'Annuaire statistique du Brésil',
      'Auteur principal - Personne physique': '',
      'Auteur principal - Collectivité': 'Instituto brasileiro de geografia e estatística',
    });
    assert.equal(q.nomAuteur, 'Instituto+brasileiro');
  });
});
