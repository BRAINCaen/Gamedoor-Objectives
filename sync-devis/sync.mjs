// ============================================================================
//  GAMEDOOR·41 CRM — SYNCHRO DES DEVIS 4escape -> Supabase
//  ---------------------------------------------------------------------------
//  Idempotente : ne crée l'historique/les fiches que pour les NOUVEAUTÉS et les
//  devis dont le STATUT a changé. Les devis figés (payés/annulés) ne sont jamais
//  réécrits. Les notes auto sont REMPLACÉES (bloc délimité), jamais empilées.
//
//  MODES
//    node sync.mjs --from-files resume.csv detail.csv --dry-run
//        → teste sur des CSV locaux, n'écrit RIEN, affiche le rapport.
//    node sync.mjs --dry-run
//        → login 4escape + exports en direct, analyse, mais n'écrit rien.
//    node sync.mjs
//        → synchro réelle (écrit dans Supabase).
// ============================================================================

import fs from 'node:fs';
import { transform, grouperParEntreprise, STATUTS_FIGES, STATUTS_HONORES, STATUT_CRM } from './lib/transform.mjs';
import { calcSeuils, scoreValeur, scorePotentiel } from './lib/score.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const DRY = has('--dry-run');
const now = new Date();
const log = (...a) => console.log(...a);

// --------------------------------------------------------------------------
// 1) Récupération des deux CSV (fichiers locaux ou export 4escape en direct)
// --------------------------------------------------------------------------
async function getCSVs() {
  const i = ARGS.indexOf('--from-files');
  if (i >= 0) {
    const [rf, df] = [ARGS[i + 1], ARGS[i + 2]];
    if (!rf) throw new Error('--from-files attend : <resume.csv> [detail.csv]');
    log(`Lecture fichiers locaux :\n  résumé = ${rf}\n  détail = ${df || '(aucun)'}`);
    return { resume: fs.readFileSync(rf, 'utf8'), detail: df ? fs.readFileSync(df, 'utf8') : '' };
  }
  const { fetch4escape } = await import('./lib/fetch4escape.mjs');
  return fetch4escape();
}

// --------------------------------------------------------------------------
// 2) Diff : compare l'état courant à ce que Supabase connaît déjà
// --------------------------------------------------------------------------
function diff(devis, existants) {
  const plan = { nouveaux: [], changes: [], inchanges: [] };
  for (const d of devis) {
    const ex = existants.get(d.reference);
    if (!ex) { plan.nouveaux.push(d); continue; }
    if (ex.statut !== d.statut) plan.changes.push({ d, ancien: ex.statut, ex });
    else plan.inchanges.push({ d, ex });
  }
  return plan;
}

// --------------------------------------------------------------------------
// 3) Rapport lisible
// --------------------------------------------------------------------------
function rapport(devis, entreprises, plan, seuils) {
  const parStatut = {};
  devis.forEach((d) => (parStatut[d.statut] = (parStatut[d.statut] || 0) + 1));
  const enCours = devis.filter((d) => !STATUTS_FIGES.has(d.statut)).length;

  log('\n══════════════════ RAPPORT DE SYNCHRO ══════════════════');
  log(`Devis lus            : ${devis.length}`);
  log(`Entreprises          : ${entreprises.length}`);
  log(`Devis EN COURS       : ${enCours}  (re-vérifiés à chaque synchro)`);
  log(`Devis figés          : ${devis.length - enCours}`);
  log('\nRépartition des statuts :');
  Object.entries(parStatut).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => log(`   ${String(v).padStart(4)}  ${k} → ${STATUT_CRM[k] || '?'}`));

  log('\nCe que cette synchro écrirait :');
  log(`   ➕ ${plan.nouveaux.length} devis nouveaux`);
  log(`   🔄 ${plan.changes.length} changements de statut`);
  log(`   ⏸️  ${plan.inchanges.length} inchangés (aucune écriture d'historique)`);
  if (plan.changes.length) {
    log('   détail des changements :');
    plan.changes.slice(0, 12).forEach(({ d, ancien }) =>
      log(`      ${d.reference}  ${ancien} → ${d.statut}  (${d.societe})`));
    if (plan.changes.length > 12) log(`      … +${plan.changes.length - 12}`);
  }

  // top clients / prospects par score
  const clients = entreprises
    .map((e) => ({ e, s: scoreValeur(e, seuils, now) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s - a.s || b.e.ca - a.e.ca);
  const prospects = entreprises
    .map((e) => ({ e, s: scorePotentiel(e, seuils, now) }))
    .filter((x) => x.e.aEncours)
    .sort((a, b) => b.s - a.s);

  log(`\nTop 10 CLIENTS par score VALEUR (${clients.length} clients avérés) :`);
  clients.slice(0, 10).forEach(({ e, s }) =>
    log(`   ⭐${s}  ${e.societe.slice(0, 34).padEnd(34)} ${Math.round(e.ca).toLocaleString('fr-FR')}€ · ${e.nbHonores} venue(s)`));

  log(`\nTop 10 PROSPECTS par score POTENTIEL (${prospects.length} avec devis en cours) :`);
  prospects.slice(0, 10).forEach(({ e, s }) =>
    log(`   ⭐${s}  ${e.societe.slice(0, 34).padEnd(34)} ${Math.round(e.montantEncours).toLocaleString('fr-FR')}€ en cours`));
  log('════════════════════════════════════════════════════════');
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
(async () => {
  const { resume, detail } = await getCSVs();

  const devis = transform(resume, detail);
  if (!devis.length) throw new Error('Aucun devis lu — vérifie les fichiers/export.');
  const entreprises = grouperParEntreprise(devis);
  const seuils = calcSeuils(entreprises);

  // charge l'état connu de Supabase (sauf test pur sans identifiants)
  let existants = new Map();
  const store = (!DRY || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY))
    ? await import('./lib/store.mjs').then((m) => m.makeStore()).catch(() => null)
    : null;
  if (store) { existants = await store.chargerDevis(); log(`État Supabase : ${existants.size} devis déjà connus.`); }
  else log('(pas de connexion Supabase : diff calculé comme si la base était vide)');

  const plan = diff(devis, existants);
  rapport(devis, entreprises, plan, seuils);

  if (DRY) { log('\n🧪 DRY-RUN : rien n’a été écrit.'); return; }
  if (!store) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY manquants — impossible d’écrire.');

  const enCours = devis.filter((d) => !STATUTS_FIGES.has(d.statut)).length;
  const top = (arr, sc) => arr.map((e) => ({ e, s: sc(e, seuils, now) }))
    .filter((x) => x.s !== null).sort((a, b) => b.s - a.s).slice(0, 5)
    .map((x) => ({ societe: x.e.societe, score: x.s }));

  const runId = await store.debutRun(process.env.SYNC_SOURCE || 'manuel');
  log('\n✍️  Écriture dans Supabase…');
  try {
    const res = await store.appliquer({ devis, entreprises, plan, seuils, now });
    const rapportJSON = {
      lus: devis.length, entreprises: entreprises.length, enCours,
      nouveaux: plan.nouveaux.length, changements: plan.changes.length,
      ...res,
      topClients: top(entreprises, scoreValeur),
      topProspects: top(entreprises.filter((e) => e.aEncours), scorePotentiel),
    };
    await store.finRun(runId, { status: 'done', rapport: rapportJSON });
    log(`✅ Terminé : ${res.devisUpserts} devis, ${res.prospects} prospects, ${res.clients} clients, ${res.activities} activités.`);
  } catch (e) {
    await store.finRun(runId, { status: 'error', message: e.message });
    throw e;
  }
})().catch((e) => { console.error('\n❌ ' + e.message + '\n'); process.exit(1); });
