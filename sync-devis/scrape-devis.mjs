// ============================================================================
//  GAMEDOOR·41 CRM — SONDE D'EXPORT DES DEVIS 4escape  (étape de validation)
//  ---------------------------------------------------------------------------
//  BUT DE CE SCRIPT : lever l'incertitude AVANT d'écrire la vraie synchro.
//  Il se connecte à 4escape, ouvre la liste « Devis », déclenche les DEUX
//  exports CSV (« entêtes de commande » = résumé, « lignes de commande » =
//  détail) et AFFICHE leurs colonnes + un aperçu. Il n'écrit RIEN nulle part
//  (ni fichier durable au-delà de /debug, ni base). C'est une sonde, pas la
//  synchro.
//
//  RÉUTILISE la mécanique éprouvée du robot Gamedoor-Objectives (login,
//  événement download Playwright).
//
//  UTILISATION (sur TON PC, jamais besoin de me donner ton mot de passe) :
//    1. cd sync-devis
//    2. npm install
//    3. npx playwright install --with-deps chromium
//    4. Crée un fichier .env (voir .env.example) avec FE_USER / FE_PASS
//    5. node scrape-devis.mjs --headful         (voir le navigateur agir)
//       ou  node scrape-devis.mjs               (invisible, headless)
//    6. Copie-moi la sortie « COLONNES » des deux exports.
// ============================================================================

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 0) .env local (jamais commité — voir .gitignore)
// ---------------------------------------------------------------------------
try {
  const envFile = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const CFG = {
  base:    (process.env.FE_BASE || 'https://braincaen.4escape.io').replace(/\/+$/, ''),
  user:     process.env.FE_USER || '',
  pass:     process.env.FE_PASS || '',
  // Chemin de la liste Devis. Sondé le 31/08/2026 : /admin/statistics/quotes
  // existe. Surchargée-able si besoin via QUOTES_PATH dans .env.
  quotesPath: process.env.QUOTES_PATH || '/admin/statistics/quotes',
  headful:  process.argv.includes('--headful'),
  keepOpen: process.argv.includes('--keep-open'),
  debugDir: path.resolve(process.cwd(), 'debug'),
};

const log = (...a) => console.log('·', ...a);
const die = (m) => { console.error('\n❌ ' + m + '\n'); process.exit(1); };

fs.mkdirSync(CFG.debugDir, { recursive: true });

// Parseur CSV identique à celui du CRM (séparateur ';', guillemets doublés,
// retours ligne dans les champs) — pour lire ce qu'on vient de télécharger.
function parseCSV(txt) {
  txt = txt.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ';') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Ouvre la modale « Exporter », choisit un type par son libellé, et capte le
// fichier téléchargé. Renvoie { name, text }.
async function doExport(page, wantLabel) {
  // Ré-ouvrir l'écran propre à chaque export
  await page.locator('button:has-text("Export CSV"), a:has-text("Export CSV")').first().click();
  await page.waitForTimeout(600);

  // Choisir le type d'export dans la modale (select ou liste déroulante custom)
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const picked = await page.evaluate((want) => {
    const n = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // cas 1 : vrai <select>
    for (const sel of document.querySelectorAll('select')) {
      const opt = [...sel.options].find((o) => n(o.textContent).includes(want));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'select'; }
    }
    // cas 2 : liste déroulante custom (li / a)
    for (const el of document.querySelectorAll('li,a,div,span,option')) {
      if (n(el.textContent) === want || n(el.textContent).includes(want)) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.click?.();
        return 'custom';
      }
    }
    return null;
  }, norm(wantLabel));
  if (!picked) { await dump(page, 'export-type-introuvable'); die(`Type d'export « ${wantLabel} » introuvable dans la modale.`); }
  log(`  type d'export réglé (${picked}) : « ${wantLabel} »`);
  await page.waitForTimeout(400);

  // Valider : bouton Exporter / Télécharger / Valider dans la modale
  const validate = page.locator(
    'button:has-text("Exporter"), button:has-text("Télécharger"), button:has-text("Valider"), button:has-text("Confirmer")'
  ).last();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    validate.click(),
  ]);
  const suggested = download.suggestedFilename() || 'export.csv';
  const saved = path.join(CFG.debugDir, suggested);
  await download.saveAs(saved);
  const text = fs.readFileSync(saved, 'utf8');
  log(`  téléchargé : ${suggested} (${(text.length / 1024).toFixed(1)} Ko)`);
  return { name: suggested, text };
}

async function dump(page, tag) {
  try {
    await page.screenshot({ path: path.join(CFG.debugDir, `${tag}.png`), fullPage: true });
    fs.writeFileSync(path.join(CFG.debugDir, `${tag}.html`), await page.content());
    log(`  (debug enregistré : debug/${tag}.png + .html)`);
  } catch {}
}

function apercu(label, text) {
  const rows = parseCSV(text).filter((r) => r.length > 1);
  const head = (rows[0] || []).map((h) => h.trim());
  console.log(`\n================= ${label} =================`);
  console.log(`Lignes (hors entête) : ${Math.max(0, rows.length - 1)}`);
  console.log(`COLONNES (${head.length}) :`);
  head.forEach((h, i) => console.log(`   [${i}] ${h}`));
  if (rows[1]) {
    console.log('Exemple 1re ligne :');
    head.forEach((h, i) => console.log(`   ${h} = ${rows[1][i] || ''}`));
  }
}

(async () => {
  if (!CFG.user || !CFG.pass) die('Identifiants manquants : renseigne FE_USER et FE_PASS dans .env');

  const browser = await chromium.launch({ headless: !CFG.headful });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR' });
  const page = await context.newPage();

  try {
    // 1) Login
    log('Connexion à', CFG.base + '/login …');
    await page.goto(CFG.base + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"], #login-username', CFG.user);
    await page.fill('input[name="password"], #login-password', CFG.pass);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.locator('button[type="submit"]').first().click(),
    ]);
    await page.waitForTimeout(1200);
    if (/\/login(\?|$)/.test(page.url())) { await dump(page, 'login-echec'); die('Connexion échouée (toujours sur /login). Vérifie FE_USER / FE_PASS.'); }
    log('Connecté ✓');

    // 2) Liste des devis
    log('Ouverture de la liste Devis :', CFG.base + CFG.quotesPath);
    await page.goto(CFG.base + CFG.quotesPath, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (/\/login(\?|$)/.test(page.url())) { await dump(page, 'devis-redirige-login'); die('La liste Devis redirige vers /login (droits insuffisants ?).'); }

    const hasExport = await page.locator('button:has-text("Export CSV"), a:has-text("Export CSV")').count();
    if (!hasExport) {
      await dump(page, 'devis-sans-export');
      die(`Pas de bouton « Export CSV » sur ${CFG.quotesPath}. Ce n'est pas le bon écran — ` +
          `ouvre la liste Devis à la main, copie-moi son URL, et relance avec QUOTES_PATH=<url> dans .env.`);
    }
    log('Écran Devis trouvé (bouton Export CSV présent) ✓');

    // 3) Les deux exports
    log('Export 1/2 : résumé (entêtes de commande)…');
    const resume = await doExport(page, 'entetes de commande');
    log('Export 2/2 : détail (lignes de commande)…');
    const detail = await doExport(page, 'lignes de commande');

    // 4) Aperçu des colonnes (c'est CE que j'ai besoin de voir)
    apercu('EXPORT RÉSUMÉ (entêtes de commande)', resume.text);
    apercu('EXPORT DÉTAIL (lignes de commande)', detail.text);

    console.log('\n✅ Sonde terminée. Les fichiers bruts sont dans sync-devis/debug/.');
    console.log('   → Copie-moi le bloc « COLONNES » des DEUX exports ci-dessus.');
  } catch (e) {
    await dump(page, 'erreur');
    die('Erreur : ' + e.message);
  } finally {
    if (CFG.keepOpen) { log('(--keep-open : fenêtre laissée ouverte, Ctrl+C pour quitter)'); await new Promise(() => {}); }
    await browser.close();
  }
})();
