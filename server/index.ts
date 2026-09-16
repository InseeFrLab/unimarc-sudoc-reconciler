/**
 * index.ts — Serveur HTTP (Express) : point d'entrée de l'application.
 *
 * Ce fichier ne contient QUE la couche web (routes + démarrage). Toute la
 * logique métier vit dans les modules voisins (marc, syracuse, compare,
 * verify, exports, llm). En développement, Vite est monté en middleware ; en
 * production, on sert les fichiers statiques compilés dans /dist.
 */
import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import multer from 'multer';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

import { sessions } from './sessions.ts';
import { parseSyracuseNotices, detectCategory, SYRACUSE_MAPPING } from './syracuse.ts';
import { fetchSudocRecord, padPpn, parseSudocXml, searchSru, delay } from './marc.ts';
import { compareNoticeWithSudoc } from './compare.ts';
import { verifyNotice } from './verify.ts';
import { buildXmlExport, buildCsvExport, buildTxtExport } from './exports.ts';
import { getModelsUrl } from './llm.ts';
import { getVersionInfo } from './version.ts';

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const apiErrorHandler = (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Error:', err);
  res.status(500).json({ error: err.message || 'Erreur serveur interne' });
};

// ─────────────────────────────────────────────────────────────
// 0) Version en cours d'exécution — permet de vérifier depuis
//    l'extérieur que le site déployé correspond bien au dernier
//    code commité (voir scripts/verifier-deploiement.sh).
// ─────────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => res.json(getVersionInfo()));

// ─────────────────────────────────────────────────────────────
// 1) Upload d'un export XML Syracuse -> création d'une session
// ─────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    const xmlString = req.file.buffer.toString('utf-8');
    const { parsedXml, notices, countCatA, countCatB } = parseSyracuseNotices(xmlString);
    if (notices.length === 0) return res.status(400).json({ error: 'Aucune notice valide trouvée.' });

    const sessionId = randomUUID();
    sessions.set(sessionId, {
      originalXml: xmlString, parsedXml, notices, results: [],
      status: 'UPLOADED', progress: { current: 0, total: notices.length },
    });
    res.json({
      sessionId, totalNotices: notices.length, countCatA, countCatB,
      notices: notices.map((n: any) => ({ ppn: n.ppn, titre: n.titre, identifiant: n.identifiant, categorie: n.categorie })),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// 2) Lancement de la vérification (traitement en tâche de fond)
// ─────────────────────────────────────────────────────────────
app.post('/api/verify/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'VERIFYING') return res.status(400).json({ error: 'Verification already in progress' });
  session.status = 'VERIFYING';
  session.results = [];
  res.json({ message: 'Verification started' });

  (async () => {
    try {
      for (let i = 0; i < session.notices.length; i++) {
        const notice = session.notices[i];
        session.progress.current = i + 1;
        session.progress.currentPpn = notice.ppn || notice.identifiant;
        const result = await verifyNotice(notice);
        session.results.push(result);
        await delay(500); // politesse envers les serveurs de l'ABES
      }
      session.status = 'COMPLETED';
    } catch (globalErr) {
      console.error('Global verification error:', globalErr);
      session.status = 'ERROR';
    }
  })();
});

// ─── Suivi de progression (polling), résultats, résumé, accès Sudoc/SRU ───
// Le front interroge ce point d'accès toutes les secondes pendant la
// vérification. Un simple JSON (et non un flux SSE) : c'est robuste derrière
// n'importe quel proxy, qui sinon met le flux en tampon et fige la barre.
app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: session.status, progress: session.progress });
});

app.get('/api/results/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ results: session.results });
});

app.get('/api/results/:sessionId/summary', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const summary = {
    total: session.results.length,
    ok: session.results.filter(r => r.statutGlobal === 'OK' || r.statutGlobal === 'RATTACHE_SRU' || r.statutGlobal === 'VALIDE').length,
    erreurs: session.results.filter(r => r.statutGlobal === 'ERREUR').length,
    complements: session.results.filter(r => r.statutGlobal === 'COMPLEMENT').length,
    nonTrouve: session.results.filter(r => r.statutGlobal === 'NON_TROUVE').length,
    mineures: session.results.filter(r => r.statutGlobal === 'MINEURE').length,
    enAttente: session.results.filter(r => r.statutGlobal === 'EN_ATTENTE_RATTACHEMENT').length,
    absent: session.results.filter(r => r.statutGlobal === 'ABSENT_SUDOC').length,
    fieldsStats: {} as Record<string, number>
  };
  session.results.forEach(r => {
    r.ecarts?.forEach((e: any) => {
      if (e.statut === 'ERREUR' || e.statut === 'MANQUANT_SYRACUSE' || e.statut === 'DIFFERENCE_MINEURE') {
        summary.fieldsStats[e.champ] = (summary.fieldsStats[e.champ] || 0) + 1;
      }
    });
  });
  res.json(summary);
});

app.get('/api/sudoc/:ppn', async (req, res) => {
  try {
    const xml = await fetchSudocRecord(req.params.ppn);
    if (!xml) return res.status(404).json({ error: 'Non trouvé' });
    const data = parseSudocXml(xml);
    res.json({ success: true, candidate: { ppn: req.params.ppn, ...data } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sru/search', async (req, res) => {
  try {
    const title = req.query.title as string;
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    const result = await searchSru(title, '', '');
    res.json({ success: true, candidates: result.candidates });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/results/:sessionId/:identifiant/valider', async (req, res) => {
  const { sessionId, identifiant } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const notice = session.results.find(r => r.ppn === identifiant || r.identifiant === identifiant);
  if (!notice) return res.status(404).json({ error: 'Notice not found' });
  if (notice.statutGlobal === 'VALIDE') {
    if (notice.categorie === 'B') notice.statutGlobal = 'RATTACHE_SRU';
    else {
      let statutGlobal = 'OK';
      if (notice.nbErreurs > 0) statutGlobal = 'ERREUR';
      else if (notice.nbComplements > 0) statutGlobal = 'COMPLEMENT';
      else if (notice.nbMineures > 0) statutGlobal = 'DIFFERENCE_MINEURE';
      notice.statutGlobal = statutGlobal;
    }
  } else notice.statutGlobal = 'VALIDE';
  res.json({ success: true });
});

// ─── Rattachement manuel d'un PPN à une notice de catégorie B ───
app.post('/api/results/:sessionId/:identifiant/rattacher', async (req, res) => {
  const { sessionId, identifiant } = req.params;
  const nouveauPpn = padPpn(req.body?.nouveauPpn); // 9 caractères, toujours
  try {
    if (!nouveauPpn) return res.status(400).json({ error: 'PPN manquant' });
    const sudocXml = await fetchSudocRecord(nouveauPpn);
    if (!sudocXml) return res.status(404).json({ error: 'Notice Sudoc non trouvée' });
    const sudocData = parseSudocXml(sudocXml);
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const notice = session.results.find((r) => r.identifiant === identifiant);
    if (!notice) return res.status(404).json({ error: 'Notice not found' });

    notice.ppn = nouveauPpn;
    if (notice.syracuse && typeof notice.syracuse === 'object') notice.syracuse["Identifiant d'origine"] = nouveauPpn;
    notice.sudoc = sudocData;
    notice.sudocXml = sudocXml;
    notice.statutGlobal = 'RATTACHE_SRU';

    // Répercuter le nouveau PPN dans session.notices (source de l'export XML)
    const origNotice = session.notices.find((n) => n.identifiant === identifiant);
    if (origNotice) {
      origNotice.ppn = nouveauPpn;
      if (origNotice.syracuse) origNotice.syracuse["Identifiant d'origine"] = nouveauPpn;
      if (Array.isArray(origNotice.properties)) {
        const origProp = origNotice.properties.find((p: any) => p['@_name'] === "Identifiant d'origine");
        if (origProp) origProp['@_value'] = nouveauPpn;
      }
    }

    const { ecarts, nbErreurs, nbComplements, nbMineures } =
      compareNoticeWithSudoc(origNotice?.properties || [], sudocData);
    notice.ecarts = ecarts;
    notice.nbErreurs = nbErreurs;
    notice.nbComplements = nbComplements;
    notice.nbMineures = nbMineures;
    res.json({ success: true, ppn: nouveauPpn, ecarts: notice.ecarts, notice });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Marquer absent, action sur un écart, actions groupées ───
app.post('/api/results/:sessionId/:identifiant/absent', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const notice = session.results.find(r => r.identifiant === req.params.identifiant);
  if (!notice) return res.status(404).json({ error: 'Notice not found' });
  notice.statutGlobal = 'ABSENT_SUDOC';
  notice.ecarts = [];
  res.json({ success: true, notice });
});

app.put('/api/results/:sessionId/:identifiant/action', (req, res) => {
  const { sessionId, identifiant } = req.params;
  const { champ, action, valeurModifiee } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const result = session.results.find(r => r.identifiant === identifiant);
  if (!result) return res.status(404).json({ error: 'Result not found' });
  if (!result.ecarts) result.ecarts = [];
  let ecart = result.ecarts.find((e: any) => e.champ === champ);
  if (!ecart) {
    let sudocVal = '';
    if (result.sudoc) {
      const sudocKey = SYRACUSE_MAPPING[champ];
      if (sudocKey && result.sudoc[sudocKey]) sudocVal = String(result.sudoc[sudocKey]);
    }
    ecart = { champ, valeurSyracuse: '', valeurSudoc: sudocVal, statut: 'MODIFIE', action };
    result.ecarts.push(ecart);
  }
  ecart.action = action;
  if (action === 'MODIFIER') ecart.valeurModifiee = valeurModifiee;
  res.json({ success: true, ecart });
});

app.post('/api/results/:sessionId/bulk-action', (req, res) => {
  const { sessionId } = req.params;
  const { action, ppn } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const applyToEcart = (e: any) => {
    if (action === 'ACCEPTER_ERREURS' && e.statut === 'ERREUR') e.action = 'ACCEPTER';
    if (action === 'ACCEPTER_COMPLEMENTS' && e.statut === 'MANQUANT_SYRACUSE') e.action = 'ACCEPTER';
    if (action === 'TOUT_ACCEPTER' && ['ERREUR', 'MANQUANT_SYRACUSE', 'DIFFERENCE_MINEURE'].includes(e.statut)) e.action = 'ACCEPTER';
    if (action === 'TOUT_REJETER') e.action = 'CONSERVER';
  };
  if (ppn) {
    const result = session.results.find(r => r.identifiant === ppn);
    if (result) {
      if (result.categorie === 'B' && action === 'TOUT_ACCEPTER' && result.sudoc) {
        for (const [k, v] of Object.entries(result.sudoc)) {
          if (['ppn', 'recordData', 'raw', 'hasTypeSupport', 'eanGenerated', 'collation215'].includes(k)) continue;
          const sv = String(v ?? '').trim();
          if (!sv) continue;
          // Trouver le nom Syracuse correspondant
          let champName = '';
          for (const [sn, sk] of Object.entries(SYRACUSE_MAPPING)) {
            if (sk === k) { champName = sn; break; }
          }
          if (!champName) continue;
          let ecart = result.ecarts.find((e: any) => e.champ === champName);
          if (!ecart) {
            ecart = { champ: champName, valeurSyracuse: '', valeurSudoc: sv, statut: 'MODIFIE', action: 'ACCEPTER' };
            result.ecarts.push(ecart);
          } else ecart.action = 'ACCEPTER';
        }
        result.ecarts.forEach((e: any) => e.action = 'ACCEPTER');
      } else result.ecarts.forEach(applyToEcart);
    }
  } else session.results.forEach(r => r.ecarts?.forEach(applyToEcart));
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// 3) Exports (XML corrigé, CSV rapport d'écarts, TXT UNIMARC)
// ─────────────────────────────────────────────────────────────
app.get('/api/export/:sessionId/xml', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const xml = buildXmlExport(session);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Disposition', `attachment; filename="export_corrige_${req.params.sessionId.substring(0, 8)}.xml"`);
  res.send(xml);
});

app.get('/api/export/:sessionId/csv', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Disposition', 'attachment; filename="rapport_ecarts.csv"');
  res.send(buildCsvExport(session));
});

app.get('/api/export/:sessionId/txt', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const txt = await buildTxtExport(session);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Disposition', `attachment; filename="export_unimarc_${req.params.sessionId.substring(0, 8)}.txt"`);
  res.send(txt);
});

// ─────────────────────────────────────────────────────────────
// 4) LLM : suggestions de vedettes RAMEAU (fonction facultative)
// ─────────────────────────────────────────────────────────────
app.post('/api/llm/models', async (req, res) => {
  const { endpoint, apiKey } = req.body;
  if (!endpoint || !apiKey) return res.status(400).json({ error: 'Endpoint et clé requis' });
  try {
    const modelsUrl = getModelsUrl(endpoint);
    const response = await axios.get(modelsUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 15000
    });
    let models: any[] = [];
    if (response.data.data && Array.isArray(response.data.data)) {
      models = response.data.data.map((m: any) => ({ id: m.id, name: m.name || m.id, owned_by: m.owned_by || '' }));
    } else if (Array.isArray(response.data)) {
      models = response.data.map((m: any) => ({ id: m.id || m.name || String(m), name: m.name || m.id || String(m), owned_by: m.owned_by || '' }));
    } else if (response.data.models && Array.isArray(response.data.models)) {
      models = response.data.models.map((m: any) => ({ id: m.name || m.model, name: m.name || m.model, owned_by: '' }));
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ models, count: models.length });
  } catch (error: any) {
    console.error('Error fetching models:', error.message);
    res.status(500).json({
      error: 'Impossible de charger les modèles',
      details: error.response?.data?.error?.message || error.response?.data?.detail || error.message,
      status: error.response?.status
    });
  }
});

app.post('/api/llm/test', async (req, res) => {
  const { endpoint, apiKey, model } = req.body;
  if (!endpoint || !apiKey || !model) return res.status(400).json({ error: 'Endpoint, clé et modèle requis' });
  const startTime = Date.now();
  try {
    const response = await axios.post(endpoint, {
      model, messages: [{ role: 'user', content: 'Réponds "OK".' }], max_tokens: 10, temperature: 0
    }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    const elapsed = Date.now() - startTime;
    const content = response.data.choices?.[0]?.message?.content || '';
    res.json({ success: true, message: `Connexion OK — ${elapsed}ms`, model, response: content.trim(), elapsed });
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    res.json({
      success: false,
      message: error.response?.data?.error?.message || error.response?.data?.detail || error.message,
      status: error.response?.status, elapsed
    });
  }
});

app.post('/api/suggest-keywords/:sessionId/:ppn', async (req, res) => {
  const { endpoint, apiKey, model } = req.body;
  const { sessionId, ppn } = req.params;
  if (!endpoint || !apiKey || !model) return res.status(400).json({ error: 'Configuration LLM requise' });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session non trouvée' });
  
  // Chercher par identifiant Syracuse OU par ppn
  const notice = session.results.find(r => r.identifiant === ppn || r.ppn === ppn);
  if (!notice) return res.status(404).json({ error: 'Notice non trouvée' });
  
  const getVal = (champ: string): string => {
    const e = notice.ecarts?.find((ec: any) => ec.champ === champ);
    if (e) {
      const val = e.action === 'ACCEPTER' ? e.valeurSudoc 
                : (e.action === 'MODIFIER' ? e.valeurModifiee : e.valeurSyracuse);
      if (val) return String(val);
    }
    const sudocKey = SYRACUSE_MAPPING[champ];
    if (notice.sudoc && sudocKey && notice.sudoc[sudocKey]) return String(notice.sudoc[sudocKey]);
    if (notice.syracuse && notice.syracuse[champ]) return String(notice.syracuse[champ]);
    return '';
  };

  const titre = getVal('Titre');
  const editeur = getVal('Editeur');
  const collection = getVal('Collection');
  const resume = getVal('Résumé');
  const tdm = getVal('Table des matières');
  const vedettesExistantes = getVal('Vedette matière - Nom commun');
  
  if (!titre && !resume && !tdm) {
    return res.status(200).json({ 
      suggestions: [],
      warning: "Pas assez d'informations pour générer des suggestions."
    });
  }
  
  const systemPrompt = `Tu es un bibliothécaire spécialisé en indexation RAMEAU travaillant pour un centre de documentation en France. Tu proposes des vedettes matières pour indexer des ouvrages. Tu réponds UNIQUEMENT avec la liste des vedettes, une par ligne, sans numérotation, sans tiret en début de ligne, sans explication.`;
  
  const userPrompt = `À partir des informations bibliographiques suivantes, propose entre 3 et 6 vedettes matières au format RAMEAU pour indexer cet ouvrage.

TITRE : ${titre}
ÉDITEUR : ${editeur}
COLLECTION : ${collection}
RÉSUMÉ : ${resume}
TABLE DES MATIÈRES : ${tdm}

VEDETTES DÉJÀ PRÉSENTES : ${vedettesExistantes || '(aucune)'}

CONSIGNES :
- Propose UNIQUEMENT des vedettes PAS déjà présentes
- Vocabulaire contrôlé RAMEAU
- Une vedette par ligne
- Format: "Terme principal Subdivision_sujet Subdivision_géographique Subdivision_chronologique"
- Pas de vedettes génériques ni trop spécifiques
- Réponds UNIQUEMENT avec la liste`;

  try {
    const response = await axios.post(endpoint, {
      model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0, max_tokens: 500
    }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 });
    const content = response.data.choices?.[0]?.message?.content || '';
    const suggestions = content
      .split('\n')
      .map((line: string) => line.trim())
      .map((line: string) => line.replace(/^\d+[\.\)\-\:]\s*/, ''))
      .map((line: string) => line.replace(/^[-*•–—]\s*/, ''))
      .map((line: string) => line.replace(/^["'«»]+|["'«»]+$/g, ''))
      .filter((line: string) => line.length > 2)
      .filter((line: string) => {
        const existingLower = vedettesExistantes.toLowerCase();
        return !existingLower.includes(line.toLowerCase());
      })
      .map((line: string) => ({ text: line, selected: false }));
      
    notice.aiSuggestions = suggestions;
    res.json({ suggestions, model, count: suggestions.length });
  } catch (error: any) {
    console.error('Error generating keywords:', error.message);
    res.status(500).json({
      error: 'Erreur lors de la génération',
      details: error.response?.data?.error?.message || error.response?.data?.detail || error.message
    });
  }
});

app.put('/api/results/:sessionId/:ppn/update-ai-suggestions', (req, res) => {
  const { sessionId, ppn } = req.params;
  const { suggestions } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session non trouvée' });
  const notice = session.results.find(r => r.identifiant === ppn || r.ppn === ppn);
  if (!notice) return res.status(404).json({ error: 'Notice non trouvée' });
  notice.aiSuggestions = suggestions;
  res.json({ success: true });
});

app.put('/api/results/:sessionId/:ppn/add-keyword', (req, res) => {
  const { sessionId, ppn } = req.params;
  const { keyword } = req.body;
  if (!keyword || keyword.trim().length === 0) return res.status(400).json({ error: 'Mot-clé requis' });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session non trouvée' });
  const notice = session.results.find(r => r.identifiant === ppn || r.ppn === ppn);
  if (!notice) return res.status(404).json({ error: 'Notice non trouvée' });
  if (!notice.ecarts) notice.ecarts = [];
  const champVedettes = 'Vedette matière - Nom commun';
  let ecart = notice.ecarts.find((e: any) => e.champ === champVedettes);
  const currentValue = ecart 
    ? (ecart.action === 'ACCEPTER' ? ecart.valeurSudoc : (ecart.action === 'MODIFIER' ? ecart.valeurModifiee : ecart.valeurSyracuse))
    : '';
  const newKeyword = keyword.trim() + ' rameau';
  const newValue = currentValue ? currentValue + '; ' + newKeyword : newKeyword;
  if (!ecart) {
    ecart = { champ: champVedettes, valeurSyracuse: '', valeurSudoc: '', statut: 'MODIFIE', action: 'MODIFIER', valeurModifiee: newValue };
    notice.ecarts.push(ecart);
  } else {
    ecart.action = 'MODIFIER';
    ecart.valeurModifiee = newValue;
  }
  res.json({ success: true, champ: champVedettes, newValue, addedKeyword: newKeyword });
});

app.use('/api', apiErrorHandler);

// ─────────────────────────────────────────────────────────────
// Démarrage : Vite en middleware (dev) ou fichiers statiques (prod)
// ─────────────────────────────────────────────────────────────
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.use((err: any, req: any, res: any, next: any) => {
    console.error('Express Error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });
  app.listen(PORT, '0.0.0.0', () => console.log(`Serveur démarré sur http://localhost:${PORT}`));
}

startServer();
