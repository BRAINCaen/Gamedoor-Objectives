#!/usr/bin/env node
/**
 * Applique le verrouillage complet de la base Firebase, en une commande :
 *   1. active l'authentification anonyme (utilisee par le dashboard ET le robot)
 *   2. publie database.rules.json
 *   3. verifie que tout marche encore
 *
 * Pre-requis : etre connecte au compte Google proprietaire du projet.
 *   firebase login --reauth        (a taper dans un vrai terminal)
 * Puis :
 *   node apply-security.mjs
 *
 * Aucun secret n'est affiche ni ecrit sur le disque.
 */
import fs from 'fs';
import path from 'path';

const PROJECT = 'gamedoor-objectives';
const DB = 'https://gamedoor-objectives-default-rtdb.europe-west1.firebasedatabase.app';
const WEB_KEY = 'AIzaSyDda_GKBMHyaVrT4vzosMZnri3hyFCCwYs';
const RULES_FILE = path.join(import.meta.dirname, 'database.rules.json');

const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const ko = (m) => { console.log(`  \x1b[31m✖\x1b[0m ${m}`); };
class Stop extends Error {}
const die = (m) => { throw new Stop(m); };

async function main() {
// --- Jeton d'administration -------------------------------------------------
async function accessToken() {
  const p = process.env.USERPROFILE + '/.config/configstore/firebase-tools.json';
  let store;
  try { store = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { die('Pas de session Firebase locale. Tape d\'abord :  firebase login --reauth'); }
  if (!store.tokens?.refresh_token) die('Session Firebase incomplete. Tape :  firebase login --reauth');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      refresh_token: store.tokens.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) die(`Session Firebase expiree (${j.error}). Tape :  firebase login --reauth`);
  return { token: j.access_token, email: store.user?.email };
}

const { token, email } = await accessToken();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
console.log(`\n=== Verrouillage de ${PROJECT} ===\ncompte : ${email}`);

// --- 1) Authentification anonyme -------------------------------------------
step('1) Authentification anonyme');
let cfg = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`, { headers: H });

if (cfg.status === 403) die(`Le compte ${email} n'a pas les droits sur ${PROJECT}.\nReconnecte-toi avec le compte proprietaire :  firebase login --reauth`);

if (cfg.status === 404 || cfg.status === 400) {
  die(`Firebase Authentication n'a jamais ete active sur ce projet.

Ce projet est sur le plan gratuit (Spark). L'API d'activation exige la facturation,
alors que le faire depuis la console est gratuit : c'est le seul geste manuel.

  1. Ouvre  https://console.firebase.google.com/project/${PROJECT}/authentication/providers
  2. Clique « Commencer » si l'ecran le propose
  3. Fournisseurs de connexion -> « Anonyme » -> Activer -> Enregistrer

Puis relance :  node apply-security.mjs`);
}

if (!cfg.ok) die(`Lecture de la config Auth impossible : HTTP ${cfg.status} ${(await cfg.text()).slice(0, 300)}`);

const conf = await cfg.json();
if (conf.signIn?.anonymous?.enabled) ok('deja activee');
else {
  const up = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=signIn.anonymous.enabled`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ signIn: { anonymous: { enabled: true } } }),
  });
  up.ok ? ok('activee') : die(`Activation refusee : HTTP ${up.status} ${(await up.text()).slice(0, 300)}`);
}

// Controle reel : obtenir un jeton anonyme comme le fera le dashboard
const probe = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
});
const probeJson = await probe.json();
if (!probe.ok) die(`Le dashboard ne peut toujours pas se connecter (${probeJson?.error?.message}).\nNE PAS publier les regles : l'ecran et la synchro tomberaient en panne.`);
ok('un client peut obtenir un jeton anonyme — le dashboard et le robot fonctionneront');
const anonToken = probeJson.idToken;

// --- 2) Publication des regles ---------------------------------------------
step('2) Publication des regles');
const rules = fs.readFileSync(RULES_FILE, 'utf8');
const put = await fetch(`${DB}/.settings/rules.json?access_token=${token}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: rules,
});
put.ok ? ok('database.rules.json publie') : die(`Publication refusee : HTTP ${put.status} ${(await put.text()).slice(0, 300)}`);

// --- 3) Verification --------------------------------------------------------
step('3) Verification');
const noTok = await fetch(`${DB}/state/autoMeta/lastSync.json`);
noTok.status === 401 ? ok('lecture sans jeton : refusee') : ko(`lecture sans jeton : HTTP ${noTok.status} (attendu 401)`);

const noTokW = await fetch(`${DB}/_secTest.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' });
if (noTokW.status === 401) ok('ecriture sans jeton : refusee');
else { ko(`ecriture sans jeton : HTTP ${noTokW.status} (attendu 401)`); await fetch(`${DB}/_secTest.json`, { method: 'DELETE' }); }

const rdOk = await fetch(`${DB}/state/config.json?auth=${anonToken}`);
rdOk.ok ? ok('lecture avec jeton anonyme : OK (dashboard)') : ko(`lecture avec jeton : HTTP ${rdOk.status} — le dashboard sera hors ligne !`);

const dayOk = await fetch(`${DB}/state/entries/auto-1999-01-01.json?auth=${anonToken}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ date: '1999-01-01', ca: 1, sessions: 0, gm: 'test', ts: Date.now() }),
});
dayOk.ok ? ok('ecriture d\'une journee avec jeton : OK (robot nocturne)') : ko(`ecriture d'une journee : HTTP ${dayOk.status} — le robot ne pourra plus ecrire !`);
await fetch(`${DB}/state/entries/auto-1999-01-01.json?auth=${anonToken}`, { method: 'DELETE' });

const wipe = await fetch(`${DB}/state/entries.json?auth=${anonToken}`, { method: 'DELETE' });
wipe.status === 401 ? ok('effacement global de l\'historique : refuse, meme authentifie')
                    : ko(`effacement global : HTTP ${wipe.status} (attendu 401) — VERIFIER IMMEDIATEMENT`);

const count = await fetch(`${DB}/state/entries.json?shallow=true&auth=${anonToken}`);
const n = Object.keys(await count.json() || {}).length;
n >= 2164 ? ok(`historique intact : ${n} journees`) : ko(`historique : ${n} journees (attendu 2164)`);

console.log('\n\x1b[32mTermine.\x1b[0m Ouvre le dashboard pour confirmer : https://braincaen.github.io/Gamedoor-Objectives/\n');
}

main().catch((e) => {
  process.exitCode = 1;
  console.error(`
[31m${e instanceof Stop ? e.message : e.stack || e.message}[0m
`);
});
