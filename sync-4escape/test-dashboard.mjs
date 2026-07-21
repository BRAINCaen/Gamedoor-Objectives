// Smoke-test du dashboard : charge index.html dans Chromium, passe le PIN,
// attend la synchro Firebase, verifie l'absence d'erreurs JS et les valeurs cles.
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INDEX = path.resolve(process.cwd(), '..', 'index.html');
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(pathToFileURL(INDEX).href);
await page.evaluate(() => localStorage.setItem('gamedoor_pin_ok', '4141'));
await page.reload();
await page.waitForTimeout(6000);   // laisse Firebase se synchroniser

const state = await page.evaluate(() => ({
  appVisible: document.getElementById('app').style.display !== 'none',
  syncTxt: document.getElementById('syncTxt')?.textContent,
  caMois: document.getElementById('heroCaVal')?.textContent,
  lastDay: document.getElementById('todayDate')?.textContent,
  caJour: document.getElementById('tCa')?.textContent,
  sessions: document.getElementById('tSessions')?.textContent,
  joueurs: document.getElementById('kJoueurs')?.textContent,
  detailLignes: document.querySelectorAll('#syncDetail .log-row').length,
  logLignes: document.querySelectorAll('#log .log-row').length,
  saisieSupprimee: !document.getElementById('inCa') && !document.getElementById('inGm'),
  xpSupprime: !document.getElementById('leaderboard') && !document.getElementById('teamLevelNum'),
}));

console.log(JSON.stringify(state, null, 2));
console.log('Erreurs JS :', errors.length ? errors : 'AUCUNE');
await page.screenshot({ path: 'debug/dashboard-apres-refonte.png', fullPage: true });
console.log('Capture : debug/dashboard-apres-refonte.png');
await browser.close();
process.exit(errors.length ? 1 : 0);
