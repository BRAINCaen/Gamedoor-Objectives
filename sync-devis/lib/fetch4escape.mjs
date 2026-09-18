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

// Libellés possibles du bouton d'export : 4escape a pu changer l'intitulé.
const EXPORT_SEL = [
  'button:has-text("Export CSV")', 'a:has-text("Export CSV")',
  'button:has-text("Exporter")',   'a:has-text("Exporter")',
  'button:has-text("Export")',     'a:has-text("Export")',
  'button:has-text("CSV")',        'a:has-text("CSV")',
].join(', ');

async function hasExport(page) {
  try { return (await page.locator(EXPORT_SEL).count()) > 0; } catch { return false; }
}

// Photographie la page pour comprendre après coup (uploadé en artefact par le workflow).
async function snapshot(page, dir, nom) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, nom + '.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(dir, nom + '.html'), await page.content(), 'utf8');
  } catch { /* le debug ne doit jamais faire échouer la synchro */ }
}

// Liste ce que la page propose réellement — pour que l'erreur soit exploitable.
async function inventaire(page) {
  return page.evaluate(() => {
    const t = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const uniq = (a) => [...new Set(a.filter(Boolean))].slice(0, 40);
    return {
      url: location.pathname,
      boutons: uniq([...document.querySelectorAll('button')].map(t)),
      liens: uniq([...document.querySelectorAll('a')]
        .map((a) => (t(a) ? t(a) + ' -> ' + a.getAttribute('href') : ''))),
    };
  });
}

// Parcourt le menu d'administration à la recherche de l'écran des devis.
async function decouvrirDevis(page, base, debugDir) {
  const vus = new Set();
  const candidats = [];

  for (const p of ['/admin', '/admin/statistics', '/admin/orders']) {
    try {
      await page.goto(base + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(500);
      const liens = await page.evaluate(() =>
        [...document.querySelectorAll('a')].map((a) => ({
          href: a.getAttribute('href') || '',
          txt: (a.textContent || '').replace(/\s+/g, ' ').trim(),
        })));
      for (const l of liens) {
        if (!l.href.startsWith('/admin')) continue;
        const cle = norm(l.txt) + '|' + l.href;
        if (vus.has(cle)) continue;
        vus.add(cle);
        if (/devis|quote/.test(norm(l.txt)) || /devis|quote/.test(l.href.toLowerCase()))
          candidats.push(l.href);
      }
    } catch { /* page absente : on continue */ }
  }

  // Chemins connus, testés même si aucun lien ne les mentionne.
  for (const p of ['/admin/statistics/quotes', '/admin/quotes', '/admin/orders',
                   '/admin/statistics/orders', '/admin/devis'])
    if (!candidats.includes(p)) candidats.push(p);

  const rapport = [];
  for (const href of candidats.slice(0, 12)) {
    try {
      await page.goto(base + href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
      if (/\/login(\?|$)/.test(page.url())) { rapport.push(`${href} -> redirige vers /login`); continue; }
      if (await hasExport(page)) {
        rapport.push(`${href} -> ✅ bouton d'export TROUVÉ`);
        await snapshot(page, debugDir, 'page-devis-trouvee');
        return { href, rapport };
      }
      rapport.push(`${href} -> page ok, mais aucun bouton d'export`);
    } catch (e) {
      rapport.push(`${href} -> inaccessible (${e.message.split('\n')[0].slice(0, 60)})`);
    }
  }
  return { href: null, rapport };
}

// La modale d'export de 4escape reste ouverte apres un export et intercepte
// tous les clics suivants : il faut la refermer entre les deux exports.
async function closeModal(page) {
  if (!(await page.locator('.modal.show').count().catch(() => 0))) return;
  await page.locator('.modal.show [data-dismiss="modal"]').first()
            .click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.modal.show'),
                             null, { timeout: 8000 }).catch(() => {});
  // le voile gris survit parfois a la modale et continue de bloquer
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'),
                             null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
}

// Cible la modale d'export ; la page en contient une autre (« Actions groupees »)
// dont le bouton submit ne doit surtout pas etre confondu avec « Exporter ».
async function modaleExport(page) {
  const precise = page.locator('#modal-order-export');
  if (await precise.count().catch(() => 0)) return precise.first();
  return page.locator('.modal.show').first();
}

async function doExport(page, wantLabel, debugDir) {
  await closeModal(page);
  await page.locator(EXPORT_SEL).first().click();
  await page.waitForFunction(() => document.querySelector('.modal.show'),
                             null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const picked = await page.evaluate((want) => {
    const n = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const root = document.querySelector('#modal-order-export') ||
                 document.querySelector('.modal.show') || document;
    for (const sel of root.querySelectorAll('select')) {
      const opt = [...sel.options].find((o) => n(o.textContent).includes(want));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    for (const el of root.querySelectorAll('li,a,div,span,option')) {
      if (n(el.textContent).includes(want)) { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click?.(); return true; }
    }
    return false;
  }, norm(wantLabel));
  if (!picked) {
    await snapshot(page, debugDir, 'modale-export');
    const inv = await inventaire(page);
    throw new Error(`Type d'export « ${wantLabel} » introuvable dans la modale.\n` +
                    `Boutons visibles : ${inv.boutons.join(' | ') || '(aucun)'}`);
  }
  await page.waitForTimeout(400);
  const modal = await modaleExport(page);
  const validate = modal.locator(
    'button[type="submit"], button:has-text("Exporter"), button:has-text("Télécharger"), button:has-text("Valider")'
  ).first();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    validate.click(),
  ]);
  const saved = path.join(debugDir, download.suggestedFilename() || 'export.csv');
  await download.saveAs(saved);
  await closeModal(page);   // laisse la page prete pour l'export suivant
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

    let chemin = cfg.quotesPath;
    const redirige = /\/login(\?|$)/.test(page.url());

    if (redirige || !(await hasExport(page))) {
      // Le chemin configuré ne convient pas : on cherche nous-mêmes.
      await snapshot(page, cfg.debugDir, 'page-configuree');
      const inv = await inventaire(page);
      console.log(`⚠️  ${cfg.quotesPath} : pas de bouton d'export. Recherche automatique…`);
      console.log(`    boutons vus : ${inv.boutons.join(' | ') || '(aucun)'}`);

      const { href, rapport } = await decouvrirDevis(page, cfg.base, cfg.debugDir);
      console.log('    exploration :');
      rapport.forEach((l) => console.log('      ' + l));

      if (!href)
        throw new Error(
          `Écran des devis introuvable.\nChemins testés :\n  ${rapport.join('\n  ')}\n\n` +
          `➜ Ouvre la liste des devis dans 4escape et donne l'URL exacte, ` +
          `puis mets-la dans le secret QUOTES_PATH (ex. /admin/statistics/quotes).`);

      chemin = href;
      console.log(`✅ Écran des devis trouvé : ${chemin}`);
      console.log(`   (fige-le dans le secret QUOTES_PATH pour éviter cette recherche)`);
    }

    const resume = await doExport(page, 'entetes de commande', cfg.debugDir);
    const detail = await doExport(page, 'lignes de commande', cfg.debugDir);
    return { resume, detail, quotesPath: chemin };
  } catch (e) {
    await snapshot(page, cfg.debugDir, 'echec');
    throw e;
  } finally {
    await browser.close();
  }
}
