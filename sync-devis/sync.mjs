// ============================================================================
//  GAMEDOOR·41 CRM — SYNCHRO DES DEVIS -> Supabase
//  ---------------------------------------------------------------------------
//  SOURCE : le Hub GAMEDOOR·41 (pont signé /api/pont/crm-devis) depuis la
//  bascule du 02/11/2026 ; 4escape avant (toujours possible : --source=4escape).
//
//  Idempotente : ne crée l'historique/les fiches que pour les NOUVEAUTÉS et les
//  devis dont le STATUT a changé. Les notes auto sont REMPLACÉES (bloc délimité),
//  jamais empilées.
//
//  MODES
//    node sync.mjs --dry-run
//        → lit la source en direct, analyse, compare à Supabase, n'écrit RIEN.
//    node sync.mjs
//        → synchro réelle (écrit dans Supabase).
//    node sync.mjs --from-hub-file reponse.json --dry-run
//        → teste sur une réponse du pont enregistrée, n'écrit rien.
//    node sync.mjs --source=4escape [--from-files resume.csv detail.csv]
//        → ancienne source 4escape (export Playwright ou CSV locaux).
// ============================================================================

import fs from 'node:fs';
import { transform, grouperParEntreprise, STATUTS_FIGES, STATUTS_HONORES, STATUT_CRM } from './lib/transform.mjs';
import { SALLES, sallesDuTexte } from './lib/activites.mjs';
import { calcSeuils, scoreValeur, scorePotentiel } from './lib/score.mjs';
import { normSociete } from './lib/csv.mjs';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (nom) => { const a = ARGS.find((x) => x.startsWith(`--${nom}=`)); return a ? a.slice(nom.length + 3) : null; };
const DRY = has('--dry-run');
const SOURCE = (val('source') || process.env.SYNC_DEVIS_SOURCE || 'hub').toLowerCase() === '4escape' ? '4escape' : 'hub';
const NOM_SOURCE = SOURCE === 'hub' ? 'Hub' : '4escape';
const now = new Date();
const log = (...a) => console.log(...a);

// --------------------------------------------------------------------------
// 1) Lecture des devis (Hub, ou 4escape : fichiers locaux ou export en direct)
// --------------------------------------------------------------------------
async function lireDevis() {
  if (SOURCE === 'hub') {
    const { fetchHub, transformHub } = await import('./lib/hub.mjs');
    const i = ARGS.indexOf('--from-hub-file');
    let reponse;
    if (i >= 0) { log(`Lecture d'une réponse du pont enregistrée : ${ARGS[i + 1]}`); reponse = JSON.parse(fs.readFileSync(ARGS[i + 1], 'utf8')); }
    else { log('Lecture des devis dans le Hub (pont signé)…'); reponse = await fetchHub(); }
    log(`Hub : ${reponse.nombre ?? (reponse.devis || []).length} devis lus (réponse du ${reponse.genere_le || '?'})`);
    const { devis, ignores } = transformHub(reponse);
    // Réponses au questionnaire entreprises (23/11/2026), jointes par le pont ; null = Hub plus ancien ou lecture en échec côté Hub.
    const questionnaires = Array.isArray(reponse.questionnaires) ? reponse.questionnaires : null;
    return { devis, ignores, questionnaires };
  }
  const i = ARGS.indexOf('--from-files');
  let csv;
  if (i >= 0) {
    const [rf, df] = [ARGS[i + 1], ARGS[i + 2]];
    if (!rf) throw new Error('--from-files attend : <resume.csv> [detail.csv]');
    log(`Lecture fichiers locaux :\n  résumé = ${rf}\n  détail = ${df || '(aucun)'}`);
    csv = { resume: fs.readFileSync(rf, 'utf8'), detail: df ? fs.readFileSync(df, 'utf8') : '' };
  } else {
    const { fetch4escape } = await import('./lib/fetch4escape.mjs');
    csv = await fetch4escape();
  }
  return { devis: transform(csv.resume, csv.detail), ignores: null };
}

// --------------------------------------------------------------------------
// 2) Reprise de ce que Supabase connaît déjà quand la source n'en dit rien
//    (ex. société ou téléphone d'un devis de 4escape que le Hub n'a pas repris) :
//    sans ça, une même entreprise pourrait changer de fiche à la bascule.
// --------------------------------------------------------------------------
// Un devis de 4escape que 4escape a vu PAYÉ ne redescend jamais en « à payer / en attente » : à la bascule, le Hub a repris
// comme « à payer » des commandes réglées dans 4escape (les faux impayés « avant le Hub », classés hors suivi dans le Hub,
// statut inchangé). Annulé ou remboursé passent, eux (un vrai changement). Les devis du Hub (HD-…) font foi tels quels.
const PAYES = new Set(['completed', 'refunded']);
const REDESCENTES = new Set(['on-hold', 'pending', 'expired']);
async function reprendreConnu(devis, existants) {
  const { garderConnu } = await import('./lib/store.mjs');
  let repris = 0; const payesGardes = [];
  for (const d of devis) {
    const ex = existants.get(d.reference);
    if (!ex) continue;
    const avant = JSON.stringify(d);
    const sansSociete = !d.societe;
    garderConnu(d, ex);
    if (sansSociete && d.societe) { d.est_societe = d.est_societe || !!ex.est_societe; d._key = normSociete(d.societe || d.client_nom || d.reference); }
    if (SOURCE === 'hub' && /^\d{4}-D/.test(d.reference) && PAYES.has(ex.statut) && REDESCENTES.has(d.statut)) { payesGardes.push(`${d.reference} (${d.statut})`); d.statut = ex.statut; }
    if (JSON.stringify(d) !== avant) repris++;
  }
  return { repris, payesGardes };
}

// --------------------------------------------------------------------------
// 3) Diff : compare l'état courant à ce que Supabase connaît déjà
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

// Contrôle de continuité (utile à la bascule de source) : pour les devis déjà connus, quels champs la nouvelle source
// voit autrement ? N'affiche ni email ni téléphone (les journaux GitHub Actions de ce dépôt sont publics).
function continuite(devis, existants) {
  const champs = { societe: 0, est_societe: 0, montant_ttc: 0, date_evenement: 0, contact_email: 0, nb_joueurs: 0 };
  const exemples = [];
  let connus = 0;
  for (const d of devis) {
    const ex = existants.get(d.reference);
    if (!ex) continue;
    connus++;
    const ecarts = [];
    if (normSociete(d.societe || '') !== normSociete(ex.societe || '')) { champs.societe++; ecarts.push(`société « ${ex.societe || '—'} » → « ${d.societe || '—'} »`); }
    if (!!d.est_societe !== !!ex.est_societe) { champs.est_societe++; ecarts.push(`est_societe ${!!ex.est_societe} → ${!!d.est_societe}`); }
    if (Math.abs((Number(d.montant_ttc) || 0) - (Number(ex.montant_ttc) || 0)) > 0.01) { champs.montant_ttc++; ecarts.push(`montant ${ex.montant_ttc} → ${d.montant_ttc}`); }
    if ((d.date_evenement || null) !== (ex.date_evenement || null)) { champs.date_evenement++; ecarts.push(`date ${ex.date_evenement || '—'} → ${d.date_evenement || '—'}`); }
    if ((d.contact_email || null) !== (ex.contact_email || null)) champs.contact_email++;
    if ((d.nb_joueurs || null) !== (ex.nb_joueurs || null)) champs.nb_joueurs++;
    if (ecarts.length && exemples.length < 15) exemples.push(`${d.reference} : ${ecarts.join(' ; ')}`);
  }
  const absents = [...existants.keys()].filter((r) => !devis.some((d) => d.reference === r));
  return { connus, champs, exemples, absents };
}

// --------------------------------------------------------------------------
// 4) Rapport lisible
// --------------------------------------------------------------------------
function rapport(devis, entreprises, plan, seuils, extra) {
  const parStatut = {};
  devis.forEach((d) => (parStatut[d.statut] = (parStatut[d.statut] || 0) + 1));
  const enCours = devis.filter((d) => !STATUTS_FIGES.has(d.statut)).length;

  log(`\n══════════════════ RAPPORT DE SYNCHRO (source : ${NOM_SOURCE}) ══════════════════`);
  log(`Devis lus            : ${devis.length}`);
  log(`Entreprises          : ${entreprises.length}`);
  log(`Devis EN COURS       : ${enCours}  (re-vérifiés à chaque synchro)`);
  log(`Devis figés          : ${devis.length - enCours}`);
  if (extra.ignores) {
    const inc = Object.entries(extra.ignores.inconnus || {});
    log(`Écartés              : ${extra.ignores.remplaces} repris dans le Hub (suivis sous leur nouvelle référence), ${extra.ignores.sans_suite} sans suite (facture directe), ${extra.ignores.essais || 0} devis d'essai (TEST HUB)`);
    if (inc.length) log(`⚠️  Statuts inconnus   : ${inc.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  }
  if (extra.repris) log(`Infos reprises de Supabase (vides dans la source) : ${extra.repris} devis`);
  if (extra.payesGardes && extra.payesGardes.length) log(`Payés dans 4escape, gardés payés (le Hub les voit encore à régler) : ${extra.payesGardes.length} — ${extra.payesGardes.join(', ')}`);
  log('\nRépartition des statuts :');
  Object.entries(parStatut).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => log(`   ${String(v).padStart(4)}  ${k} → ${STATUT_CRM[k] || '?'}`));

  log('\nCe que cette synchro écrirait :');
  log(`   ➕ ${plan.nouveaux.length} devis nouveaux`);
  log(`   🔄 ${plan.changes.length} changements de statut`);
  log(`   ⏸️  ${plan.inchanges.length} inchangés (aucune écriture d'historique)`);
  if (plan.nouveaux.length) {
    log('   nouveaux :');
    plan.nouveaux.slice(0, 15).forEach((d) => log(`      ${d.reference}  ${d.statut}  ${d.est_societe ? (d.societe || '—') : '(particulier)'}`));
    if (plan.nouveaux.length > 15) log(`      … +${plan.nouveaux.length - 15}`);
  }
  if (plan.changes.length) {
    const parPassage = {};
    plan.changes.forEach(({ d, ancien }) => { const k = `${ancien} → ${d.statut}`; parPassage[k] = (parPassage[k] || 0) + 1; });
    log(`   changements par type : ${Object.entries(parPassage).map(([k, v]) => `${k} ×${v}`).join(' · ')}`);
    log('   détail des changements :');
    const MAX = 120;
    plan.changes.slice(0, MAX).forEach(({ d, ancien }) =>
      log(`      ${d.reference}  ${ancien} → ${d.statut}  (${d.est_societe ? d.societe : 'particulier'})`));
    if (plan.changes.length > MAX) log(`      … +${plan.changes.length - MAX}`);
  }
  if (extra.continuite) {
    const c = extra.continuite;
    log(`\nContinuité avec Supabase : ${c.connus} devis déjà connus relus ; écarts par champ : ${Object.entries(c.champs).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    c.exemples.forEach((x) => log(`      ${x}`));
    log(`   ${c.absents.length} devis connus de Supabase absents de la source${c.absents.length ? ` (gardés tels quels, ex. ${c.absents.slice(0, 8).join(', ')})` : ''}`);
  }

  // Salles jouées des sociétés venues (devis honorés) : ce que voient les filtres de l'onglet Clients du CRM. Produits sans salle :
  // seulement les intitulés fréquents (≥ 3 devis, 50 caractères), jamais un texte isolé qui pourrait nommer quelqu'un (journaux publics).
  const venues = entreprises.filter((e) => e.est_societe && e.societe && e.nbHonores > 0);
  const parSalle = SALLES.map((s) => [s.nom, venues.filter((e) => e.salles.has(s.cle)).length]).filter(([, n]) => n);
  log(`\nSalles jouées (${venues.length} sociétés venues, d'après leurs devis honorés) : ${parSalle.map(([n, v]) => `${n} ${v}`).join(' · ') || 'aucune'} · ${venues.filter((e) => !e.salles.size).length} sans salle reconnue`);
  const autres = new Map();
  for (const e of venues) for (const d of e.devis) if (STATUTS_HONORES.has(d.statut)) for (const p of String(d.produits || '').split(' · ')) if (p && !sallesDuTexte(p).size) autres.set(p, (autres.get(p) || 0) + 1);
  const freq = [...autres].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (freq.length) log(`   autres produits (les plus fréquents) : ${freq.map(([p, n]) => `${p.slice(0, 50)} ×${n}`).join(' · ')}`);
  if (DRY) {
    const reco = new Map();
    for (const e of venues) for (const d of e.devis) if (STATUTS_HONORES.has(d.statut)) for (const p of String(d.produits || '').split(' · ')) if (p && sallesDuTexte(p).size) reco.set(p, (reco.get(p) || 0) + 1);
    const r = [...reco].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 40);
    if (r.length) log(`   produits reconnus : ${r.map(([p, n]) => `${p.slice(0, 60)} → ${[...sallesDuTexte(p)].join('+')} ×${n}`).join(' · ')}`);
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
  const { devis, ignores, questionnaires } = await lireDevis();
  if (!devis.length) throw new Error(`Aucun devis lu (source ${NOM_SOURCE}) — vérifie la source.`);

  // charge l'état connu de Supabase (sauf test pur sans identifiants)
  let existants = new Map();
  const store = (!DRY || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY))
    ? await import('./lib/store.mjs').then((m) => m.makeStore({ source: SOURCE })).catch((e) => {
        // Ne jamais avaler la cause : sinon on croit a des identifiants manquants.
        log(`⚠️  Connexion Supabase impossible : ${e && e.message ? e.message : e}`);
        if (e && e.stack) log(String(e.stack).split(/\n/).slice(0, 4).join(' | '));
        return null;
      })
    : null;
  if (store) { existants = await store.chargerDevis(); log(`État Supabase : ${existants.size} devis déjà connus.`); }
  else log('(pas de connexion Supabase : diff calculé comme si la base était vide)');

  const { repris, payesGardes } = await reprendreConnu(devis, existants);
  const entreprises = grouperParEntreprise(devis);
  const seuils = calcSeuils(entreprises);
  const plan = diff(devis, existants);
  rapport(devis, entreprises, plan, seuils, { ignores, repris, payesGardes, continuite: existants.size ? continuite(devis, existants) : null });

  const logQuestionnaires = (q) => log(`Questionnaires entreprises : ${q.recus} reçu(s) du Hub · ${q.rattaches} rattaché(s) à une fiche · ${q.nouvelles} nouvelle(s) réponse(s) à l’historique · ${q.fiches} bloc(s) de notes ${q.ecrit ? 'mis à jour' : 'à mettre à jour'} (+ ${q.clients || 0} fiche(s) client)${q.non_rattaches.length ? ` · ${q.non_rattaches.length} sans fiche : ${q.non_rattaches.slice(0, 10).join(', ')}` : ''}`);
  if (questionnaires === null && SOURCE === 'hub') log('Questionnaires entreprises : non fournis par le Hub (pont plus ancien ou lecture en échec).');
  if (DRY) {
    if (store) {
      try {
        const a = await store.apercuSalles(entreprises);
        const mots = [...a.mots].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 25);
        log(`Salles des fiches clients : ${a.clients} fiches (${a.avecSalles} avec salles saisies) · ${a.aCompleter} à compléter · ${a.nouvelles} nouvelle(s) fiche(s) avec salles${mots.length ? `\n   déjà saisi (≥ 2 fiches) : ${mots.map(([m, n]) => `${m.slice(0, 40)} ×${n}`).join(' · ')}` : ''}`);
      } catch (e) { log(`⚠️  Salles : ${e.message}`); }
    }
    if (questionnaires && store) { try { logQuestionnaires(await store.questionnaires(questionnaires, { ecrire: false })); } catch (e) { log(`⚠️  Questionnaires : ${e.message}`); } }
    log('\n🧪 DRY-RUN : rien n’a été écrit.'); return;
  }
  if (!store) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY manquants — impossible d’écrire.');

  const enCours = devis.filter((d) => !STATUTS_FIGES.has(d.statut)).length;
  const top = (arr, sc) => arr.map((e) => ({ e, s: sc(e, seuils, now) }))
    .filter((x) => x.s !== null).sort((a, b) => b.s - a.s).slice(0, 5)
    .map((x) => ({ societe: x.e.societe, score: x.s }));

  const runId = await store.debutRun(process.env.SYNC_SOURCE || 'manuel');
  log('\n✍️  Écriture dans Supabase…');
  try {
    const res = await store.appliquer({ devis, entreprises, plan, seuils, now });
    // Questionnaires : après les fiches (notes relues avec le bloc ⟦Hub⟧ du jour) ; une erreur ici ne fait pas échouer les devis.
    if (questionnaires) {
      try { res.questionnaires = await store.questionnaires(questionnaires); logQuestionnaires(res.questionnaires); }
      catch (e) { res.questionnaires = { erreur: e.message }; log(`⚠️  Questionnaires non écrits : ${e.message}`); }
    }
    const rapportJSON = {
      origine: SOURCE,
      lus: devis.length, entreprises: entreprises.length, enCours,
      nouveaux: plan.nouveaux.length, changements: plan.changes.length,
      ...res,
      topClients: top(entreprises, scoreValeur),
      topProspects: top(entreprises.filter((e) => e.aEncours), scorePotentiel),
    };
    await store.finRun(runId, { status: 'done', rapport: rapportJSON });
    log(`✅ Terminé : ${res.devisUpserts} devis, ${res.prospects} prospects, ${res.clients} clients (salles complétées sur ${res.salles}), ${res.activities} activités.`);
  } catch (e) {
    await store.finRun(runId, { status: 'error', message: e.message });
    throw e;
  }
})().catch((e) => { console.error('\n❌ ' + e.message + '\n'); process.exit(1); });
