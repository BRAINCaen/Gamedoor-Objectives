// Récupère en direct les DEUX exports CSV de la liste Devis 4escape, via un
// vrai navigateur (Playwright/Chromium). Renvoie { resume, detail } (textes CSV).
// Identifiants lus dans l'environnement — jamais en dur.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CFG = () => ({
  base: (process.env.FE_BASE || 'https://braincaen.4escape.io').replace(/\/+$/, ''),
  user: process.env.FE_USER || '',
  pass: process.env.FE_PASS || '',
  quotesPath: process.env.QUOTES_PATH || '/admin/statistics/quotes',
  headful: process.argv.includes('--headful'),
  debugDir: path.resolve(process.cwd(), 'debug'),
});

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function doExport(page, wantLabel, debugDir) {
  await page.locator('button:has-text("Export CSV"), a:has-text("Export CSV")').first().click();
  await page.waitForTimeout(600);
  const picked = await page.evaluate((want) => {
    const n = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const sel of document.querySelectorAll('select')) {
      const opt = [...sel.options].find((o) => n(o.textContent).includes(want));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    for (const el of document.querySelectorAll('li,a,div,span,option')) {
      if (n(el.textContent).includes(want)) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click?.(); return true; }
    }
    return false;
  }, norm(wantLabel));
  if (!picked) throw new Error(`Type d'export « ${wantLabel} » introuvable dans la modale.`);
  await page.waitForTimeout(400);
  const validate = page.locator(
    'button:has-text("Exporter"), button:has-text("Télécharger"), button:has-text("Valider"), button:has-text("Confirmer")'
  ).last();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    validate.click(),
  ]);
  const saved = path.join(debugDir, download.suggestedFilename() || 'export.csv');
  await download.saveAs(saved);
  return fs.readFileSync(saved, 'utf8');
}

export async function fetch4escape() {
  const cfg = CFG();
  if (!cfg.user || !cfg.pass) throw new Error('FE_USER / FE_PASS manquants');
  fs.mkdirSync(cfg.debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: !cfg.headful });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR' });
  const page = await context.newPage();
  try {
    // Login
    await page.goto(cfg.base + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"], #login-username', cfg.user);
    await page.fill('input[name="password"], #login-password', cfg.pass);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.locator('button[type="submit"]').first().click(),
    ]);
    await page.waitForTimeout(1200);
    if (/\/login(\?|$)/.test(page.url())) throw new Error('Connexion échouée (FE_USER / FE_PASS ?).');

    // Liste Devis
    await page.goto(cfg.base + cfg.quotesPath, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (/\/login(\?|$)/.test(page.url())) throw new Error(`La liste Devis (${cfg.quotesPath}) redirige vers /login.`);
    if (!(await page.locator('button:has-text("Export CSV"), a:has-text("Export CSV")').count()))
      throw new Error(`Pas de bouton « Export CSV » sur ${cfg.quotesPath} — définis QUOTES_PATH.`);

    const resume = await doExport(page, 'entetes de commande', cfg.debugDir);
    const detail = await doExport(page, 'lignes de commande', cfg.debugDir);
    return { resume, detail };
  } finally {
    await browser.close();
  }
}
