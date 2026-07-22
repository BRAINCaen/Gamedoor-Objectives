// ============================================================================
//  GAMEDOOR °41 — Robot de synchro 4escape -> Firebase   (v4 : double export)
//  ---------------------------------------------------------------------------
//  Chaque NUIT, pour le JOUR PRECEDENT, le robot telecharge DEUX exports du
//  Journal des ventes (/admin/statistics/accounting/journal-sales) :
//
//   EXPORT "VENTES" (le CA encaisse du jour)
//     · base = date de COMMANDE (date d'achat) · Statuts = "Uniquement paye"
//     · CA TTC = somme des debits des lignes de compte 411 (clients)
//     · detail par type : sessions / cheques cadeaux / autres produits
//       (garantie report, traiteur, privatisation, frais...) / remises
//
//   EXPORT "JOUE" (l'activite reelle du jour)
//     · base = date de PRESTATION (date de jeu) · Statuts = "Paye + En attente"
//     · sessions JOUEES = nb de "Session de jeu" distinctes (categorie Room)
//     · joueurs presents + CA joue TTC (bonus)
//
//  Le dashboard recoit :  ca = CA encaisse · sessions = sessions JOUEES.
//
//  Calibre les 2026-07-21 sur exports reels (controle comptable au centime :
//  HT + TVA = TTC). Test local :  node scrape.mjs --headful --dry-run
// ============================================================================

import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 0) Chargement du fichier .env local (tests sur PC — jamais commite)
// ---------------------------------------------------------------------------
try {
  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env facultatif */ }

// ---------------------------------------------------------------------------
// 1) Configuration
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const CFG = {
  base:        (process.env.FE_BASE || 'https://braincaen.4escape.io').replace(/\/+$/, ''),
  user:         process.env.FE_USER || '',
  pass:         process.env.FE_PASS || '',
  fbUrl:       (process.env.FB_URL || 'https://gamedoor-objectives-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, ''),
  journalPath:  process.env.JOURNAL_PATH || '/admin/statistics/accounting/journal-sales',
  dateArg:      getArg('date') || process.env.TARGET_DATE || '',   // defaut = hier (Paris)
  headful:      Boolean(getArg('headful')),
  keepOpen:     Boolean(getArg('keep-open')),
  dryRun:       Boolean(getArg('dry-run') || process.env.DRY_RUN === '1'),
  tz:           process.env.TZ || 'Europe/Paris',
  debugDir:     path.resolve(process.cwd(), 'debug'),
};

const log  = (...m) => console.log(new Date().toISOString(), '·', ...m);
const fail = (msg) => { console.error('\n❌ ' + msg); process.exitCode = 1; };

// ---------------------------------------------------------------------------
// 2) Dates
// ---------------------------------------------------------------------------
function parisYMD(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('fr-CA', {
    timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const targetDate = CFG.dateArg || parisYMD(-1);          // YYYY-MM-DD (hier par defaut)
const [Y, M, D] = targetDate.split('-');
const targetFR = `${D}/${M}/${Y}`;                       // DD/MM/YYYY (format du CSV)

// ---------------------------------------------------------------------------
// 3) Helpers texte / nombres / CSV
// ---------------------------------------------------------------------------
const stripAcc = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAcc(s).toLowerCase().replace(/\s+/g, ' ').trim();
const numFR = (s) => { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };

function parseCSV(text, sep) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cell += ch; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readExport(filePath) {
  if (/\.csv$/i.test(filePath)) {
    let text = fs.readFileSync(filePath, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const first = text.split(/\r?\n/)[0] || '';
    const sep = first.split(';').length >= first.split(',').length ? ';' : ',';
    return parseCSV(text, sep);
  }
  const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
}

// ---------------------------------------------------------------------------
// 4) Analyse d'un export (journal comptable en partie double, filtre au jour)
//    mode 'ventes' : filtre sur "Date de facture" (date d'achat) -> CA encaisse
//    mode 'joue'   : filtre sur "Date d'évènement" (date de jeu) -> sessions
//                    jouees (Room uniquement, cheques cadeaux exclus)
// ---------------------------------------------------------------------------
function analyseJournal(filePath, dayFR, mode = 'ventes') {
  const aoa = readExport(filePath).filter((r) => r.some((c) => String(c).trim() !== ''));
  const empty = { headers: [], totalRows: 0, dayRows: 0, otherDates: [], ttc: 0, ht: 0, tva: 0,
    sessions: 0, joueurs: 0, caSessions: 0, caBonsCadeaux: 0, caProduits: 0, remises: 0,
    nbBonsCadeaux: 0, nbProduits: 0, produits: [], codes: [] };
  if (!aoa.length) return empty;

  const headers = aoa[0].map((h) => String(h).trim());
  const rows = aoa.slice(1);
  const idx = (name) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iCpt = idx('N° Compte général'), iFact = idx('Date de facture'),
        iDeb = idx('Débit'), iCred = idx('Crédit'),
        iCat = idx('Catégorie de produit'), iSess = idx('Session de jeu'),
        iProd = idx('Produit'), iQte = idx('Quantité'),
        iTax = idx('Taxes appliquées'), iEvt = idx("Date d'évènement");
  const missing = Object.entries({ 'N° Compte général': iCpt, 'Date de facture': iFact, 'Débit': iDeb, 'Crédit': iCred })
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) throw new Error(`Colonnes introuvables dans l'export : ${missing.join(', ')} — le format 4escape a change (voir debug/).`);

  // Colonne de date qui definit "le jour" selon le mode
  const iDay = mode === 'joue' ? iEvt : iFact;
  if (iDay < 0) throw new Error(`[${mode}] Colonne de date introuvable (${mode === 'joue' ? "Date d'évènement" : 'Date de facture'}).`);
  // En mode 'joue', seules les lignes Room portent une date de jeu pertinente ;
  // les lignes 411/TVA/cheques cadeaux sont ignorees par les calculs ci-dessous.
  const dayRows = rows.filter((r) => String(r[iDay]).trim() === dayFR);
  const otherDates = [...new Set(rows.map((r) => String(r[iDay]).trim()))].filter((d) => d && d !== dayFR);

  let ttc = 0, ht = 0, tva = 0;
  let caSessions = 0, caBonsCadeaux = 0, caProduits = 0, remises = 0;
  let nbBonsCadeaux = 0, nbProduits = 0, joueurs = 0;
  const sess = new Set(); const produits = new Map(); const codes = new Map();

  for (const r of dayRows) {
    const cpt = String(r[iCpt]).trim();
    const cat = norm(iCat >= 0 ? r[iCat] : '');
    const prod = norm(iProd >= 0 ? r[iProd] : '');
    const qte = iQte >= 0 ? numFR(r[iQte]) : 0;
    const taux = iTax >= 0 ? numFR(r[iTax]) : 0;
    const ttcOf = (montantHT) => montantHT * (1 + taux / 100);

    // Mode "joue" (base date de prestation) :
    //  · lignes Room  = sessions JOUEES ce jour (ttc = CA joue)
    //  · lignes Cheque Cadeau = bons ACHETES ce jour (argent encaisse ce jour,
    //    a AJOUTER au CA du jour, mais PAS une session jouee)
    if (mode === 'joue') {
      if (!cpt.startsWith('70') || cpt.startsWith('709')) continue;
      const m = numFR(r[iCred]) - numFR(r[iDeb]);
      const chq = cat.includes('cheque') || cat.includes('carte cadeau') || cat.includes('bon cadeau');
      if (chq) { caBonsCadeaux += ttcOf(m); nbBonsCadeaux += qte > 0 ? qte : 1; continue; }
      if (cat !== 'room') continue;
      ht += m; ttc += ttcOf(m);                        // CA joue TTC (sessions + garanties liees)
      if (!prod.includes('garantie') && iSess >= 0 && String(r[iSess]).trim() !== '') {
        sess.add(String(r[iSess]) + ' | ' + String(r[iEvt]));
        joueurs += qte;
      }
      continue;
    }

    if (cpt.startsWith('411')) { ttc += numFR(r[iDeb]) - numFR(r[iCred]); continue; }
    if (cpt.startsWith('445')) { tva += numFR(r[iCred]) - numFR(r[iDeb]); continue; }
    // Codes de reduction / vouchers utilises en paiement (cartes cadeaux BUZZ,
    // TRIP, MARIAGE, Buzz 10/23, ...) : compte 709 OU categorie "Vouchers/Remises".
    // Ils REDUISENT ce que paie le client — jamais comptes comme du CA.
    if (cpt.startsWith('709') || cat.includes('vouchers') || cat.includes('remise')) {
      const m = numFR(r[iDeb]) - numFR(r[iCred]);
      const mttc = ttcOf(m);
      ht -= m; remises += mttc;
      const label = ((iProd >= 0 ? String(r[iProd]) : '') || 'Code / remise').trim().slice(0, 60);
      codes.set(label, (codes.get(label) || 0) + mttc);
      continue;
    }
    if (!cpt.startsWith('70')) continue;               // autres comptes : ignores
    const m = numFR(r[iCred]) - numFR(r[iDeb]);        // ligne de vente HT
    ht += m;

    const isRoom = cat === 'room';
    const isGarantie = prod.includes('garantie');
    const isCheque = cat.includes('cheque') || cat.includes('carte cadeau') || cat.includes('bon cadeau');

    if (isRoom && !isGarantie) {                       // vraie session
      caSessions += ttcOf(m);
      if (iSess >= 0 && String(r[iSess]).trim() !== '') {
        sess.add(String(r[iSess]) + ' | ' + (iEvt >= 0 ? String(r[iEvt]) : ''));
        joueurs += qte;
      }
    } else if (isCheque) {                             // cheque / bon cadeau
      caBonsCadeaux += ttcOf(m);
      nbBonsCadeaux += qte > 0 ? qte : 1;
    } else {                                           // garantie report, traiteur, privatisation, frais...
      caProduits += ttcOf(m);
      nbProduits += qte > 0 ? qte : 1;
      let nom = iProd >= 0 ? String(r[iProd]) : 'produit';
      if (isGarantie) nom = 'Garantie report de session';
      else if (prod.includes('frais de paiement')) nom = 'Frais de paiement partagé';
      else nom = nom.slice(0, 60);
      produits.set(nom, (produits.get(nom) || 0) + (qte > 0 ? qte : 1));
    }
  }

  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    headers, totalRows: rows.length, dayRows: dayRows.length, otherDates,
    ttc: r2(ttc), ht: r2(ht), tva: r2(tva),
    sessions: sess.size, joueurs: Math.round(joueurs),
    caSessions: r2(caSessions), caBonsCadeaux: r2(caBonsCadeaux), caProduits: r2(caProduits), remises: r2(remises),
    nbBonsCadeaux: Math.round(nbBonsCadeaux), nbProduits: Math.round(nbProduits),
    produits: [...produits.entries()].slice(0, 10).map(([n, q]) => `${q}× ${n}`),
    codes: [...codes.entries()].map(([label, montant]) => ({ label, montant: r2(montant) })).sort((a, b) => b.montant - a.montant).slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// 4bis) Avis Google — reutilise le pipeline du site GAMEDOOR41
//   Par defaut : lit le JSON public que le script du site (update-google-reviews)
//   publie dans le depot BRAINCaen/GAMEDOOR41. Si GOOGLE_PLACES_API_KEY est
//   fourni, interroge directement l'API Places (meme requete que le site).
//   avis du jour = total actuel - total memorise la veille (state/autoMeta).
// ---------------------------------------------------------------------------
const REVIEWS_JSON_URL = process.env.REVIEWS_JSON_URL ||
  'https://raw.githubusercontent.com/BRAINCaen/GAMEDOOR41/main/data/google-reviews.json';
const PLACES_QUERY = process.env.PLACES_QUERY || 'Brain Escape Game 41 bis rue Pasteur Caen';

async function fetchReviewsTotal() {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (key) {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.rating,places.userRatingCount',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ textQuery: PLACES_QUERY, maxResultCount: 5, languageCode: 'fr', regionCode: 'FR' }),
      });
      if (!res.ok) throw new Error(`Places API ${res.status}`);
      const data = await res.json();
      const m = (data.places || []).find((p) => typeof p.userRatingCount === 'number');
      if (!m) throw new Error('etablissement introuvable via Places');
      return { count: m.userRatingCount, rating: m.rating ?? null, source: 'places-api' };
    }
    const res = await fetch(REVIEWS_JSON_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`JSON avis ${res.status}`);
    const j = await res.json();
    if (typeof j.reviewCount !== 'number') throw new Error('champ reviewCount absent');
    return { count: j.reviewCount, rating: j.rating ?? null, source: 'site-json', majLe: j.updatedAt || null };
  } catch (e) {
    log('⚠️  Avis Google indisponibles cette nuit :', e.message, '(avis = 0, le reste continue)');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4ter) Authentification Firebase (anonyme, comme le dashboard) — necessaire
//   quand les regles RTDB passent a `auth != null`. Sur base ouverte, le token
//   est simplement ignore : ce code marche dans les deux cas.
// ---------------------------------------------------------------------------
let FB_TOKEN = null;
async function ensureAuth() {
  if (FB_TOKEN) return;
  const apiKey = process.env.FB_API_KEY || 'AIzaSyDda_GKBMHyaVrT4vzosMZnri3hyFCCwYs'; // cle web publique (deja dans index.html)
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    });
    if (r.ok) { FB_TOKEN = (await r.json()).idToken; log('🔐 Firebase : authentifié (anonyme).'); return; }
    log(`⚠️ Firebase auth anonyme : HTTP ${r.status} (écriture tentée sans token).`);
  } catch (e) { log('⚠️ Firebase auth anonyme échouée :', e.message); }
}
// Construit une URL RTDB en ajoutant le token d'auth s'il existe.
function rtdbUrl(pathJson) {
  return `${CFG.fbUrl}${pathJson}` + (FB_TOKEN ? `?auth=${FB_TOKEN}` : '');
}

// ---------------------------------------------------------------------------
// 5) Ecriture Firebase (PUT idempotent, cle fixe par jour)
// ---------------------------------------------------------------------------
async function writeToFirebase(entry) {
  await ensureAuth();
  const url = rtdbUrl(`/state/entries/auto-${entry.date}.json`);
  const res = await fetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Firebase PUT ${res.status} : ${body.slice(0, 300)}`);
  return body;
}

// ---------------------------------------------------------------------------
// 5bis) SYNERGIA — attribution d'XP a la CAGNOTTE d'equipe (paliers CA + avis)
//   Endpoint POST /api/v1/xp (cle "Lecture + XP"). Les ventes co individuelles
//   sont saisies manuellement dans Synergia -> le robot n'y touche pas.
//   IDEMPOTENCE : etat memorise dans le RTDB Gamedoor (state/autoMeta/synergiaXp).
// ---------------------------------------------------------------------------
const SYN = {
  base: (process.env.SYN_API_BASE || 'https://synergia-brain-caen.netlify.app').replace(/\/+$/, ''),
  key: process.env.SYN_XP_KEY || '',                                        // ecriture (Lecture + XP)
  readKey: process.env.SYN_READ_KEY || process.env.SYN_XP_KEY || '',        // lecture seule
};

// GET vers l'API Synergia (chemin direct connu-bon d'abord, puis /api/v1).
async function synGet(pathQ, key) {
  if (!key) return { ok: false, error: 'clé lecture Synergia absente' };
  for (const base of ['/.netlify/functions/api', '/api/v1']) {
    let res;
    try { res = await fetch(SYN.base + base + pathQ, { headers: { Authorization: 'Bearer ' + key } }); }
    catch (e) { return { ok: false, error: e.message }; }
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* SPA HTML -> mauvais chemin */ }
    if (j === null) continue;
    return { ok: res.ok, status: res.status, body: j };
  }
  return { ok: false, error: 'endpoint API Synergia introuvable' };
}

// Lit le defi "ventes co" (declare manuellement dans Synergia) et ecrit un
// resume SANS DONNEES SENSIBLES dans le RTDB Gamedoor -> affiche par le dashboard.
async function syncSynergiaVentes() {
  if (!SYN.readKey) { log('ℹ️  Ventes co : clé lecture Synergia absente → non mis à jour.'); return; }
  const res = await synGet('/team_challenges?limit=100', SYN.readKey);
  if (!res.ok) { log('⚠️ Ventes co : lecture Synergia échouée (' + (res.status || res.error) + ').'); return; }
  const items = res.body?.items || [];
  const sales = items.filter((c) => /sales/i.test(c.type || '') || /vente/i.test(c.unit || '') || /vente/i.test(c.title || ''));
  const defi = sales.find((c) => c.status === 'active') || sales.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  if (!defi) { log('ℹ️  Ventes co : aucun défi "ventes" trouvé dans Synergia.'); return; }

  const byName = {};
  for (const c of (defi.contributions || [])) { const n = (c.userName || '?').trim(); byName[n] = (byName[n] || 0) + (Number(c.amount) || 0); }
  const contributors = Object.entries(byName).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);

  const summary = {
    title: defi.title || 'Ventes co', unit: defi.unit || 'ventes',
    target: defi.targetValue ?? null, current: defi.currentValue ?? null, status: defi.status || null,
    contributors, updatedAt: new Date().toISOString(),
  };
  await ensureAuth();
  await fetch(rtdbUrl('/state/ventesCo.json'), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary),
  }).then((r) => { if (r.ok) log(`🛍️ Ventes co Synergia synchronisées : ${contributors.length} vendeur(s), défi ${summary.current}/${summary.target}.`); else log('⚠️ Ventes co : écriture RTDB échouée ' + r.status); });
}
const PALIERS = [
  { id: 'bronze', xp: 300, cfgKey: 'targetBronze', def: 27000, label: 'Bronze' },
  { id: 'argent', xp: 600, cfgKey: 'targetArgent', def: 30000, label: 'Argent' },
  { id: 'or',     xp: 1200, cfgKey: 'targetOr',    def: 33000, label: 'Or' },
];
const XP_PAR_AVIS = 40;

// POST /xp vers Synergia (tente /api/v1/xp puis le chemin direct de la fonction).
async function synPostXp(body) {
  if (!SYN.key) return { skipped: true };
  for (const p of ['/api/v1/xp', '/.netlify/functions/api/xp']) {
    let res;
    try {
      res = await fetch(SYN.base + p, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SYN.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) { return { ok: false, error: e.message }; }
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* SPA HTML -> mauvais chemin */ }
    if (json === null) continue;                 // pas du JSON => essaie le chemin direct
    return { ok: res.ok, status: res.status, body: json };
  }
  return { ok: false, error: 'endpoint XP introuvable (ni /api/v1/xp ni /.netlify/functions/api/xp)' };
}

// Lecture/ecriture de l'etat d'idempotence dans le RTDB Gamedoor.
async function synMeta(monthKey) {
  await ensureAuth();
  try { const r = await fetch(rtdbUrl('/state/autoMeta/synergiaXp.json')); if (r.ok) { const j = await r.json(); return j || {}; } } catch { /* vide */ }
  return {};
}
async function saveSynMeta(meta) {
  await ensureAuth();
  await fetch(rtdbUrl('/state/autoMeta/synergiaXp.json'), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
  }).catch(() => {});
}

// Etape SYNERGIA : credite la cagnotte pour les paliers CA franchis ce mois +
// les nouveaux avis. Retourne un resume pour le log. N'echoue jamais le run.
async function pushSynergia({ month, caMonth, nouveauxAvis }) {
  if (!SYN.key) { log('ℹ️  SYNERGIA : clé XP absente (SYN_XP_KEY) → étape sautée (rien n\'est envoyé).'); return; }
  const meta = await synMeta();
  meta.paliers = meta.paliers || {};
  meta.paliers[month] = meta.paliers[month] || {};
  let changed = false;

  // Paliers CA (une seule fois par mois, quand le cumul les franchit)
  for (const p of PALIERS) {
    const seuil = Number(process.env['SEUIL_' + p.id.toUpperCase()]) || p.def;
    if (caMonth >= seuil && !meta.paliers[month][p.id]) {
      const res = await synPostXp({ target: 'teamPool', amount: p.xp, reason: `Palier ${p.label} atteint (${seuil} €)`, source: 'gamedoor_objectives' });
      if (res.ok) { meta.paliers[month][p.id] = { xp: p.xp, at: new Date().toISOString() }; changed = true;
        log(`🏆 SYNERGIA cagnotte +${p.xp} XP — palier ${p.label} (${seuil} €) franchi. ${res.body?.poolLevelChanged ? 'NIVEAU CAGNOTTE ↑' : ''}`); }
      else log(`⚠️ SYNERGIA palier ${p.label} : échec envoi (${res.status || res.error}) — sera retenté demain.`);
    }
  }

  // Avis Google : +40 XP cagnotte par nouvel avis (le delta est deja idempotent
  // via le memo googleReviews ; on ne touche pas au memo ici).
  if (nouveauxAvis > 0) {
    const amount = Math.min(2000, nouveauxAvis * XP_PAR_AVIS);   // garde-fou 2000/appel
    const res = await synPostXp({ target: 'teamPool', amount, reason: `${nouveauxAvis} nouvel(s) avis Google`, source: 'gamedoor_objectives' });
    if (res.ok) { changed = true; log(`⭐ SYNERGIA cagnotte +${amount} XP — ${nouveauxAvis} nouvel(s) avis. ${res.body?.poolLevelChanged ? 'NIVEAU CAGNOTTE ↑' : ''}`); }
    else log(`⚠️ SYNERGIA avis : échec envoi (${res.status || res.error}).`);
  }

  if (changed) await saveSynMeta(meta);
}

// ---------------------------------------------------------------------------
// 6) Pilotage du formulaire : un export = reglages + periode + telechargement
// ---------------------------------------------------------------------------
async function runExport(page, dumpDebug, kind, wants) {
  // (re)charge la page du journal pour partir d'un formulaire propre
  await page.goto(CFG.base + CFG.journalPath, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (/\/login(\?|$)/.test(page.url())) { await dumpDebug(`${kind}-redirige-login`); throw new Error(`[${kind}] Redirige vers /login.`); }

  // Menus deroulants
  const selState = await page.evaluate((wantsIn) => {
    const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const n = (s) => strip(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const selects = [...document.querySelectorAll('select')];
    return wantsIn.map((w) => {
      for (const sel of selects) {
        const opt = [...sel.options].find((o) => n(o.textContent).includes(w.match));
        if (opt) {
          const changed = sel.value !== opt.value;
          if (changed) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          return { key: w.key, ok: true, changed, option: n(opt.textContent).slice(0, 70) };
        }
      }
      return { key: w.key, ok: false };
    });
  }, wants);
  for (const s of selState) {
    if (s.ok) log(`[${kind}] menu "${s.key}" : ${s.changed ? 'REGLE sur' : 'deja sur'} « ${s.option} »`);
    else log(`[${kind}] ⚠️ menu "${s.key}" : option INTROUVABLE`);
  }
  if (selState.some((s) => !s.ok)) {
    await dumpDebug(`${kind}-selects`);
    throw new Error(`[${kind}] Reglage des menus impossible (${selState.filter((s) => !s.ok).map((s) => s.key).join(', ')}) — on n'exporte pas.`);
  }

  // Periode via les champs CACHES flatpickr name="start"/"end" (format ISO)
  const dateSet = await page.evaluate((iso) => {
    const s = document.querySelector('input[name="start"]');
    const e = document.querySelector('input[name="end"]');
    if (!s || !e) return { ok: false };
    for (const el of [s, e]) {
      el.value = iso;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, start: s.value, end: e.value };
  }, targetDate);
  log(`[${kind}] periode start/end : ${JSON.stringify(dateSet)}`);
  if (!dateSet.ok || dateSet.start !== targetDate || dateSet.end !== targetDate) {
    await dumpDebug(`${kind}-dates`);
    throw new Error(`[${kind}] Periode non reglee sur ${targetDate}. On n'exporte pas.`);
  }
  await page.waitForTimeout(300);
  await dumpDebug(`${kind}-form-${targetDate}`);

  // Telechargement
  log(`[${kind}] clic sur "Telecharger" …`);
  const btn = page.locator('button[type="submit"]:has-text("Télécharger"), button:has-text("Télécharger")').first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    btn.click(),
  ]);
  const suggested = download.suggestedFilename() || `journal-${targetDate}.csv`;
  const savedPath = path.join(CFG.debugDir, `${kind}-${suggested}`);
  await download.saveAs(savedPath);
  log(`[${kind}] fichier telecharge : ${kind}-${suggested}`);

  // Analyse + garde-fou "periode ignoree"
  const r = analyseJournal(savedPath, targetFR, kind);
  if (r.totalRows > 0 && r.dayRows === 0) {
    throw new Error(`[${kind}] L'export contient ${r.totalRows} lignes mais AUCUNE du ${targetFR} ` +
      `(dates presentes : ${r.otherDates.slice(0, 5).join(', ')}…). Periode ignoree — rien n'est ecrit.`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// 7) Programme principal
// ---------------------------------------------------------------------------
async function main() {
  // Runs PLANIFIES (SCHEDULED=1) : plusieurs crons UTC couvrent ete/hiver +
  // rattrapage. Comme GitHub retarde souvent les crons (30 min a 2h), on
  // n'exige PAS une heure pile : on accepte toute la fenetre 0h-9h de Paris
  // (= apres minuit, la veille est bien cloturee, avant l'ouverture). L'anti-
  // doublon (lastSync) empeche de traiter deux fois le meme jour.
  if (process.env.SCHEDULED === '1') {
    const parisHour = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: CFG.tz, hour: 'numeric', hour12: false }).format(new Date()), 10);
    if (parisHour >= 9) {
      log(`Heure de Paris = ${parisHour}h (hors fenetre 0h-9h) : run planifie sauté.`);
      return;
    }
    await ensureAuth();
    try {
      const r = await fetch(rtdbUrl('/state/autoMeta/lastSync.json'));
      if (r.ok) { const ls = await r.json(); if (ls && ls.date === targetDate) {
        log(`Déjà synchronisé pour ${targetDate} (le ${ls.at}) : run planifié sauté (anti-doublon).`);
        return;
      } }
    } catch { /* pas de marqueur -> on continue */ }
  }
  log(`Robot 4escape (Journal des ventes ×2) · jour cible = ${targetDate} (${targetFR})`);
  if (!CFG.user || !CFG.pass) { fail('Identifiants manquants : definis FE_USER et FE_PASS.'); return; }
  fs.mkdirSync(CFG.debugDir, { recursive: true });
  await ensureAuth();   // token Firebase des le depart (RTDB verrouille -> auth != null)

  const browser = await chromium.launch({ headless: !CFG.headful });
  const context = await browser.newContext({
    locale: 'fr-FR', timezoneId: CFG.tz, acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  const dumpDebug = async (tag) => {
    try {
      await page.screenshot({ path: path.join(CFG.debugDir, `${tag}.png`), fullPage: true });
      fs.writeFileSync(path.join(CFG.debugDir, `${tag}.html`), await page.content());
      log(`(debug) capture -> debug/${tag}.png / .html`);
    } catch (e) { log('(debug) capture impossible :', e.message); }
  };

  try {
    // --- Connexion ---------------------------------------------------------
    log('Connexion a', CFG.base + '/login …');
    await page.goto(CFG.base + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"], #login-username', CFG.user);
    await page.fill('input[name="password"], #login-password', CFG.pass);
    await page.evaluate((p) => {
      const r = document.querySelector('input[name="returnTo"]'); if (r) r.value = p;
      const ps = document.querySelector('input[name="ps"]'); if (ps && !ps.value) ps.value = '4';
    }, CFG.journalPath);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (/\/login(\?|$)/.test(page.url())) { await dumpDebug('login-echec'); throw new Error('Connexion echouee (toujours sur /login). Verifie FE_USER / FE_PASS.'); }
    log('Connexion OK. URL :', page.url());

    // --- EXPORT 1 : "ventes" (CA encaisse, base date de commande) -----------
    const ventes = await runExport(page, dumpDebug, 'ventes', [
      { key: 'type',     match: 'commandes' },
      { key: 'dateBase', match: 'date de commande' },
      { key: 'statuts',  match: 'uniquement paye' },
    ]);
    // Controle comptable strict sur le CA encaisse
    const coherent = Math.abs((ventes.ht + ventes.tva) - ventes.ttc) <= 0.05;
    // Controle de la ventilation (arrondis de TVA ligne a ligne -> tolerance)
    const ventil = ventes.caSessions + ventes.caBonsCadeaux + ventes.caProduits - ventes.remises;
    const ventilOk = Math.abs(ventil - ventes.ttc) <= 1;

    // --- EXPORT 2 : "joue" (activite du jour, base date de prestation) ------
    const joue = await runExport(page, dumpDebug, 'joue', [
      { key: 'type',     match: 'commandes' },
      { key: 'dateBase', match: 'date de prestation' },
      { key: 'statuts',  match: 'en attente de paiement' },   // "Paye + En attente de paiement ou paiement incomplet"
    ]);

    // --- CA encaisse du jour -------------------------------------------------
    // Les cheques cadeaux presents dans l'export "ventes" (base commande) sont
    // des bons UTILISES en paiement -> deja encaisses a l'achat du bon : on les
    // RETIRE. Les cheques presents dans l'export "joue" (base prestation) sont
    // des bons ACHETES ce jour -> argent reellement encaisse : on les AJOUTE.
    const r2 = (x) => Math.round(x * 100) / 100;
    const caEncaisse = r2(ventes.ttc - ventes.caBonsCadeaux + joue.caBonsCadeaux);

    // --- Bilan --------------------------------------------------------------
    log('\n──────────── BILAN DU ' + targetFR + ' ────────────');
    log(`💰 Ventes du jour (base commande) = ${ventes.ttc} € TTC   (HT ${ventes.ht} + TVA ${ventes.tva} — ${coherent ? 'coherent ✔' : 'INCOHERENT ✘'})`);
    log(`   dont sessions        : ${r2(ventes.caSessions)} €  (${ventes.sessions} sessions vendues, ${ventes.joueurs} joueurs)`);
    log(`   dont autres produits : ${r2(ventes.caProduits)} €  (${ventes.nbProduits}) ${ventes.produits.length ? '→ ' + ventes.produits.join(' · ') : ''}`);
    log(`   remises appliquees   : -${r2(ventes.remises)} €   (ventilation ${ventilOk ? 'OK ✔' : '≈ ' + r2(ventil) + ' € (ecarts arrondis TVA)'}`.trimEnd() + ')');
    log(`   − cheques UTILISES en paiement : -${r2(ventes.caBonsCadeaux)} €  (${ventes.nbBonsCadeaux}) [deja encaisses a l'achat du bon]`);
    log(`   + cheques cadeaux ACHETES      : +${r2(joue.caBonsCadeaux)} €  (${joue.nbBonsCadeaux})`);
    log(`   ➜ CA ENCAISSE DU JOUR = ${caEncaisse} € TTC`);
    log(`🎮 ACTIVITE JOUEE (date de jeu)   = ${joue.sessions} session(s) jouee(s) · ${joue.joueurs} joueur(s) · CA joue ${joue.ttc} € TTC (cheques exclus)`);
    log('──────────────────────────────────────────────\n');

    if (!coherent) {
      throw new Error(`Incoherence comptable export ventes : HT (${ventes.ht}) + TVA (${ventes.tva}) != TTC (${ventes.ttc}). Rien n'est ecrit.`);
    }

    // --- Avis Google (delta vs total memorise) -------------------------------
    const gr = await fetchReviewsTotal();
    let avis = 0, avisInfo = null, prevCount = null;
    if (gr) {
      try {
        await ensureAuth();
        const pr = await fetch(rtdbUrl('/state/autoMeta/googleReviews.json'));
        if (pr.ok) { const p = await pr.json(); if (p && typeof p.count === 'number') prevCount = p.count; }
      } catch { /* premiere fois : pas de memoire */ }
      if (prevCount != null) avis = Math.max(0, gr.count - prevCount);
      avisInfo = { totalAvis: gr.count, note: gr.rating, precedent: prevCount, nouveaux: avis, source: gr.source };
      log(`⭐ Avis Google : total ${gr.count} (note ${gr.rating ?? '—'}) · memorise ${prevCount ?? '— (1re fois)'} · nouveaux du jour = ${avis}`);
    }

    fs.writeFileSync(path.join(CFG.debugDir, 'parsed-preview.json'), JSON.stringify({ targetDate, ventes, joue, avis: avisInfo }, null, 2));

    // --- Ecriture Firebase --------------------------------------------------
    const entry = {
      gm: '🤖 4escape (auto)',
      date: targetDate,
      ca: Math.round(caEncaisse),          // CA encaisse du jour = ventes - cheques utilises + cheques achetes
      sessions: joue.sessions,             // sessions JOUEES ce jour-la (cheques exclus)
      options: 0,                          // ventes co : saisie manuelle
      avis,                                // nouveaux avis Google depuis le dernier releve
      players: joue.joueurs,
      detail: {
        vendu: {
          ttcBrut: ventes.ttc, ht: ventes.ht,
          sessions: ventes.caSessions,
          chequesUtilises: ventes.caBonsCadeaux, nbChequesUtilises: ventes.nbBonsCadeaux,
          produits: ventes.caProduits, remises: ventes.remises,
          nbSessions: ventes.sessions, nbJoueurs: ventes.joueurs,
          nbProduits: ventes.nbProduits, listeProduits: ventes.produits,
          listeCodes: ventes.codes,
        },
        joue: {
          caJoue: joue.ttc, sessions: joue.sessions, joueurs: joue.joueurs,
          chequesAchetes: joue.caBonsCadeaux, nbChequesAchetes: joue.nbBonsCadeaux,
        },
        avisGoogle: avisInfo,
        caEncaisse,
      },
      source: 'journal-ventes-x2',
      ts: Date.now(),
      syncedAt: new Date().toISOString(),
    };
    log('Saisie preparee :', JSON.stringify(entry));

    if (CFG.dryRun) log('DRY-RUN : rien ecrit dans Firebase.');
    else {
      await writeToFirebase(entry);
      log(`✅ Ecrit dans Firebase : state/entries/auto-${targetDate}`);
      // Marqueur anti-doublon pour les runs planifies (voir garde-fou en tete)
      await fetch(rtdbUrl('/state/autoMeta/lastSync.json'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: targetDate, at: new Date().toISOString() }),
      }).catch(() => {});
      if (gr) {
        // Memorise le total d'avis pour le calcul du delta de demain (AVANT
        // l'envoi Synergia -> pas de double credit si l'envoi echoue/rejoue).
        await fetch(rtdbUrl('/state/autoMeta/googleReviews.json'), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: gr.count, rating: gr.rating, at: new Date().toISOString() }),
        }).then((r) => { if (!r.ok) log('⚠️ memo avis non enregistre :', r.status); });
      }
      // --- SYNERGIA : cagnotte d'equipe (paliers CA du mois + nouveaux avis) --
      const month = targetDate.slice(0, 7);
      let caMonth = 0;
      try {
        const er = await fetch(rtdbUrl('/state/entries.json'));
        if (er.ok) { const all = await er.json();
          caMonth = Object.values(all || {}).filter((e) => e && e.date && e.date.slice(0, 7) === month).reduce((a, e) => a + (e.ca || 0), 0); }
      } catch { /* cumul indispo -> paliers sautes ce tour */ }
      await pushSynergia({ month, caMonth, nouveauxAvis: avis });
      // Rafraichit le mini-classement "ventes co" (declare dans Synergia)
      await syncSynergiaVentes().catch((e) => log('⚠️ ventes co :', e.message));
    }

    if (CFG.keepOpen) { log('--keep-open : navigateur laisse ouvert (Ctrl+C pour quitter).'); await page.waitForTimeout(600000); }
  } catch (err) {
    await dumpDebug('erreur');
    fail(err.message);
  } finally {
    if (!CFG.keepOpen) await browser.close();
  }
}

// Execute seulement en lancement direct (pas a l'import — permet les tests unitaires)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main().catch((e) => fail(e.stack || e.message));

export { analyseJournal, readExport, parisYMD, syncSynergiaVentes, pushSynergia };
