// ============================================================================
//  GAMEDOOR °41 — D'où viennent nos joueurs ? (codes postaux -> dashboard)
//  ---------------------------------------------------------------------------
//  1. Export de la liste CLIENTS de 4escape (/admin/customers) : code postal,
//     ville, pays. L'e-mail ne sert QUE de clé de jointure en mémoire, il n'est
//     jamais écrit nulle part.
//  2. (si disponible) Export des COMMANDES (/admin/orders, « entêtes de
//     commande ») : pour chaque commande honorée -> date d'évènement, joueurs,
//     montant, société. Jointure par e-mail -> code postal du client.
//  3. Agrégation PAR CODE POSTAL (clients, commandes, joueurs, CA, par année),
//     géocodage via geo.api.gouv.fr (gratuit, sans clé, mis en cache dans le
//     RTDB) et écriture dans state/autoMeta/analyse/origines.
//
//  Rien de nominatif n'est écrit : uniquement des comptages par code postal.
//  Les fichiers téléchargés sont rangés hors de debug/ et détruits à la fin.
//
//  Usage : node origines.mjs [--dry-run] [--headful]    (FE_USER / FE_PASS requis)
//  Variables optionnelles : CUSTOMERS_PATH (/admin/customers), ORDERS_PATH
//  (/admin/orders), CUSTOMERS_EXPORT_TYPE, ORDERS_EXPORT_TYPE (libellé dans la
//  modale d'export), FB_URL, FB_API_KEY.
// ============================================================================

import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// .env local (tests sur PC — jamais commité)
try {
  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* facultatif */ }

const CFG = {
  base: (process.env.FE_BASE || 'https://braincaen.4escape.io').replace(/\/+$/, ''),
  user: process.env.FE_USER || '',
  pass: process.env.FE_PASS || '',
  fbUrl: (process.env.FB_URL || 'https://gamedoor-objectives-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, ''),
  apiKey: process.env.FB_API_KEY || 'AIzaSyDda_GKBMHyaVrT4vzosMZnri3hyFCCwYs',   // clé web publique (déjà dans index.html)
  customersPath: process.env.CUSTOMERS_PATH || '/admin/customers',
  ordersPath: process.env.ORDERS_PATH || '/admin/orders',
  customersType: process.env.CUSTOMERS_EXPORT_TYPE || '',          // vide = premier type proposé
  ordersType: process.env.ORDERS_EXPORT_TYPE || 'entetes de commande',
  dryRun: process.argv.includes('--dry-run') || process.env.DRY_RUN === '1',
  headful: process.argv.includes('--headful'),
  debugDir: path.resolve(process.cwd(), 'debug'),
  tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'origines-4escape-')),
};
const log = (...m) => console.log(new Date().toISOString(), '·', ...m);
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => strip(s).toLowerCase().replace(/\s+/g, ' ').trim();
const numFR = (s) => { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Lecture d'un export
// ---------------------------------------------------------------------------
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
  let aoa;
  if (/\.csv$/i.test(filePath)) {
    let text = fs.readFileSync(filePath, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const first = text.split(/\r?\n/)[0] || '';
    aoa = parseCSV(text, first.split(';').length >= first.split(',').length ? ';' : ',');
  } else {
    const wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
    aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }
  aoa = aoa.filter((r) => r.some((c) => String(c).trim() !== ''));
  return { headers: (aoa[0] || []).map((h) => String(h).trim()), rows: aoa.slice(1) };
}
// Première colonne dont l'en-tête correspond à l'une des expressions (dans l'ordre).
function findCol(headers, ...res) {
  for (const re of res) { const i = headers.findIndex((h) => re.test(norm(h))); if (i >= 0) return i; }
  return -1;
}
const dateFRtoISO = (s) => { const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

// ---------------------------------------------------------------------------
// 4escape : connexion + export générique (modale « type d'export » ou direct)
// ---------------------------------------------------------------------------
const EXPORT_SEL = [
  'button:has-text("Export CSV")', 'a:has-text("Export CSV")', 'button:has-text("Exporter")', 'a:has-text("Exporter")',
  'button:has-text("Export")', 'a:has-text("Export")', 'button:has-text("CSV")', 'a:has-text("CSV")',
].join(', ');

async function login(page) {
  await page.goto(CFG.base + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], #login-username', CFG.user);
  await page.fill('input[name="password"], #login-password', CFG.pass);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  if (/\/login(\?|$)/.test(page.url())) throw new Error('Connexion échouée (toujours sur /login) — vérifie FE_USER / FE_PASS.');
}
async function closeModal(page) {
  if (!(await page.locator('.modal.show').count().catch(() => 0))) return;
  await page.locator('.modal.show [data-dismiss="modal"], .modal.show .close').first().click({ timeout: 4000 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
  await page.waitForFunction(() => !document.querySelector('.modal.show'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
}
// Va sur l'écran, clique « Exporter », choisit le type demandé (si modale),
// télécharge, parse, supprime le fichier. Renvoie { headers, rows }.
async function exporter(page, chemin, wantType, label) {
  await page.goto(CFG.base + chemin, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (/\/login(\?|$)/.test(page.url())) throw new Error(`[${label}] ${chemin} redirige vers /login (écran inexistant ou droits insuffisants).`);
  if (!(await page.locator(EXPORT_SEL).count().catch(() => 0))) {
    const boutons = await page.evaluate(() => [...new Set([...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 50)).filter(Boolean))].slice(0, 30));
    throw new Error(`[${label}] aucun bouton d'export sur ${chemin}. Boutons vus : ${boutons.join(' | ')}`);
  }
  await closeModal(page);
  const direct = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.locator(EXPORT_SEL).first().click();
  const modale = await page.waitForFunction(() => document.querySelector('.modal.show'), null, { timeout: 6000 }).then(() => true).catch(() => false);
  let download;
  if (!modale) {
    download = await direct;
    if (!download) throw new Error(`[${label}] clic sur Exporter : ni modale ni téléchargement.`);
  } else {
    await page.waitForTimeout(500);
    const root = (await page.locator('#modal-order-export').count().catch(() => 0)) ? '#modal-order-export' : '.modal.show';
    const types = await page.evaluate((sel) => {
      const s = document.querySelector(sel + ' select'); if (!s) return [];
      return [...s.options].map((o) => ({ value: o.value, label: (o.textContent || '').trim() })).filter((o) => o.label);
    }, root);
    if (types.length) {
      const want = norm(wantType);
      const pick = (want && types.find((t) => norm(t.label).includes(want))) || types[0];
      log(`[${label}] types d'export : ${types.map((t) => t.label).join(' | ')} → « ${pick.label} »`);
      await page.evaluate(({ sel, value }) => { const s = document.querySelector(sel + ' select'); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); }, { sel: root, value: pick.value });
      await page.waitForTimeout(300);
    }
    const validate = page.locator(`${root} button[type="submit"], ${root} button:has-text("Exporter"), ${root} button:has-text("Télécharger"), ${root} button:has-text("Valider")`).first();
    [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), validate.click()]);
  }
  const file = path.join(CFG.tmpDir, `${label}-${download.suggestedFilename() || 'export.csv'}`);
  await download.saveAs(file);
  const parsed = readExport(file);
  fs.rmSync(file, { force: true });
  await closeModal(page);
  log(`[${label}] ${parsed.rows.length} ligne(s) · colonnes : ${parsed.headers.join(' ; ')}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Firebase (auth anonyme, comme le dashboard et le robot)
// ---------------------------------------------------------------------------
let FB_TOKEN = null;
async function ensureAuth() {
  if (FB_TOKEN) return;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${CFG.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`Firebase : jeton anonyme refusé (HTTP ${r.status})`);
  FB_TOKEN = (await r.json()).idToken;
}
const rtdb = (p) => `${CFG.fbUrl}${p}?auth=${FB_TOKEN}`;

// ---------------------------------------------------------------------------
// Géocodage des codes postaux (geo.api.gouv.fr) avec cache RTDB
// ---------------------------------------------------------------------------
async function geocode(cp, cache) {
  if (cache[cp]) return cache[cp];
  const q = (u) => fetch(u, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  let communes = await q(`https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=nom,centre,population,codeDepartement&format=json`);
  let approx = false;
  if (!communes.length) {              // CEDEX, code postal spécial : on retombe sur le chef-lieu du département
    const dep = cp.startsWith('20') ? (Number(cp) < 20200 ? '2A' : '2B') : cp.slice(0, 2);
    communes = await q(`https://geo.api.gouv.fr/communes?codeDepartement=${dep}&fields=nom,centre,population,codeDepartement&format=json`);
    approx = true;
  }
  if (!communes.length) return null;
  const c = communes.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  const geo = { ville: c.nom, dep: c.codeDepartement || cp.slice(0, 2), lat: r2(c.centre.coordinates[1] * 100) / 100, lon: r2(c.centre.coordinates[0] * 100) / 100 };
  if (communes.length > 1 && !approx) geo.communes = communes.length;   // plusieurs communes pour ce CP
  if (approx) geo.approx = true;
  cache[cp] = geo;
  await sleep(60);
  return geo;
}

// ---------------------------------------------------------------------------
async function main() {
  if (!CFG.user || !CFG.pass) { console.error('❌ Identifiants manquants : définis FE_USER et FE_PASS.'); process.exitCode = 1; return; }
  fs.mkdirSync(CFG.debugDir, { recursive: true });
  const rapport = { le: new Date().toISOString(), etapes: [] };
  const browser = await chromium.launch({ headless: !CFG.headful });
  const context = await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  try {
    log('Connexion à', CFG.base, '…'); await login(page); log('Connexion OK.');

    // --- 1) Clients -> code postal ------------------------------------------
    const cli = await exporter(page, CFG.customersPath, CFG.customersType, 'clients');
    const H = cli.headers;
    const iMail = findCol(H, /^e-?mail$/, /mail/);
    const iCP = findCol(H, /code ?postal/, /^cp$/, /postal/, /zip/);
    const iVille = findCol(H, /^ville$/, /ville|city|commune/);
    const iPays = findCol(H, /^pays$/, /pays|country/);
    const iSoc = findCol(H, /^societe$/, /societe|entreprise|company/);
    rapport.etapes.push({ etape: 'clients', lignes: cli.rows.length, colonnes: H, colonneCP: iCP >= 0 ? H[iCP] : null, colonneEmail: iMail >= 0 ? H[iMail] : null });
    if (iCP < 0) throw new Error(`Export clients : aucune colonne de code postal reconnue. Colonnes : ${H.join(' ; ')}\n` +
      `➜ Si le code postal est ailleurs (autre type d'export, autre écran), renseigne CUSTOMERS_EXPORT_TYPE / CUSTOMERS_PATH.`);

    const cpOf = (v) => { const s = String(v || '').replace(/\s/g, '').toUpperCase(); return /^\d{5}$/.test(s) ? s : (s ? 'ETR' : ''); };
    const safeKey = (s) => s.replace(/[.#$\[\]\/]/g, '_');
    const parCP = {}; const etranger = {};
    const bucket = (cp, pays) => {
      if (cp === 'ETR') { const k = safeKey((pays || 'Pays inconnu').trim().slice(0, 40)) || 'Pays inconnu'; return etranger[k] = etranger[k] || { clients: 0, commandes: 0, joueurs: 0, ca: 0 }; }
      return parCP[cp] = parCP[cp] || { clients: 0, commandes: 0, joueurs: 0, ca: 0, parAnnee: {} };
    };
    const mailToCP = new Map(); let avecCP = 0;
    for (const r of cli.rows) {
      const cp = cpOf(r[iCP]); if (!cp) continue;
      avecCP++;
      const pays = iPays >= 0 ? String(r[iPays]).trim() : '';
      // Un pays étranger renseigné avec un CP à 5 chiffres (ex. Belgique 1000x) -> étranger
      const isFR = !pays || /^(fr|france|fra)$/i.test(pays);
      const b = bucket(isFR ? cp : 'ETR', pays); b.clients++;
      const mail = iMail >= 0 ? norm(r[iMail]) : '';
      if (mail) mailToCP.set(mail, isFR ? cp : ['ETR', pays]);
    }
    log(`Clients : ${cli.rows.length} · avec code postal : ${avecCP} · codes postaux distincts : ${Object.keys(parCP).length} · étranger : ${Object.keys(etranger).length} pays`);

    // --- 2) Commandes (facultatif) -> joueurs / CA par code postal et par année ---
    let commandes = null;
    try {
      const ord = await exporter(page, CFG.ordersPath, CFG.ordersType, 'commandes');
      const O = ord.headers;
      const oMail = findCol(O, /contact e-?mail/, /^e-?mail$/, /mail/);
      const oDate = findCol(O, /date ?evenement/, /date ?validation/, /date ?commande/, /created/);
      const oStat = findCol(O, /^status$/, /statut/);
      const oJou = findCol(O, /nombre de joueurs/, /joueurs/);
      const oTTC = findCol(O, /montant ttc/, /^ttc$/);
      const oSoc = findCol(O, /est societe/, /^societe$/);
      rapport.etapes.push({ etape: 'commandes', lignes: ord.rows.length, colonnes: O });
      if (oMail < 0 || oDate < 0) throw new Error(`colonnes e-mail / date introuvables (${O.join(' ; ')})`);
      let jointes = 0, sansCP = 0, ignorees = 0;
      for (const r of ord.rows) {
        const st = oStat >= 0 ? norm(r[oStat]) : 'completed';
        if (st && !/completed|refunded|termin|honor|pay/.test(st)) { ignorees++; continue; }   // commandes honorées seulement
        const iso = dateFRtoISO(r[oDate]) || (String(r[oDate]).match(/^\d{4}-\d{2}-\d{2}/) || [null])[0];
        if (!iso) { ignorees++; continue; }
        const dest = mailToCP.get(norm(r[oMail]));
        if (!dest) { sansCP++; continue; }
        const b = Array.isArray(dest) ? bucket('ETR', dest[1]) : bucket(dest, '');
        const jou = oJou >= 0 ? Math.round(numFR(r[oJou])) : 0, ttc = oTTC >= 0 ? numFR(r[oTTC]) : 0;
        b.commandes++; b.joueurs += jou; b.ca = r2(b.ca + ttc);
        if (b.parAnnee) { const y = iso.slice(0, 4); const a = b.parAnnee[y] = b.parAnnee[y] || [0, 0, 0]; a[0]++; a[1] += jou; a[2] = r2(a[2] + ttc); }
        jointes++;
      }
      commandes = { total: ord.rows.length, jointes, sansCP, ignorees };
      log(`Commandes : ${ord.rows.length} · honorées et rattachées à un code postal : ${jointes} · sans client connu : ${sansCP} · non honorées : ${ignorees}`);
    } catch (e) {
      log(`ℹ️  Commandes non exploitées (${String(e.message).split('\n')[0].slice(0, 160)}) → la carte se base sur les clients.`);
      rapport.etapes.push({ etape: 'commandes', erreur: String(e.message).split('\n')[0].slice(0, 200) });
    }

    // --- 3) Géocodage + écriture -------------------------------------------
    await ensureAuth();
    let cache = {};
    try { const r = await fetch(rtdb('/state/autoMeta/analyse/geo.json')); if (r.ok) cache = (await r.json()) || {}; } catch { /* premier passage */ }
    const avant = Object.keys(cache).length;
    let introuvables = 0;
    for (const cp of Object.keys(parCP)) {
      const g = await geocode(cp, cache);
      if (!g) { introuvables++; continue; }
      Object.assign(parCP[cp], { ville: g.ville, dep: g.dep, lat: g.lat, lon: g.lon }, g.approx ? { approx: true } : {});
    }
    log(`Géocodage : ${Object.keys(cache).length - avant} nouveau(x) code(s) postal(aux) résolu(s), ${introuvables} introuvable(s) (ignorés sur la carte).`);
    for (const cp of Object.keys(parCP)) if (parCP[cp].lat == null) delete parCP[cp];

    const totaux = Object.values(parCP).reduce((t, b) => ({ clients: t.clients + b.clients, commandes: t.commandes + b.commandes, joueurs: t.joueurs + b.joueurs, ca: r2(t.ca + b.ca) }), { clients: 0, commandes: 0, joueurs: 0, ca: 0 });
    const annees = [...new Set(Object.values(parCP).flatMap((b) => Object.keys(b.parAnnee || {})))].sort();
    const origines = {
      majLe: new Date().toISOString(),
      source: { clients: cli.rows.length, clientsAvecCP: avecCP, commandes },
      annees, totaux, parCP, etranger,
    };
    const top = Object.entries(parCP).sort((a, b) => (b[1].commandes || b[1].clients) - (a[1].commandes || a[1].clients)).slice(0, 8);
    log('Top codes postaux : ' + top.map(([cp, b]) => `${cp} ${b.ville} (${b.commandes || b.clients})`).join(' · '));
    fs.writeFileSync(path.join(CFG.debugDir, 'origines-report.json'), JSON.stringify({ ...rapport, totaux, annees, nbCP: Object.keys(parCP).length }, null, 2));

    if (CFG.dryRun) { log('DRY-RUN : rien écrit dans Firebase.'); return; }
    const w1 = await fetch(rtdb('/state/autoMeta/analyse/origines.json'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(origines) });
    if (!w1.ok) throw new Error(`Écriture origines refusée : HTTP ${w1.status} ${(await w1.text()).slice(0, 200)}`);
    const w2 = await fetch(rtdb('/state/autoMeta/analyse/geo.json'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cache) });
    if (!w2.ok) log(`⚠️ cache géo non enregistré : HTTP ${w2.status}`);
    log(`✅ Écrit : state/autoMeta/analyse/origines (${Object.keys(parCP).length} codes postaux, ${totaux.commandes} commandes, ${totaux.joueurs} joueurs).`);
  } catch (e) {
    console.error('\n❌ ' + e.message);
    rapport.erreur = e.message;
    fs.writeFileSync(path.join(CFG.debugDir, 'origines-report.json'), JSON.stringify(rapport, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
    fs.rmSync(CFG.tmpDir, { recursive: true, force: true });
  }
}
main();
