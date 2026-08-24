#!/usr/bin/env node
/**
 * Verifie l'etat de securite du Firebase du dashboard.
 *
 *   node check-firebase-rules.mjs            lecture seule, ne touche a rien
 *   node check-firebase-rules.mjs --full     + ecritures de test
 *
 * SECURITE DU SCRIPT LUI-MEME : aucun test n'ecrit jamais sur un chemin reel.
 * Les seuls chemins ecrits sont /_secTest, /state/entries/auto-1999-01-01 et
 * /state/entries/zzz-test-securite, tous supprimes ensuite. Ne JAMAIS ajouter
 * ici de PUT sur /state/entries ou /state : un PUT remplace le noeud entier et
 * effacerait tout l'historique (c'est arrive le 24/08/2026).
 */

const FB = (process.env.FB_URL || 'https://gamedoor-objectives-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, '');
const API_KEY = process.env.FB_API_KEY || 'AIzaSyDda_GKBMHyaVrT4vzosMZnri3hyFCCwYs';
const FULL = process.argv.includes('--full');

const SAFE_PATHS = ['/_secTest.json', '/state/entries/auto-1999-01-01.json', '/state/entries/zzz-test-securite.json'];

let ok = 0, ko = 0;
const pass = (m) => { ok++; console.log('  \x1b[32m✔\x1b[0m ' + m); };
const fail = (m) => { ko++; console.log('  \x1b[31m✖\x1b[0m ' + m); };
const info = (m) => console.log('  · ' + m);

async function req(method, path, token, body) {
  if (method !== 'GET' && !SAFE_PATHS.includes(path)) throw new Error(`GARDE-FOU : ecriture interdite sur ${path}`);
  const res = await fetch(`${FB}${path}` + (token ? `?auth=${token}` : ''), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function anonToken() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { token: j.idToken } : { err: j?.error?.message || `HTTP ${r.status}` };
}

console.log(`\n=== Audit securite Firebase ===\n${FB}\n`);

// --- 1) Authentification anonyme -------------------------------------------
console.log('1) Authentification anonyme (utilisee par le dashboard ET le robot)');
const auth = await anonToken();
if (auth.token) pass('activee');
else if (auth.err === 'CONFIGURATION_NOT_FOUND' || auth.err === 'ADMIN_ONLY_OPERATION')
  fail(`PAS activee (${auth.err}) -> Console Firebase > Authentication > Sign-in method > Anonyme. NE PAS publier les regles avant.`);
else fail(`indisponible : ${auth.err}`);

// --- 2) Ce qu'un inconnu peut faire ----------------------------------------
console.log('\n2) Acces SANS token (ce que voit un inconnu qui a l\'URL)');
const rd = await req('GET', '/state/autoMeta/lastSync.json', null);
if (rd.status === 401) pass('lecture refusee (401)');
else if (rd.status === 200) fail(`lecture AUTORISEE — la base est publique : ${rd.text.slice(0, 60)}`);
else info(`lecture : HTTP ${rd.status}`);

const rdAll = await req('GET', '/state/entries.json?shallow=true', null);
if (rdAll.status === 401) pass('historique complet illisible (401)');
else if (rdAll.status === 200) fail(`historique complet lisible par tous (${Object.keys(JSON.parse(rdAll.text || '{}')).length} journees)`);

const wr = await req('PUT', '/_secTest.json', null, { probe: 1 });
if (wr.status === 401) pass('ecriture refusee (401)');
else if (wr.status === 200) { fail("ecriture AUTORISEE — n'importe qui peut modifier la base"); await req('DELETE', '/_secTest.json', null); info('(test nettoye)'); }
else info(`ecriture : HTTP ${wr.status}`);

// --- 3) Dashboard + robot (avec token) -------------------------------------
if (auth.token) {
  console.log('\n3) Acces AVEC token anonyme (dashboard + robot nocturne)');
  const r1 = await req('GET', '/state/config.json', auth.token);
  r1.status === 200 ? pass('lecture de /state : OK — le dashboard fonctionne')
                    : fail(`lecture de /state refusee (HTTP ${r1.status}) — le dashboard tombera en erreur`);

  if (FULL) {
    const entry = { date: '1999-01-01', ca: 1, sessions: 0, gm: 'test-securite', ts: Date.now() };
    const w = await req('PUT', '/state/entries/auto-1999-01-01.json', auth.token, entry);
    w.status === 200 ? pass('ecriture d\'une journee : OK — la synchro nocturne fonctionne')
                     : fail(`ecriture d'une journee REFUSEE (HTTP ${w.status}) — le robot ne pourra plus ecrire : ${w.text.slice(0, 120)}`);
    await req('DELETE', '/state/entries/auto-1999-01-01.json', auth.token);

    const badKey = await req('PUT', '/state/entries/zzz-test-securite.json', auth.token, entry);
    if (badKey.status === 401 || badKey.status === 403) pass('cle hors format auto-YYYY-MM-DD refusee');
    else { info(`cle hors format acceptee (HTTP ${badKey.status}) — regles pas encore publiees`); await req('DELETE', '/state/entries/zzz-test-securite.json', auth.token); }

    for (const p of SAFE_PATHS) {
      const left = await req('GET', p, auth.token);
      // 401 = chemin illisible par un client : les regles font leur travail, rien a nettoyer
      if (left.status === 200 && left.text.trim() !== 'null') fail(`residu de test a supprimer : ${p}`);
    }
    info('chemins de test verifies propres');
  } else {
    info('(--full pour tester aussi les ecritures)');
  }
}

console.log(`\n=== ${ok} OK · ${ko} probleme(s) ===\n`);
process.exit(ko ? 1 : 0);
