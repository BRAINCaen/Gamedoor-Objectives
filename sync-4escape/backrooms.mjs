// ============================================================================
//  GAMEDOOR °41 — Backrooms : retrouver les ventes d'une salle MASQUÉE 4escape
//  ---------------------------------------------------------------------------
//  La salle « PERDUS DANS LES BACKROOMS » est masquée dans l'onglet Rooms et ses
//  lignes n'apparaissent pas dans le Journal des ventes que le robot nocturne
//  exporte. On passe donc par l'export COMMANDES (« lignes de commande »), qui
//  porte la colonne « Room » pour toutes les commandes, salle masquée ou non.
//
//  1. /admin/rooms : inventaire des salles (noms, visibilité) -> logs
//  2. /admin/orders?mode=order : export « lignes de commande »
//  3. par jour : CA TTC Backrooms (date de commande, commandes honorées) et
//     sessions / joueurs (date d'évènement) ; comparaison avec le journal
//     (ttcBrut des journées en base) pour savoir si ces ventes Y SONT incluses
//  4. écriture : detail/backrooms de chaque journée concernée (source
//     'commandes', dansJournal vrai/faux) + résumé mensuel dans
//     state/autoMeta/analyse/backrooms. Le dashboard ne retire du CA affiché que
//     ce qui s'y trouve réellement.
//
//  Aucune donnée nominative n'est écrite (montants et comptages par jour).
//  Usage : node backrooms.mjs [--dry-run] [--headful]
//  Variables : ROOM_MATCH (motif, défaut backroom), ORDERS_PATH, FB_URL, FB_API_KEY
// ============================================================================

import { chromium } from 'playwright';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  apiKey: process.env.FB_API_KEY || 'AIzaSyDda_GKBMHyaVrT4vzosMZnri3hyFCCwYs',
  ordersPath: process.env.ORDERS_PATH || '/admin/orders?mode=order',
  roomMatch: new RegExp(process.env.ROOM_MATCH || 'back\\s*-?\\s*rooms?', 'i'),
  dryRun: process.argv.includes('--dry-run') || process.env.DRY_RUN === '1',
  headful: process.argv.includes('--headful'),
  debugDir: path.resolve(process.cwd(), 'debug'),
  tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'backrooms-4escape-')),
};
const log = (...m) => console.log(new Date().toISOString(), '·', ...m);
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => strip(s).toLowerCase().replace(/\s+/g, ' ').trim();
const numFR = (s) => { const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const dateISO = (s) => { const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; const i = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/); return i ? i[1] : null; };

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
function findCol(headers, ...res) {
  for (const re of res) { const i = headers.findIndex((h) => re.test(norm(h))); if (i >= 0) return i; }
  return -1;
}

const EXPORT_SEL = [
  'button:has-text("Export CSV")', 'a:has-text("Export CSV")', 'button:has-text("Exporter")', 'a:has-text("Exporter")',
  'button:has-text("Export")', 'a:has-text("Export")', 'button:has-text("CSV")', 'a:has-text("CSV")',
].join(', ');
async function login(page) {
  await page.goto(CFG.base + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], #login-username', CFG.user);
  await page.fill('input[name="password"], #login-password', CFG.pass);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}), page.click('button[type="submit"]')]);
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
async function exporter(page, chemin, wantType, label) {
  await page.goto(CFG.base + chemin, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (/\/login(\?|$)/.test(page.url())) throw new Error(`[${label}] ${chemin} redirige vers /login.`);
  if (!(await page.locator(EXPORT_SEL).count().catch(() => 0))) throw new Error(`[${label}] aucun bouton d'export sur ${chemin}.`);
  await closeModal(page);
  const direct = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.locator(EXPORT_SEL).first().click();
  const modale = await page.waitForFunction(() => document.querySelector('.modal.show'), null, { timeout: 6000 }).then(() => true).catch(() => false);
  let download;
  if (!modale) { download = await direct; if (!download) throw new Error(`[${label}] ni modale ni téléchargement.`); }
  else {
    await page.waitForTimeout(500);
    const root = (await page.locator('#modal-order-export').count().catch(() => 0)) ? '#modal-order-export' : '.modal.show';
    const types = await page.evaluate((sel) => { const s = document.querySelector(sel + ' select'); if (!s) return []; return [...s.options].map((o) => ({ value: o.value, label: (o.textContent || '').trim() })).filter((o) => o.label); }, root);
    if (types.length) {
      const want = norm(wantType); const pick = (want && types.find((t) => norm(t.label).includes(want))) || types[0];
      log(`[${label}] types d'export : ${types.map((t) => t.label).join(' | ')} → « ${pick.label} »`);
      await page.evaluate(({ sel, value }) => { const s = document.querySelector(sel + ' select'); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); }, { sel: root, value: pick.value });
      await page.waitForTimeout(300);
    }
    const validate = page.locator(`${root} button[type="submit"], ${root} button:has-text("Exporter"), ${root} button:has-text("Télécharger"), ${root} button:has-text("Valider")`).first();
    [download] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), validate.click()]);
  }
  const file = path.join(CFG.tmpDir, `${label}-${download.suggestedFilename() || 'export.csv'}`);
  await download.saveAs(file);
  const parsed = readExport(file);
  fs.rmSync(file, { force: true });
  await closeModal(page);
  log(`[${label}] ${parsed.rows.length} ligne(s) · colonnes : ${parsed.headers.join(' ; ')}`);
  return parsed;
}

// Inventaire des salles (onglet Rooms) : noms + visibilité, en tentant d'afficher
// aussi les salles masquées / archivées. Noms de salles uniquement.
async function inventaireSalles(page) {
  const out = [];
  try {
    await page.goto(CFG.base + '/admin/rooms', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const lire = () => page.evaluate(() => {
      const t = (e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
      const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(t).filter(Boolean).join(' · ').slice(0, 140));
      const cards = [...document.querySelectorAll('.card-title, .panel-title, h3, h4')].map(t).filter((s) => s && s.length < 80);
      const toggles = [...document.querySelectorAll('a, button, label')].map((e) => ({ txt: t(e).slice(0, 60), href: e.getAttribute('href') || '' }))
        .filter((x) => /masqu|archiv|inactiv|cach|hidden|tous|toutes|afficher/i.test(x.txt));
      return { rows, cards, toggles };
    });
    let inv = await lire();
    out.push(...inv.rows);
    if (inv.toggles.length) {
      log(`[rooms] filtres repérés : ${inv.toggles.map((x) => x.txt + (x.href ? ' -> ' + x.href : '')).join(' | ')}`);
      for (const tg of inv.toggles.slice(0, 3)) {
        try {
          if (tg.href && tg.href.startsWith('/')) await page.goto(CFG.base + tg.href, { waitUntil: 'domcontentloaded' });
          else await page.locator(`a:has-text("${tg.txt}"), button:has-text("${tg.txt}"), label:has-text("${tg.txt}")`).first().click({ timeout: 4000 });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
          inv = await lire();
          for (const r of inv.rows) if (!out.includes(r)) out.push(r);
        } catch { /* filtre non cliquable */ }
      }
    }
    if (!out.length && inv.cards.length) out.push(...inv.cards);
  } catch (e) { log('[rooms] inventaire impossible :', e.message.split('\n')[0]); }
  log(`[rooms] ${out.length} salle(s) listée(s) :`);
  for (const r of out.slice(0, 40)) log('   • ' + r);
  return out.slice(0, 60);
}

let FB_TOKEN = null;
async function ensureAuth() {
  if (FB_TOKEN) return;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${CFG.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  if (!r.ok) throw new Error(`Firebase : jeton anonyme refusé (HTTP ${r.status})`);
  FB_TOKEN = (await r.json()).idToken;
}
const rtdb = (p) => `${CFG.fbUrl}${p}?auth=${FB_TOKEN}`;

// ---------------------------------------------------------------------------
async function main() {
  if (!CFG.user || !CFG.pass) { console.error('❌ Identifiants manquants : définis FE_USER et FE_PASS.'); process.exitCode = 1; return; }
  fs.mkdirSync(CFG.debugDir, { recursive: true });
  const rapport = { le: new Date().toISOString(), motif: String(CFG.roomMatch) };
  const browser = await chromium.launch({ headless: !CFG.headful });
  const context = await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  try {
    log('Connexion à', CFG.base, '…'); await login(page); log('Connexion OK.');
    rapport.salles = await inventaireSalles(page);

    // --- Export des lignes de commande -----------------------------------------
    const ord = await exporter(page, CFG.ordersPath, 'lignes de commande', 'lignes');
    const O = ord.headers;
    const c = {
      ref: findCol(O, /^reference$/, /reference/), room: findCol(O, /^room$/, /salle/), prod: findCol(O, /^produit$/), cat: findCol(O, /categorie de produit/),
      ttc: findCol(O, /^montant ttc$/, /ttc/), qte: findCol(O, /^quantite$/), dCmd: findCol(O, /date commande/, /date validation/, /created on/),
      dEvt: findCol(O, /date evenement/), st: findCol(O, /^status$/, /statut/), soc: findCol(O, /est societe/),
    };
    for (const [k, i] of Object.entries(c)) if (i < 0 && !['soc', 'cat', 'qte'].includes(k)) throw new Error(`Export commandes : colonne « ${k} » introuvable (${O.join(' ; ')})`);
    rapport.colonnes = O;

    const rooms = new Map();                      // toutes les salles vues dans les commandes (contrôle)
    const byCmd = {}, byEvt = {}, allByCmd = {};  // Backrooms par date de commande / d'évènement ; tout par date de commande
    let lignesBR = 0, refusees = 0, refunded = 0;
    for (const r of ord.rows) {
      const st = norm(r[c.st]);
      const honoree = /completed|refunded/.test(st);
      const room = String(r[c.room] || '').trim(), prod = String(r[c.prod] || '').trim();
      const ttc = numFR(r[c.ttc]), qte = c.qte >= 0 ? numFR(r[c.qte]) : 0;
      const dC = dateISO(r[c.dCmd]), dE = dateISO(r[c.dEvt]);
      if (room) { const t = rooms.get(room) || { n: 0, ttc: 0 }; t.n++; if (honoree) t.ttc += ttc; rooms.set(room, t); }
      if (!honoree) { if (CFG.roomMatch.test(room + ' ' + prod)) refusees++; continue; }
      if (dC) allByCmd[dC] = r2((allByCmd[dC] || 0) + ttc);
      if (!CFG.roomMatch.test(room + ' ' + prod)) continue;
      lignesBR++; if (/refunded/.test(st)) refunded++;
      const isRoomLine = !!room;
      if (dC) { const b = byCmd[dC] = byCmd[dC] || { ca: 0, refs: new Set(), joueurs: 0, labels: new Set(), pro: 0 }; b.ca = r2(b.ca + ttc); b.labels.add((room || prod).slice(0, 60)); if (isRoomLine) { b.refs.add(String(r[c.ref])); b.joueurs += qte; } if (c.soc >= 0 && /oui/i.test(String(r[c.soc]))) b.pro++; }
      if (dE && isRoomLine) { const e = byEvt[dE] = byEvt[dE] || { refs: new Set(), joueurs: 0, ca: 0 }; e.refs.add(String(r[c.ref])); e.joueurs += qte; e.ca = r2(e.ca + ttc); }
    }
    log(`Salles vues dans les commandes : ${[...rooms.entries()].sort((a, b) => b[1].ttc - a[1].ttc).map(([n, t]) => `${n} (${t.n} lignes, ${Math.round(t.ttc)} €)`).join(' · ')}`);
    const jours = Object.keys(byCmd).sort();
    const totalBR = r2(jours.reduce((a, d) => a + byCmd[d].ca, 0));
    log(`Backrooms (motif ${CFG.roomMatch}) : ${lignesBR} ligne(s) honorée(s) sur ${jours.length} jour(s) de commande, ${totalBR} € TTC (dont ${refunded} ligne(s) remboursée(s)) · ${refusees} ligne(s) non honorée(s) ignorée(s)`);
    if (!jours.length) { log('Aucune commande Backrooms trouvée : rien à écrire.'); rapport.resultat = 'aucune commande'; return; }
    log(`Période : ${jours[0]} → ${jours[jours.length - 1]}`);
    const parMois = {};
    for (const d of jours) { const mk = d.slice(0, 7); const p = parMois[mk] = parMois[mk] || { ca: 0, sessionsVendues: 0, joueursVendus: 0, sessions: 0, joueurs: 0 }; p.ca = r2(p.ca + byCmd[d].ca); p.sessionsVendues += byCmd[d].refs.size; p.joueursVendus += byCmd[d].joueurs; }
    for (const d of Object.keys(byEvt)) { const mk = d.slice(0, 7); const p = parMois[mk] = parMois[mk] || { ca: 0, sessionsVendues: 0, joueursVendus: 0, sessions: 0, joueurs: 0 }; p.sessions += byEvt[d].refs.size; p.joueurs += byEvt[d].joueurs; }
    for (const [mk, p] of Object.entries(parMois).sort()) log(`  ${mk} : ${p.ca} € vendus (${p.sessionsVendues} sessions, ${p.joueursVendus} joueurs) · ${p.sessions} session(s) jouée(s), ${p.joueurs} joueurs`);

    // --- Ces ventes sont-elles dans le journal (donc dans le CA du dashboard) ? ---
    await ensureAuth();
    const entries = (await (await fetch(rtdb('/state/entries.json'))).json()) || {};
    const keyOf = new Map(), ttcOf = new Map();
    for (const [k, e] of Object.entries(entries)) if (e && e.date) { keyOf.set(e.date, k); ttcOf.set(e.date, (e.detail && e.detail.vendu && e.detail.vendu.ttcBrut) ?? null); }
    let avec = 0, sans = 0, n = 0; const exemples = [];
    for (const d of jours) {
      const j = ttcOf.get(d); if (j == null) continue;
      const all = allByCmd[d] || 0, br = byCmd[d].ca;
      const eAvec = Math.abs(j - all), eSans = Math.abs(j - (all - br));
      avec += eAvec; sans += eSans; n++;
      if (exemples.length < 12) exemples.push(`${d} : journal ${Math.round(j)} € · commandes ${Math.round(all)} € dont Backrooms ${Math.round(br)} €`);
    }
    const dansJournal = n > 0 ? avec <= sans : false;
    log(`Comparaison journal / commandes sur ${n} jour(s) Backrooms : écart cumulé si incluses ${Math.round(avec)} € · si exclues ${Math.round(sans)} € → les ventes Backrooms ${dansJournal ? 'SONT' : 'NE SONT PAS'} dans le journal (donc ${dansJournal ? 'dans' : 'hors du'} CA affiché).`);
    for (const x of exemples) log('   ' + x);
    rapport.dansJournal = dansJournal; rapport.parMois = parMois; rapport.total = totalBR; rapport.exemples = exemples;
    fs.writeFileSync(path.join(CFG.debugDir, 'backrooms-report.json'), JSON.stringify(rapport, null, 2));
    if (CFG.dryRun) { log('DRY-RUN : rien écrit dans Firebase.'); return; }

    // --- Écriture : detail/backrooms par journée + résumé ------------------------
    const dates = [...new Set([...jours, ...Object.keys(byEvt)])].sort();
    let done = 0, absent = 0, ko = 0;
    for (const d of dates) {
      const key = keyOf.get(d); if (!key) { absent++; continue; }
      const b = byCmd[d], e = byEvt[d];
      const detail = {
        ca: b ? b.ca : 0, brut: b ? b.ca : 0, remises: 0, sessionsVendues: b ? b.refs.size : 0, joueursVendus: b ? b.joueurs : 0,
        sessions: e ? e.refs.size : 0, joueurs: e ? e.joueurs : 0, caJoue: e ? e.ca : 0,
        labels: b ? [...b.labels].slice(0, 4) : ['PERDUS DANS LES BACKROOMS'], source: 'commandes', dansJournal,
      };
      const res = await fetch(rtdb(`/state/entries/${key}/detail/backrooms.json`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(detail) });
      if (res.ok) done++; else { ko++; if (ko <= 5) log(`⚠️ ${d} : PUT ${res.status} ${(await res.text()).slice(0, 120)}`); }
    }
    const resume = { majLe: new Date().toISOString(), salle: [...new Set(jours.flatMap((d) => [...byCmd[d].labels]))].slice(0, 4), motif: String(CFG.roomMatch), dansJournal, total: totalBR, periode: [jours[0], jours[jours.length - 1]], parMois, salles: rapport.salles.slice(0, 40) };
    const w = await fetch(rtdb('/state/autoMeta/analyse/backrooms.json'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resume) });
    log(`✅ ${done} journée(s) écrite(s), ${absent} absente(s) de la base, ${ko} échec(s) · résumé ${w.ok ? 'écrit' : 'NON écrit (' + w.status + ')'} dans autoMeta/analyse/backrooms.`);
  } catch (e) {
    console.error('\n❌ ' + e.message);
    rapport.erreur = e.message;
    fs.writeFileSync(path.join(CFG.debugDir, 'backrooms-report.json'), JSON.stringify(rapport, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
    fs.rmSync(CFG.tmpDir, { recursive: true, force: true });
  }
}
main();
