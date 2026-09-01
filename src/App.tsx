/**
 * App.tsx — Interface (React) du vérificateur Syracuse / Sudoc.
 *
 * Application à écran unique avec 4 vues successives (état `view`) :
 *   UPLOAD     : dépôt du fichier XML Syracuse.
 *   VERIFYING  : barre de progression (interrogation de `api/status`).
 *   DASHBOARD  : statistiques, graphe des champs impactés, liste des notices,
 *                configuration du LLM, boutons d'export.
 *   DETAIL     : revue d'une notice — comparaison Syracuse/Sudoc, acceptation /
 *                rejet / modification de chaque écart, rattachement d'un PPN
 *                pour les notices de catégorie B, suggestions RAMEAU par IA.
 *
 * Tout l'état vit dans le composant App ; le serveur détient les données de
 * session. Les sous-composants (StatCard, PpnCell, FullCompareTable, etc.) sont
 * définis en bas du fichier.
 *
 * NOTE MAINTENANCE : ce fichier est volontairement resté d'un seul tenant (repris
 * du POC). Un découpage en composants par vue est une amélioration possible ;
 * voir CLAUDE.md.
 */
import React, { useState, useEffect } from 'react';
import { Upload, FileText, CheckCircle, AlertTriangle, XCircle, HelpCircle, Download, ArrowLeft, ArrowRight, Sparkles, Wrench, GitMerge, Search, Link2, ExternalLink } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

type ViewState = 'UPLOAD' | 'VERIFYING' | 'DASHBOARD' | 'DETAIL';

// ════════════════ Tables de correspondance & constantes partagées ════════════════
const SYRACUSE_MAPPING: Record<string, string> = {
  "Titre": "titre",
  "Auteur principal - Personne physique": "auteurPrincipal",
  "Autre auteur principal - Personne physique": "autresAuteurs",
  "Auteur secondaire - Personne physique": "auteursSecondaires",
  "Auteur principal - Collectivité ": "auteurPrincipalCollectivite",
  "Autre auteur principal - Collectivité": "autreAuteurPrincipalCollectivite",
  "Auteur secondaire- Collectivité": "auteurSecondaireCollectivite",
  "Editeur": "editeur", "Publié le": "annee", "ISBN": "isbn", "EAN": "ean",
  "Collection": "collection", "Description matérielle": "descriptionMaterielle",
  "Résumé": "resume", "Table des matières": "tableDesMatieres",
  "Vedette matière - Nom commun": "vedetteNomCommun",
  "Vedette matière - Nom de personne": "vedettePersonne",
  "Vedette matière - Nom de collectivité": "vedetteCollectivite",
  "Vedette matière - Nom géographique": "vedetteGeo",
  "Vedette matière - Forme, genre": "vedetteFormeGenre",
  "Prix": "prix", "Notes": "notes"
};

const SUDOC_KEY_LABELS: Record<string, string> = {
  titre:"Titre", auteurPrincipal:"Auteur principal", auteur:"Auteur principal",
  autresAuteurs:"Autres auteurs", auteursSecondaires:"Auteurs secondaires",
  auteurPrincipalCollectivite:"Auteur collectivité", editeur:"Éditeur", annee:"Année",
  isbn:"ISBN", ean:"EAN", collection:"Collection", descriptionMaterielle:"Description matérielle",
  resume:"Résumé", tableDesMatieres:"Table des matières", vedetteNomCommun:"Vedettes matières",
  vedettePersonne:"Vedette personne", vedetteCollectivite:"Vedette collectivité",
  vedetteGeo:"Vedette géographique", vedetteFormeGenre:"Vedette forme/genre",
  prix:"Prix", notes:"Notes", reliure:"Reliure",
};

const UNMODIFIABLE_FIELDS = new Set([
  "Identifiant","Identifiant d'origine","Filtre","Règle","Nombre d'exemplaires",
  "Référence commerciale","Référence éditoriale","EAN (valeur)","UPC","Document",
  "Type de notice","Agence de catalogage","Titre uniforme","Titre : volume",
  "Titre de partie et N° de partie","Titre de série","Tome","Nom - Responsabiblité"
]);

// ════════════════ Utilitaires (PPN, URLs Sudoc, lecture des champs) ════════════════
function padPpn(ppn: string|undefined|null): string {
  if (!ppn) return '';
  const s = String(ppn).trim();
  if (/^[0-9]{8}[0-9X]?$/i.test(s) && s.length === 8) return '0' + s;
  return s;
}
function sudocUrl(ppn: string|undefined|null): string { return `https://www.sudoc.fr/${padPpn(ppn)}`; }
function sudocXmlUrl(ppn: string|undefined|null): string { return `https://www.sudoc.fr/${padPpn(ppn)}.xml`; }

function getSyrProp(record: any, name: string): string {
  if (!record) return '';
  for (const src of [record?.syracuse?.properties, record?.properties]) {
    if (Array.isArray(src)) {
      const f = src.find((p:any) => (p['@_name']??p.name) === name);
      if (f) { const v = (f['@_value']??f.value??'').trim(); if (v) return v; }
    }
  }
  const k = SYRACUSE_MAPPING[name];
  if (k) { const v = record?.[k] || record?.syracuse?.[k]; if (v) return String(v).trim(); }
  return '';
}

function getAllSyrProps(record: any): Array<{name:string;value:string}> {
  const res: Array<{name:string;value:string}> = []; const seen = new Set<string>();
  for (const src of [record?.syracuse?.properties, record?.properties]) {
    if (!Array.isArray(src)) continue;
    for (const p of src) {
      const n = (p['@_name']??p.name??'').trim(), v = (p['@_value']??p.value??'').trim();
      if (n && v && !UNMODIFIABLE_FIELDS.has(n) && !seen.has(n)) { res.push({name:n,value:v}); seen.add(n); }
    }
  }
  for (const [sn, sk] of Object.entries(SYRACUSE_MAPPING)) {
    if (seen.has(sn)) continue;
    const v = record?.[sk] || record?.syracuse?.[sk];
    if (v && String(v).trim()) { res.push({name:sn,value:String(v).trim()}); seen.add(sn); }
  }
  return res;
}

function getAllCandidateProps(c: any): Array<{key:string;label:string;value:string}> {
  if (!c) return [];
  const res: Array<{key:string;label:string;value:string}> = []; const seen = new Set<string>();
  for (const [k,v] of Object.entries(c)) {
    if (['ppn','recordData','raw','hasTypeSupport','eanGenerated','collation215','originePiste'].includes(k)) continue;
    const sv = String(v??'').trim(); if (!sv) continue;
    const lb = SUDOC_KEY_LABELS[k]||k; if (seen.has(lb)) continue;
    res.push({key:k,label:lb,value:sv}); seen.add(lb);
  }
  return res;
}

// ════════════════ Composant principal ════════════════
export default function App() {
  const [view, setView] = useState<ViewState>('UPLOAD');
  const [sessionId, setSessionId] = useState<string|null>(null);
  const [progress, setProgress] = useState({current:0,total:0,currentPpn:''});
  const [summary, setSummary] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [selectedNoticeId, setSelectedNoticeId] = useState<string|null>(null);
  const [filter, setFilter] = useState<string>('ALL');
  const [search, setSearch] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string|null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [showIdentical, setShowIdentical] = useState(false);
  const [uploadCounts, setUploadCounts] = useState<{total:number;catA:number;catB:number}|null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<any[]>([]);
  const [manualCandidate, setManualCandidate] = useState<any>(null);
  const [manualCandidates, setManualCandidates] = useState<any[]>([]);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiError, setAiError] = useState<string|null>(null);
  const [llmConfig, setLlmConfig] = useState({
    endpoint:'https://llm.lab.sspcloud.fr/api/chat/completions',apiKey:'',model:'',
    connected:false,models:[] as any[],isTesting:false,
    testResult:null as {success:boolean;message:string}|null,isPanelOpen:false
  });

  const uploadFile = async (file:File) => {
    setUploadError(null); setIsUploading(true);
    const fd = new FormData(); fd.append('file',file);
    try {
      const res = await fetch('api/upload',{method:'POST',body:fd,headers:{Accept:'application/json'}});
      if (res.headers.get('content-type')?.includes('text/html')) throw new Error(`Serveur indisponible (${res.status}).`);
      if (!res.ok) { setUploadError(`Erreur (${res.status})`); setIsUploading(false); return; }
      const d = await res.json();
      setSessionId(d.sessionId);
      setUploadCounts({total:d.totalNotices,catA:d.countCatA,catB:d.countCatB});
      setView('VERIFYING');
      await fetch(`api/verify/${d.sessionId}`,{method:'POST'});
      pollProgress(d.sessionId);
    } catch(err:any) { setUploadError(err.message); setIsUploading(false); }
  };

  // Interroge l'état du traitement toutes les secondes jusqu'à la fin.
  // (Remplace un ancien flux SSE, mis en tampon par les proxies -> barre figée.)
  const pollProgress = (id:string) => {
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`api/status/${id}`);
        const p = await r.json();
        if (p.progress) setProgress(p.progress);
        if (p.status==='COMPLETED' || p.status==='ERROR') { clearInterval(timer); fetchResults(id); }
      } catch { /* on réessaiera au prochain tick */ }
    }, 1000);
  };

  const fetchResults = async (id:string, keepView = false) => {
    try {
      const [s,r] = await Promise.all([fetch(`api/results/${id}/summary`).then(x=>x.json()),fetch(`api/results/${id}`).then(x=>x.json())]);
      if(s.error||r.error){setUploadError(s.error||r.error);setView('UPLOAD');return;}
      setSummary(s); setResults(r.results||[]); 
      if (!keepView) setView('DASHBOARD');
    } catch { setUploadError("Erreur résultats."); setView('UPLOAD'); }
  };

  // Repart de zéro pour traiter un nouveau fichier XML (la session serveur
  // précédente reste en mémoire mais n'est plus référencée par l'interface).
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const resetApp = () => {
    setSessionId(null); setResults([]); setSummary(null); setSelectedNoticeId(null);
    setUploadCounts(null); setProgress({current:0,total:0,currentPpn:''});
    setFilter('ALL'); setSearch(''); setUploadError(null); setIsUploading(false);
    setShowResetConfirm(false); setView('UPLOAD');
  };

  const fetchModels = async () => {
    try { const r=await fetch('api/llm/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:llmConfig.endpoint,apiKey:llmConfig.apiKey})}); const d=await r.json(); if(r.ok) setLlmConfig(p=>({...p,models:d.models})); else alert(d.error); } catch { alert("Erreur connexion."); }
  };
  const testLlm = async () => {
    setLlmConfig(p=>({...p,isTesting:true,testResult:null}));
    try { const r=await fetch('api/llm/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:llmConfig.endpoint,apiKey:llmConfig.apiKey,model:llmConfig.model})}); const d=await r.json(); setLlmConfig(p=>({...p,isTesting:false,testResult:{success:d.success,message:d.message},connected:d.success})); } catch { setLlmConfig(p=>({...p,isTesting:false,testResult:{success:false,message:"Erreur."},connected:false})); }
  };

  const getStatusIcon = (s:string) => {
    switch(s){
      case 'OK': case 'RATTACHE_SRU': case 'VALIDE': return <CheckCircle className="w-5 h-5 text-green-600"/>;
      case 'ERREUR': return <XCircle className="w-5 h-5 text-red-600"/>;
      case 'COMPLEMENT': case 'MANQUANT_SYRACUSE': return <AlertTriangle className="w-5 h-5 text-orange-500"/>;
      case 'MINEURE': case 'DIFFERENCE_MINEURE': return <AlertTriangle className="w-5 h-5 text-blue-500"/>;
      case 'NORMALISE': return <Wrench className="w-5 h-5 text-purple-600"/>;
      case 'EN_ATTENTE_RATTACHEMENT': return <Search className="w-5 h-5 text-indigo-600"/>;
      case 'ABSENT_SUDOC': return <XCircle className="w-5 h-5 text-gray-500"/>;
      default: return <HelpCircle className="w-5 h-5 text-gray-400"/>;
    }
  };
  const getRowClass = (s:string) => { switch(s){ case 'ERREUR':return 'bg-red-50'; case 'MANQUANT_SYRACUSE':return 'bg-orange-50'; case 'DIFFERENCE_MINEURE':return 'bg-blue-50'; case 'NORMALISE': case 'GENERE_AUTO': case 'FUSION':return 'bg-purple-50'; case 'IDENTIQUE':return 'bg-gray-50 text-gray-500'; default:return ''; } };

  const handleExport = async (format: 'xml' | 'csv' | 'txt') => {
    try {
      const response = await fetch(`api/export/${sessionId}/${format}?t=${Date.now()}`);
      if (!response.ok) throw new Error("Erreur de téléchargement");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export_${format === 'xml' ? 'corrige' : (format === 'txt' ? 'unimarc' : 'rapport')}_${sessionId?.substring(0,8) || 'export'}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (e) {
      console.error(e);
      alert("Erreur lors du téléchargement. Veuillez réessayer.");
    }
  };

  // Panneau de configuration LLM, affiché en bandeau collant (sticky) au-dessus
  // du tableau de bord ET du détail, pour pouvoir configurer le LLM à tout moment.
  const renderLlmConfig = () => (
    <div className="border-b bg-white shadow-sm">
      <div className="max-w-7xl mx-auto">
        <button onClick={()=>setLlmConfig(p=>({...p,isPanelOpen:!p.isPanelOpen}))} className="w-full px-4 py-2 flex justify-between items-center hover:bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">⚙️ Configuration LLM{llmConfig.connected&&<span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full ml-2">✓ {llmConfig.model}</span>}</h2>
          <span className="text-xs text-gray-500">{llmConfig.isPanelOpen?'▲ masquer':'▼ configurer'}</span>
        </button>
        {llmConfig.isPanelOpen&&<div className="px-4 pb-4"><div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium mb-1">Endpoint</label><input type="text" value={llmConfig.endpoint} onChange={e=>setLlmConfig(p=>({...p,endpoint:e.target.value}))} className="w-full px-3 py-2 border rounded-md"/></div>
          <div><label className="block text-sm font-medium mb-1">Clé d'API</label><input type="password" value={llmConfig.apiKey} onChange={e=>setLlmConfig(p=>({...p,apiKey:e.target.value}))} placeholder="sk-..." className="w-full px-3 py-2 border rounded-md"/></div>
          <div className="md:col-span-2"><label className="block text-sm font-medium mb-1">Modèle</label><div className="flex gap-3 mb-2"><select value={llmConfig.model} onChange={e=>setLlmConfig(p=>({...p,model:e.target.value}))} className="flex-1 px-3 py-2 border rounded-md"><option value="">-- Chargez --</option>{llmConfig.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select><button onClick={fetchModels} className="px-4 py-2 bg-gray-100 border rounded-md hover:bg-gray-200">🔄</button></div>
          <input type="text" value={llmConfig.model} onChange={e=>setLlmConfig(p=>({...p,model:e.target.value}))} placeholder="Ou saisir manuellement" className="w-full px-3 py-2 border rounded-md"/></div>
        </div><div className="mt-4 flex items-center gap-4"><button onClick={testLlm} disabled={llmConfig.isTesting||!llmConfig.endpoint||!llmConfig.apiKey||!llmConfig.model} className="px-4 py-2 bg-[#003366] text-white rounded-md disabled:opacity-50">{llmConfig.isTesting?"Test...":"🔌 Tester"}</button>{llmConfig.testResult&&<span className={`px-3 py-1.5 rounded-md text-sm font-medium ${llmConfig.testResult.success?'bg-green-100 text-green-800':'bg-red-100 text-red-800'}`}>{llmConfig.testResult.message}</span>}</div></div>}
      </div>
    </div>
  );

  const renderUpload = () => (
    <div className="flex flex-col items-center justify-center min-h-[80vh]">
      <div className="text-center mb-8"><h1 className="text-4xl font-bold text-[#003366] mb-2">Vérificateur de notices Syracuse / Sudoc</h1><p className="text-gray-600 text-lg">Centre de ressources documentaires de l'Insee</p></div>
      <div className={`w-full max-w-xl p-12 border-2 border-dashed rounded-xl flex flex-col items-center justify-center transition-colors ${isDragging?'border-[#003366] bg-blue-50':'border-gray-300 bg-gray-50 hover:bg-gray-100'} ${isUploading?'opacity-50 pointer-events-none':''}`}
        onDragEnter={e=>{e.preventDefault();setIsDragging(true)}} onDragOver={e=>{e.preventDefault();setIsDragging(true)}} onDragLeave={e=>{e.preventDefault();setIsDragging(false)}}
        onDrop={async e=>{e.preventDefault();setIsDragging(false);const f=e.dataTransfer.files?.[0];if(f)await uploadFile(f)}}>
        <Upload className={`w-16 h-16 text-[#003366] mb-4 ${isUploading?'animate-bounce':''}`}/>
        <p className="text-lg font-medium text-gray-700 mb-4">{isUploading?'Analyse...':'Glissez-déposez votre fichier XML Syracuse'}</p>
        {!isUploading&&<><p className="text-sm text-gray-500 mb-6">ou</p><label className="bg-[#003366] text-white px-6 py-3 rounded-lg cursor-pointer hover:bg-blue-800 font-medium">Parcourir<input type="file" accept=".xml" className="hidden" onChange={async e=>{const f=e.target.files?.[0];if(f)await uploadFile(f);e.target.value=''}}/></label></>}
      </div>
      {uploadError&&<div className="mt-6 p-4 bg-red-50 border-l-4 border-red-500 text-red-700 max-w-xl w-full rounded"><AlertTriangle className="w-5 h-5 inline mr-2"/>{uploadError}</div>}
    </div>
  );

  const renderVerifying = () => {
    const pct = progress.total>0?Math.round((progress.current/progress.total)*100):0;
    return (<div className="flex flex-col items-center justify-center min-h-[80vh]">
      <h2 className="text-2xl font-bold text-[#003366] mb-8">Vérification en cours...</h2>
      {uploadCounts&&<div className="flex gap-4 mb-8"><span className="bg-blue-100 text-blue-800 px-4 py-2 rounded-lg font-medium">{uploadCounts.catA} Sudoc</span><span className="bg-indigo-100 text-indigo-800 px-4 py-2 rounded-lg font-medium">{uploadCounts.catB} PMB</span></div>}
      <div className="w-full max-w-2xl bg-gray-200 rounded-full h-6 mb-4 overflow-hidden"><div className="bg-[#003366] h-6 rounded-full transition-all" style={{width:`${pct}%`}}/></div>
      <p className="text-lg text-gray-700">{progress.current}/{progress.total}</p>
      {progress.currentPpn&&<p className="text-sm text-gray-500 mt-2">{progress.currentPpn}</p>}
    </div>);
  };

  const renderDashboard = () => {
    if(!summary)return null;
    const chartData = Object.entries(summary.fieldsStats||{}).map(([n,c])=>({name:n,count:c})).sort((a:any,b:any)=>b.count-a.count).slice(0,10);
    const filtered = results.filter(r=>{
      if(filter==='ERREUR'&&r.nbErreurs===0)return false; if(filter==='COMPLEMENT'&&r.nbComplements===0)return false;
      if(filter==='OK'&&!['OK','RATTACHE_SRU','VALIDE'].includes(r.statutGlobal))return false;
      if(filter==='NON_TROUVE'&&r.statutGlobal!=='NON_TROUVE')return false;
      if(filter==='EN_ATTENTE'&&r.statutGlobal!=='EN_ATTENTE_RATTACHEMENT')return false;
      if(filter==='ABSENT'&&r.statutGlobal!=='ABSENT_SUDOC')return false;
      if(search){const s=search.toLowerCase();if(!(r.ppn||'').toLowerCase().includes(s)&&!(r.identifiant||'').toLowerCase().includes(s)&&!(r.titre||'').toLowerCase().includes(s))return false;}
      return true;
    });
    return (<div className="max-w-7xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold text-[#003366] mb-6">Tableau de bord</h1>

      {/* Bandeau d'actions : 3 colonnes (entrée / sorties corrigées / rapport) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-xl shadow-sm border p-5 flex flex-col items-center text-center">
          <Upload className="w-6 h-6 text-[#003366] mb-2"/>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Notices à valider</h3>
          <button onClick={()=>setShowResetConfirm(true)} className="flex items-center gap-2 px-4 py-2 border border-[#003366] text-[#003366] rounded-lg hover:bg-blue-50 text-sm font-medium"><Upload className="w-4 h-4"/>Nouveau fichier</button>
        </div>
        <div className="bg-white rounded-xl shadow-sm border p-5 flex flex-col items-center text-center">
          <Download className="w-6 h-6 text-green-700 mb-2"/>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Notices validées</h3>
          <div className="flex gap-3">
            <button onClick={()=>handleExport('xml')} className="flex items-center gap-2 px-4 py-2 bg-[#003366] text-white rounded-lg hover:bg-blue-800 text-sm font-medium"><Download className="w-4 h-4"/>XML</button>
            <button onClick={()=>handleExport('txt')} className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium"><Download className="w-4 h-4"/>UNIMARC</button>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border p-5 flex flex-col items-center text-center">
          <FileText className="w-6 h-6 text-amber-600 mb-2"/>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Rapport d'écarts</h3>
          <button onClick={()=>handleExport('csv')} className="flex items-center gap-2 px-4 py-2 border border-amber-600 text-amber-700 rounded-lg hover:bg-amber-50 text-sm font-medium"><FileText className="w-4 h-4"/>CSV</button>
        </div>
      </div>

      {/* Modale de confirmation — « Nouveau fichier » */}
      {showResetConfirm&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
          <div className="flex items-start gap-3 mb-4">
            <AlertTriangle className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5"/>
            <div>
              <h3 className="text-lg font-bold text-gray-900 mb-1">Charger un nouveau fichier ?</h3>
              <p className="text-sm text-gray-600">Votre travail en cours (corrections, rattachements, mots-clés) sera perdu. Pensez à exporter vos résultats avant de continuer.</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 mt-6">
            <div className="flex gap-3">
              <button onClick={()=>handleExport('xml')} className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-[#003366] text-white rounded-lg text-sm font-medium hover:bg-blue-800"><Download className="w-4 h-4"/>Exporter XML</button>
              <button onClick={()=>handleExport('txt')} className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700"><Download className="w-4 h-4"/>Exporter UNIMARC</button>
            </div>
            <div className="flex gap-3 pt-2 border-t">
              <button onClick={()=>setShowResetConfirm(false)} className="flex-1 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-gray-50">Annuler</button>
              <button onClick={resetApp} className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600">Continuer sans exporter</button>
            </div>
          </div>
        </div>
      </div>}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <StatCard label="Valides" value={summary.ok} color="border-l-green-500"/><StatCard label="Compléments" value={summary.complements} color="border-l-orange-500"/><StatCard label="Erreurs" value={summary.erreurs} color="border-l-red-500"/>
        <StatCard label="Non trouvées" value={summary.nonTrouve} color="border-l-gray-400"/><StatCard label="PMB en attente" value={summary.enAttente||0} color="border-l-indigo-600"/><StatCard label="Absentes" value={summary.absent||0} color="border-l-gray-800"/>
      </div>
      {chartData.length>0&&<div className="bg-white p-6 rounded-xl shadow-sm border mb-8"><h3 className="text-lg font-semibold mb-4">Champs impactés</h3><div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} layout="vertical" margin={{top:5,right:30,left:150,bottom:5}}><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number"/><YAxis dataKey="name" type="category" width={140} tick={{fontSize:12}}/><Tooltip/><Bar dataKey="count" fill="#003366" radius={[0,4,4,0]}/></BarChart></ResponsiveContainer></div></div>}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-4 border-b flex flex-col sm:flex-row justify-between items-center gap-4 bg-gray-50">
          <select className="px-3 py-2 border rounded-lg text-sm bg-white" value={filter} onChange={e=>setFilter(e.target.value)}><option value="ALL">Toutes</option><option value="ERREUR">Erreurs</option><option value="COMPLEMENT">Compléments</option><option value="OK">Valides</option><option value="NON_TROUVE">Non trouvés</option><option value="EN_ATTENTE">PMB en attente</option><option value="ABSENT">Absentes</option></select>
          <input type="text" placeholder="Rechercher..." className="px-4 py-2 border rounded-lg text-sm w-full sm:w-64" value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-left border-collapse"><thead><tr className="bg-gray-50 text-gray-600 text-sm border-b"><th className="p-4">Statut</th><th className="p-4">PPN</th><th className="p-4">Titre</th><th className="p-4">Id Syracuse</th><th className="p-4 text-center">Écarts</th><th className="p-4"></th></tr></thead>
        <tbody>{filtered.map((r,i)=>(<tr key={i} className="border-b hover:bg-gray-50"><td className="p-4">{getStatusIcon(r.statutGlobal)}</td><td className="p-4 font-mono text-sm"><PpnCell record={r}/></td><td className="p-4 text-sm truncate max-w-md" title={r.titre}>{r.titre?.substring(0,60)}{r.titre?.length>60?'…':''}</td><td className="p-4 text-sm text-gray-500">{r.identifiant}</td><td className="p-4 text-center"><div className="flex justify-center gap-2">{r.nbErreurs>0&&<span className="bg-red-100 text-red-800 text-xs px-2 py-1 rounded-full">{r.nbErreurs} err</span>}{r.nbComplements>0&&<span className="bg-orange-100 text-orange-800 text-xs px-2 py-1 rounded-full">{r.nbComplements} comp</span>}{r.nbMineures>0&&<span className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded-full">{r.nbMineures} min</span>}</div></td><td className="p-4 text-right"><button onClick={()=>{setSelectedNoticeId(r.identifiant);setView('DETAIL')}} className="text-[#003366] hover:underline text-sm font-medium">Voir détail</button></td></tr>))}</tbody></table></div>
      </div>
    </div>);
  };

  useEffect(()=>{if(selectedNoticeId){const r=results.find(x=>x.identifiant===selectedNoticeId);setAiSuggestions(r?.aiSuggestions||[]);setAiError(null);setManualCandidate(null);setManualCandidates([]);}},[selectedNoticeId,results]);

  const renderDetail = () => {
    const idx=results.findIndex(r=>r.identifiant===selectedNoticeId); const rec=results[idx]; if(!rec)return null;
    const isRattache=rec.categorie==='B'&&['RATTACHE_SRU','VALIDE'].includes(rec.statutGlobal);
    const isEnAttente=rec.categorie==='B'&&rec.statutGlobal==='EN_ATTENTE_RATTACHEMENT';
    const isAbsent=rec.categorie==='B'&&rec.statutGlobal==='ABSENT_SUDOC';
    const hasSudoc=!isEnAttente&&!isAbsent;
    const candidates=rec.sruCandidates||rec.candidates||rec.searchResults||[];

    const handleRattacher=async(rawPpn:string)=>{
      const ppn=padPpn(rawPpn);
      try{const r=await fetch(`api/results/${sessionId}/${rec.identifiant}/rattacher`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nouveauPpn:ppn})});const d=await r.json();if(d.success)fetchResults(sessionId!, true);else alert(d.error||'Échec');}catch(e){console.error(e);alert('Erreur réseau.');}
    };
    const handleValider=async()=>{
      try{const r=await fetch(`api/results/${sessionId}/${rec.ppn||rec.identifiant}/valider`,{method:'POST'});const d=await r.json();if(d.success)fetchResults(sessionId!, true);else alert(d.error||'Échec');}catch(e){console.error(e);alert('Erreur réseau.');}
    };
    const handleFetchSudoc=async(rawPpn:string)=>{
      const ppn=padPpn(rawPpn);
      try{const r=await fetch(`api/sudoc/${ppn}`);const d=await r.json();if(d.success)setManualCandidate(d.candidate);else alert(d.error||'Échec');}catch(e){console.error(e);alert('Erreur réseau.');}
    };
    const handleSearchSru=async(title:string)=>{
      try{const r=await fetch(`api/sru/search?title=${encodeURIComponent(title)}`);const d=await r.json();if(d.success)setManualCandidates(d.candidates);else alert(d.error||'Échec');}catch(e){console.error(e);alert('Erreur réseau.');}
    };
    const handleMarkAbsent=async()=>{try{const r=await fetch(`api/results/${sessionId}/${rec.identifiant}/absent`,{method:'POST'});const d=await r.json();if(d.success)fetchResults(sessionId!, true);}catch(e){console.error(e);}};
    const handleAction=async(champ:string,action:string,val?:string)=>{
      try{
        const r=await fetch(`api/results/${sessionId}/${rec.identifiant}/action`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({champ,action,valeurModifiee:val})});
        const d=await r.json();
        const nr=[...results];
        nr[idx] = { ...nr[idx] };
        if (!nr[idx].ecarts) nr[idx].ecarts = [];
        else nr[idx].ecarts = [...nr[idx].ecarts];
        
        const e=nr[idx].ecarts?.find((x:any)=>x.champ===champ);
        if(e){
          const eIdx = nr[idx].ecarts.indexOf(e);
          nr[idx].ecarts[eIdx] = { ...e, action, valeurModifiee: val !== undefined ? val : e.valeurModifiee };
        } else if (d.ecart) {
          nr[idx].ecarts.push(d.ecart);
        }
        setResults(nr);
      }catch(e){console.error(e);}
    };
    const handleBulk=async(a:string)=>{try{await fetch(`api/results/${sessionId}/bulk-action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a,ppn:rec.identifiant})});fetchResults(sessionId!, true);}catch(e){console.error(e);}};
    const generateAi=async()=>{if(!llmConfig.connected){setAiError("Configurez le LLM.");return;}setIsGeneratingAi(true);setAiError(null);try{const r=await fetch(`api/suggest-keywords/${sessionId}/${rec.identifiant}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:llmConfig.endpoint,apiKey:llmConfig.apiKey,model:llmConfig.model})});const d=await r.json();if(d.suggestions){setAiSuggestions(d.suggestions);setResults(p=>p.map(x=>x.identifiant===rec.identifiant?{...x,aiSuggestions:d.suggestions}:x));}else if(d.error)setAiError(d.error);}catch{setAiError("Erreur IA.");}finally{setIsGeneratingAi(false);}};
    const syncAiKw = (ns: any[]) => { fetch(`api/results/${sessionId}/${rec.identifiant}/update-ai-suggestions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestions: ns }) }).catch(console.error); };

    return (<div className="max-w-7xl mx-auto py-8 px-4">
      <div className="mb-6 flex items-center justify-between">
        <button onClick={()=>setView('DASHBOARD')} className="flex items-center gap-2 text-gray-600 hover:text-[#003366]"><ArrowLeft className="w-4 h-4"/>Retour</button>
        <div className="flex gap-2"><button onClick={()=>{if(idx>0)setSelectedNoticeId(results[idx-1].identifiant)}} disabled={idx===0} className="px-3 py-1 border rounded disabled:opacity-50"><ArrowLeft className="w-4 h-4"/></button><button onClick={()=>{if(idx<results.length-1)setSelectedNoticeId(results[idx+1].identifiant)}} disabled={idx===results.length-1} className="px-3 py-1 border rounded disabled:opacity-50"><ArrowRight className="w-4 h-4"/></button></div>
      </div>

      {rec.ppnSourceSecours&&<div className="mb-6 bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 rounded-lg flex items-center gap-2"><AlertTriangle className="w-5 h-5"/>Notice retrouvée par {rec.ppnSourceSecours==='ean2ppn'?"l’EAN":"l’ISBN"} : le PPN {padPpn(rec.ppnOrigine)} de Syracuse ne répond pas. Comparaison faite avec le <a href={sudocUrl(rec.ppn)} target="_blank" rel="noreferrer" className="underline">PPN {padPpn(rec.ppn)}</a> — à vérifier avant correction du PPN dans Syracuse.</div>}
      {isRattache&&<div className="mb-6 bg-indigo-50 border border-indigo-200 text-indigo-800 px-4 py-3 rounded-lg flex items-center gap-2"><Link2 className="w-5 h-5"/>Rattachée — <a href={sudocUrl(rec.ppn)} target="_blank" rel="noreferrer" className="underline">PPN {padPpn(rec.ppn)}</a> (PMB: {rec.identifiant})</div>}

      {isEnAttente&&(<div className="mb-8">
        <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2"><Search className="w-6 h-6 text-indigo-600"/>Recherche dans le Sudoc — Candidats trouvés</h3>
        <SyracuseRecap record={rec}/>
        {candidates.length===1?(<div className="bg-white rounded-xl shadow-sm border border-indigo-200 overflow-hidden mb-6">
          <div className="bg-indigo-50 px-4 py-3 border-b flex flex-wrap justify-between items-center gap-2">
            <span className="font-medium text-indigo-900">Un candidat — PPN {padPpn(candidates[0].ppn)} <a href={sudocUrl(candidates[0].ppn)} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-1 ml-2">Sudoc<ExternalLink className="w-3 h-3"/></a>{candidates[0].originePiste==='PPN_TRONQUE'&&<span className="ml-2 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded">PPN Syracuse complété d’un zéro</span>}</span>
            <div className="flex gap-2"><button onClick={()=>handleRattacher(candidates[0].ppn)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 font-medium">✓ Rattacher</button><button onClick={handleMarkAbsent} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">✗ Pas la bonne</button></div>
          </div>
          <div className="p-4"><FullCompareTable record={rec} candidate={candidates[0]}/></div>
        </div>):candidates.length>1?(<div className="space-y-6">
          {candidates.slice(0,10).map((c:any,ci:number)=>(<div key={ci} className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="bg-gray-50 px-4 py-3 border-b flex flex-wrap justify-between items-center gap-2">
              <span className="font-medium">Candidat {ci+1} — PPN {padPpn(c.ppn)} <a href={sudocUrl(c.ppn)} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-1 ml-2 text-sm">Sudoc<ExternalLink className="w-3 h-3"/></a>{c.originePiste==='PPN_TRONQUE'&&<span className="ml-2 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded">PPN Syracuse complété d’un zéro</span>}</span>
              <button onClick={()=>handleRattacher(c.ppn)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 font-medium">✓ Sélectionner</button>
            </div>
            <div className="p-4"><FullCompareTable record={rec} candidate={c}/></div>
          </div>))}
          {candidates.length>10&&<p className="text-sm text-gray-500 italic">10 premiers sur {candidates.length}.</p>}
          <button onClick={handleMarkAbsent} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Aucun ne correspond</button>
        </div>):(<div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-lg"><p className="font-medium">⏳ Aucun candidat disponible.</p><p className="text-sm mt-1">Vérifiez que le backend retourne <code className="bg-yellow-100 px-1 rounded">sruCandidates</code>.</p></div>)}
      </div>)}

      {isAbsent&&<div className="space-y-6">
        <div className="bg-gray-100 border text-gray-700 px-4 py-4 rounded-lg">
          <div className="flex items-center gap-2 mb-3"><XCircle className="w-5 h-5 text-gray-500"/>Aucune notice trouvée. Conservée telle quelle.</div>
          
          <div className="flex flex-col gap-4 mt-4 pt-4 border-t border-gray-200">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium w-48">Recherche par PPN :</span>
              <input type="text" placeholder="PPN Sudoc..." className="px-3 py-1.5 border rounded text-sm w-48" id="manual-ppn-input" />
              <button onClick={() => {
                const val = (document.getElementById('manual-ppn-input') as HTMLInputElement).value;
                if (val) handleFetchSudoc(val);
              }} className="px-3 py-1.5 bg-indigo-100 text-indigo-700 border border-indigo-200 rounded text-sm hover:bg-indigo-200">Récupérer notice</button>
            </div>
            
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium w-48">Recherche par titre :</span>
              <input type="text" placeholder="Titre..." className="px-3 py-1.5 border rounded text-sm w-64" id="manual-title-input" />
              <button onClick={() => {
                const val = (document.getElementById('manual-title-input') as HTMLInputElement).value;
                if (val) handleSearchSru(val);
              }} className="px-3 py-1.5 bg-indigo-100 text-indigo-700 border border-indigo-200 rounded text-sm hover:bg-indigo-200">Rechercher candidats</button>
            </div>
          </div>
        </div>

        <SyracuseRecap record={rec} />

        {manualCandidate && (
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="bg-indigo-50 px-4 py-3 border-b flex flex-wrap justify-between items-center gap-2">
              <span className="font-medium text-indigo-900">Candidat manuel — PPN {padPpn(manualCandidate.ppn)} <a href={sudocUrl(manualCandidate.ppn)} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-1 ml-2">Sudoc<ExternalLink className="w-3 h-3"/></a></span>
              <button onClick={()=>handleRattacher(manualCandidate.ppn)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 font-medium">✓ Rattacher</button>
            </div>
            <div className="p-4"><FullCompareTable record={rec} candidate={manualCandidate}/></div>
          </div>
        )}

        {manualCandidates.length > 0 && (
          <div className="space-y-6">
            <h3 className="text-lg font-bold text-gray-900">Résultats de la recherche</h3>
            {manualCandidates.map((c:any,ci:number)=>(
              <div key={ci} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                <div className="bg-gray-50 px-4 py-3 border-b flex flex-wrap justify-between items-center gap-2">
                  <span className="font-medium">Candidat {ci+1} — PPN {padPpn(c.ppn)} <a href={sudocUrl(c.ppn)} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-1 ml-2 text-sm">Sudoc<ExternalLink className="w-3 h-3"/></a>{c.originePiste==='PPN_TRONQUE'&&<span className="ml-2 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded">PPN Syracuse complété d’un zéro</span>}</span>
                  <button onClick={()=>handleRattacher(c.ppn)} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 font-medium">✓ Sélectionner</button>
                </div>
                <div className="p-4"><FullCompareTable record={rec} candidate={c}/></div>
              </div>
            ))}
          </div>
        )}
      </div>}

      {hasSudoc&&<>
        <div className="bg-white p-6 rounded-xl shadow-sm border mb-6"><div className="flex justify-between items-start mb-4"><div><h2 className="text-2xl font-bold text-gray-900 mb-2">{rec.titre}</h2><div className="flex gap-4 text-sm text-gray-500 flex-wrap"><span>PPN: <a href={sudocUrl(rec.ppn)} target="_blank" rel="noreferrer" className="text-[#003366] hover:underline">{padPpn(rec.ppn)}</a></span><span><a href={sudocXmlUrl(rec.ppn)} target="_blank" rel="noreferrer" className="text-[#003366] hover:underline">XML</a></span><span>Syracuse: {rec.identifiant}</span></div></div><div className="flex gap-2"><button onClick={()=>handleBulk('TOUT_ACCEPTER')} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm">Tout accepter</button><button onClick={()=>handleBulk('TOUT_REJETER')} className="px-4 py-2 border rounded-lg text-sm">Tout rejeter</button></div></div></div>
        <div className="mb-4 flex justify-end"><label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer"><input type="checkbox" checked={showIdentical} onChange={e=>setShowIdentical(e.target.checked)} className="rounded"/>Afficher identiques</label></div>
        {rec.categorie !== 'B' && (() => {
          const visibleEcarts = rec.ecarts?.filter((e:any)=>showIdentical||!['IDENTIQUE','NON_VERIFIE','ABSENT_SUDOC'].includes(e.statut)) || [];
          if (visibleEcarts.length === 0) return null;
          return <div className="bg-white rounded-xl shadow-sm border overflow-hidden mb-8"><table className="w-full text-left border-collapse"><thead><tr className="bg-gray-50 text-gray-600 text-sm border-b"><th className="p-4 w-1/5">Champ</th><th className="p-4 w-1/4">Syracuse</th><th className="p-4 w-1/4">Sudoc</th><th className="p-4 w-28">Statut</th><th className="p-4">Action</th></tr></thead><tbody>{visibleEcarts.map((e:any,i:number)=>(<tr key={i} className={`border-b ${getRowClass(e.statut)}`}><td className="p-4 text-sm font-medium text-gray-700">{e.champ}</td><td className="p-4 text-sm break-words">{e.statut==='NORMALISE'?<span className="line-through text-gray-500">{e.valeurSyracuse}</span>:(e.valeurSyracuse||<span className="text-gray-400 italic">vide</span>)}</td><td className="p-4 text-sm break-words">{e.action==='MODIFIER'?<span className="text-blue-700 font-medium">{e.valeurModifiee}</span>:e.statut==='NORMALISE'?<span className="text-purple-700 font-medium">{e.valeurSudoc}</span>:e.statut==='GENERE_AUTO'?<span className="text-purple-700 font-medium">Généré: {e.valeurSudoc}</span>:(e.valeurSudoc||<span className="text-gray-400 italic">vide</span>)}</td><td className="p-4 text-xs font-medium"><StatusBadge statut={e.statut}/></td><td className="p-4">{['ERREUR','MANQUANT_SYRACUSE','DIFFERENCE_MINEURE','NORMALISE','GENERE_AUTO','FUSION'].includes(e.statut)&&<EcartActions ecart={e} onAction={handleAction} results={results} setResults={setResults} recordIndex={idx}/>}</td></tr>))}</tbody></table></div>;
        })()}
        {isRattache && rec.sudoc && (
          <div className="mb-8">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Comparaison complète des champs</h3>
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="p-4"><FullCompareTable record={rec} candidate={rec.sudoc} onAction={handleAction} results={results} setResults={setResults} recordIndex={idx}/></div>
            </div>
          </div>
        )}
      </>}

      {hasSudoc&&<div className="bg-purple-50 p-6 rounded-xl border border-purple-100">
        <div className="flex justify-between items-center mb-4"><h3 className="text-lg font-bold text-purple-900 flex items-center gap-2"><Sparkles className="w-5 h-5"/>Suggestions IA mots-clés</h3><button onClick={generateAi} disabled={isGeneratingAi} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm disabled:opacity-50">{isGeneratingAi?'Génération...':'✨ Générer'}</button></div>
        <p className="text-sm text-purple-700 mb-4">Générées par IA ({llmConfig.model||'non configuré'}). À valider.</p>
        {aiError&&<div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm"><AlertTriangle className="w-4 h-4 inline mr-1"/>{aiError}</div>}
        {aiSuggestions.length>0&&<div className="grid grid-cols-1 md:grid-cols-2 gap-3">{aiSuggestions.map((s,i)=>(<div key={i} className={`bg-white p-3 rounded border flex items-center shadow-sm ${s.selected ? 'border-green-500 bg-green-50' : 'border-purple-200'}`}><label className="flex items-center gap-2 w-full cursor-pointer"><input type="checkbox" checked={s.selected} onChange={e=>{const ns=[...aiSuggestions];ns[i].selected=e.target.checked;setAiSuggestions(ns);setResults(p=>p.map(x=>x.identifiant===rec.identifiant?{...x,aiSuggestions:ns}:x));syncAiKw(ns);}} className="rounded text-green-600 focus:ring-green-500"/><input type="text" className="text-sm bg-transparent border-none focus:ring-0 w-full" value={s.text} onChange={e=>{const ns=[...aiSuggestions];ns[i].text=e.target.value;setAiSuggestions(ns);setResults(p=>p.map(x=>x.identifiant===rec.identifiant?{...x,aiSuggestions:ns}:x));}} onBlur={() => syncAiKw(aiSuggestions)}/></label><button onClick={()=>{const ns=aiSuggestions.filter((_,j)=>j!==i);setAiSuggestions(ns);setResults(p=>p.map(x=>x.identifiant===rec.identifiant?{...x,aiSuggestions:ns}:x));syncAiKw(ns);}} className="text-gray-400 hover:bg-gray-50 p-1 rounded ml-2 flex-shrink-0"><XCircle className="w-4 h-4"/></button></div>))}</div>}
      </div>}

      {/* Bouton de validation placé APRÈS les suggestions : le choix des mots-clés
          se fait donc avant de valider la notice. */}
      {hasSudoc&&<div className="mt-8 flex justify-end">
        <button onClick={handleValider} className={`px-6 py-2 text-white rounded-lg font-medium flex items-center gap-2 transition-colors ${rec.statutGlobal === 'VALIDE' ? 'bg-green-800 hover:bg-green-900' : 'bg-green-500 hover:bg-green-600'}`}>
          <CheckCircle className="w-5 h-5" /> {rec.statutGlobal === 'VALIDE' ? 'Notice validée' : 'Valider la notice'}
        </button>
      </div>}
    </div>);
  };

  return (<div className="min-h-screen bg-gray-50 font-sans">
    <header className="bg-[#003366] text-white p-4 shadow-md"><div className="max-w-7xl mx-auto flex items-center justify-between"><div className="flex items-center gap-3"><div className="bg-white p-1 rounded"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7L12 12L22 7L12 2Z" fill="#003366"/><path d="M2 17L12 22L22 17" stroke="#003366" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 12L12 17L22 12" stroke="#003366" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div><h1 className="text-xl font-bold tracking-tight">Syracuse ⇄ Sudoc</h1></div>{sessionId&&!['UPLOAD','VERIFYING'].includes(view)&&<button onClick={()=>setView('DASHBOARD')} className="text-sm hover:underline">Tableau de bord</button>}</div></header>
    <main>
      {sessionId&&['DASHBOARD','DETAIL'].includes(view)&&<div className="sticky top-0 z-30">{renderLlmConfig()}</div>}
      {view==='UPLOAD'&&renderUpload()}{view==='VERIFYING'&&renderVerifying()}{view==='DASHBOARD'&&renderDashboard()}{view==='DETAIL'&&renderDetail()}
    </main>
  </div>);
}

// ════════════════ Sous-composants d'affichage ════════════════
function StatCard({label,value,color}:{label:string;value:number;color:string}){return<div className={`bg-white p-4 rounded-xl shadow-sm border border-gray-100 border-l-4 ${color}`}><h3 className="text-gray-500 text-xs font-medium mb-1">{label}</h3><p className="text-2xl font-bold text-gray-900">{value}</p></div>}
function PpnCell({record:r}:{record:any}){
  if(r.categorie==='B'&&r.statutGlobal==='EN_ATTENTE_RATTACHEMENT')return<span className="text-indigo-600 font-medium flex items-center gap-1"><Search className="w-4 h-4"/>PMB:{r.identifiant}</span>;
  if(r.categorie==='B'&&r.statutGlobal==='ABSENT_SUDOC')return<span className="text-gray-500 flex items-center gap-1"><XCircle className="w-4 h-4"/>PMB:{r.identifiant}</span>;
  if(r.categorie==='B'&&r.statutGlobal==='RATTACHE_SRU')return<div className="flex flex-col"><a href={sudocUrl(r.ppn)} target="_blank" rel="noreferrer" className="hover:underline">{padPpn(r.ppn)}</a><span className="text-xs text-indigo-600 font-medium bg-indigo-50 px-1 py-0.5 rounded mt-1 w-max"><Link2 className="w-3 h-3 inline mr-1"/>SRU</span></div>;
  return r.ppn?<a href={sudocUrl(r.ppn)} target="_blank" rel="noreferrer" className="hover:underline">{padPpn(r.ppn)}</a>:<span className="text-gray-400">—</span>;
}
function StatusBadge({statut}:{statut:string}){switch(statut){case 'ERREUR':return<span className="text-red-700">ERREUR</span>;case 'MANQUANT_SYRACUSE':return<span className="text-orange-700">MANQUANT</span>;case 'DIFFERENCE_MINEURE':return<span className="text-blue-700">MINEURE</span>;case 'NORMALISE':return<span className="text-purple-700 flex items-center gap-1"><Wrench className="w-3 h-3"/>NORMALISÉ</span>;case 'GENERE_AUTO':return<span className="text-purple-700 flex items-center gap-1"><Sparkles className="w-3 h-3"/>GÉNÉRÉ</span>;case 'FUSION':return<span className="text-purple-700 flex items-center gap-1"><GitMerge className="w-3 h-3"/>FUSION</span>;case 'IDENTIQUE':return<span>IDENTIQUE</span>;default:return<span className="text-gray-500">{statut}</span>;}}

function SyracuseRecap({record}:{record:any}){
  const allProps=getAllSyrProps(record);
  if(allProps.length===0)return null;
  return(<div className="bg-gray-50 rounded-lg p-4 mb-4 border border-gray-200">
    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Votre notice Syracuse (PMB) — champs renseignés</h4>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">{allProps.map((p,i)=>(<div key={i} className="flex gap-2"><span className="font-medium text-gray-600 whitespace-nowrap">{p.name} :</span><span className="text-gray-900 break-words">{p.value}</span></div>))}</div>
  </div>);
}

function FullCompareTable({record,candidate,onAction,results,setResults,recordIndex:idx}:{record:any;candidate:any;onAction?:(c:string,a:string,v?:string)=>void;results?:any[];setResults?:(r:any[])=>void;recordIndex?:number}){
  const syrProps=getAllSyrProps(record); const syrMap=new Map<string,string>(); for(const p of syrProps)syrMap.set(p.name,p.value);
  const sudocProps=getAllCandidateProps(candidate);
  const inv=new Map<string,string>(); for(const[sn,sk]of Object.entries(SYRACUSE_MAPPING))inv.set(sk,sn); inv.set('auteur','Auteur principal - Personne physique');
  type R={label:string;syrVal:string;sudocVal:string}; const rows:R[]=[]; const seen=new Set<string>();
  for(const sp of sudocProps){const sn=inv.get(sp.key)||'';const lb=sn||sp.label;if(seen.has(lb))continue;seen.add(lb);rows.push({label:lb,syrVal:sn?syrMap.get(sn)||'':'',sudocVal:sp.value});}
  for(const[n,v]of syrMap.entries()){if(seen.has(n))continue;seen.add(n);rows.push({label:n,syrVal:v,sudocVal:''});}
  const visible=rows.filter(r=>r.syrVal||r.sudocVal);
  const showActions = !!onAction && !!results && !!setResults && idx !== undefined;
  return(<div className="overflow-x-auto"><table className="w-full text-sm border-collapse"><thead><tr className="border-b text-xs font-semibold text-gray-500 uppercase tracking-wider"><th className="py-2 text-left w-1/5">Champ</th><th className="py-2 text-left w-2/5">Syracuse</th><th className="py-2 text-left w-2/5">Sudoc ({padPpn(candidate.ppn)})</th>{showActions&&<th className="py-2 text-left w-32">Action</th>}</tr></thead>
  <tbody>{visible.map((r,i)=>{
    const m=r.syrVal&&r.sudocVal&&r.syrVal.toLowerCase().trim()===r.sudocVal.toLowerCase().trim();
    let ecart = record.ecarts?.find((e:any)=>e.champ===r.label);
    if (showActions && !ecart) {
      ecart = { champ: r.label, valeurSyracuse: r.syrVal, valeurSudoc: r.sudocVal, action: 'CONSERVER' };
    }
    return(<tr key={i} className="border-b border-gray-50">
      <td className="py-2 pr-2 font-medium text-gray-600 align-top">{r.label}</td>
      <td className="py-2 pr-2 text-gray-800 align-top break-words max-w-xs">{ecart?.action==='NORMALISE'?<span className="line-through text-gray-500">{r.syrVal}</span>:(r.syrVal||<span className="text-gray-400 italic">vide</span>)}</td>
      <td className={`py-2 align-top break-words max-w-xs ${m?'text-green-700':r.sudocVal?'text-indigo-700':''}`}>{ecart?.action==='MODIFIER'?<span className="text-blue-700 font-medium">{ecart.valeurModifiee}</span>:ecart?.action==='NORMALISE'?<span className="text-purple-700 font-medium">{r.sudocVal}</span>:(r.sudocVal||<span className="text-gray-400 italic">vide</span>)}</td>
      {showActions&&<td className="py-2 align-top"><EcartActions ecart={ecart} onAction={onAction} results={results!} setResults={setResults!} recordIndex={idx!}/></td>}
    </tr>)
  })}</tbody></table></div>);
}

function EcartActions({ecart:e,onAction,results,setResults,recordIndex:idx}:{ecart:any;onAction:(c:string,a:string,v?:string)=>void;results:any[];setResults:(r:any[])=>void;recordIndex:number}){
  return(<div className="flex flex-col gap-2"><div className="flex gap-2"><button onClick={()=>onAction(e.champ,'ACCEPTER')} className={`px-2 py-1 text-xs rounded border ${e.action==='ACCEPTER'?'bg-green-600 text-white border-green-600':'bg-white text-green-700 border-green-600 hover:bg-green-50'}`}>Accepter</button><button onClick={()=>onAction(e.champ,'CONSERVER')} className={`px-2 py-1 text-xs rounded border ${e.action==='CONSERVER'?'bg-gray-600 text-white border-gray-600':'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>Conserver</button></div>
  {e.action==='MODIFIER'?(<div className="flex gap-2 mt-1"><input type="text" className="border rounded px-2 py-1 text-xs w-full" value={e.valeurModifiee||''} onChange={ev=>{const nr=[...results];nr[idx]={...nr[idx]};nr[idx].ecarts=[...(nr[idx].ecarts||[])];const eIdx=nr[idx].ecarts.findIndex((x:any)=>x.champ===e.champ);if(eIdx!==-1)nr[idx].ecarts[eIdx]={...nr[idx].ecarts[eIdx],valeurModifiee:ev.target.value};setResults(nr)}} onBlur={ev=>onAction(e.champ,'MODIFIER',ev.target.value)}/><button onClick={()=>onAction(e.champ,'CONSERVER')} className="text-gray-500"><XCircle className="w-4 h-4"/></button></div>):(<button onClick={()=>onAction(e.champ,'MODIFIER',e.valeurSudoc)} className="text-xs text-[#003366] hover:underline text-left">Modifier</button>)}
  </div>);
}