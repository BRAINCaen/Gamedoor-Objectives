// OUTIL PONCTUEL (23/11/2026) : retire du CRM les devis d'essai du Hub (« TEST HUB SARL », HD-2026-0001/0002)
// importés le 14/11, avec la fiche prospect et l'historique que la synchro avait créés pour eux.
// La synchro les écarte désormais à la source (lib/hub.mjs, RE_ESSAI) : ils ne reviendront pas.
// Défaut = lecture seule ; --appliquer pour supprimer. N'affiche ni email ni téléphone (dépôt public).
// Annulation : le Hub les contient toujours ; retirer RE_ESSAI puis relancer la synchro les recrée.
// À SUPPRIMER après usage, avec .github/workflows/purge-essais.yml.

import { createClient } from '@supabase/supabase-js';
import { RE_ESSAI } from './lib/hub.mjs';

const APPLIQUER = process.argv.includes('--appliquer');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const ROBOT = 'robot@gamedoor41';
const RE_BLOC = /⟦(4escape|Hub)⟧[\s\S]*?⟦\/\1⟧/g;
const ok = (r, quoi) => { if (r.error) throw new Error(`${quoi} : ${r.error.message}`); return r.data || []; };

const devis = ok(await sb.from('devis').select('reference,societe,statut,client_nom').ilike('societe', 'test%hub%'), 'devis')
  .filter((d) => RE_ESSAI.test(d.societe || '') || RE_ESSAI.test(d.client_nom || ''));
const prospects = ok(await sb.from('prospects').select('id,societe,statut,notes').ilike('societe', 'test%hub%'), 'prospects')
  .filter((p) => RE_ESSAI.test(p.societe || ''));
const clients = ok(await sb.from('clients').select('id,societe').ilike('societe', 'test%hub%'), 'clients')
  .filter((c) => RE_ESSAI.test(c.societe || ''));

console.log(`Devis d'essai dans Supabase : ${devis.length} — ${devis.map((d) => `${d.reference} (${d.statut})`).join(', ') || 'aucun'}`);
console.log(`Clients « TEST HUB » : ${clients.length} (jamais supprimés par cet outil)`);

const aSupprimer = { activities: [], prospects: [] };
for (const p of prospects) {
  const acts = ok(await sb.from('activities').select('id,user_email,description').eq('prospect_id', p.id), 'activities');
  const robot = acts.filter((a) => a.user_email === ROBOT);
  const humains = acts.length - robot.length;
  const notesManuelles = String(p.notes || '').replace(RE_BLOC, '').trim().length;
  const supprimable = humains === 0 && notesManuelles === 0;
  console.log(`Prospect « ${p.societe} » (${p.statut}) : ${robot.length} entrée(s) d'historique du robot, ${humains} saisie(s) à la main, notes manuelles : ${notesManuelles ? 'OUI' : 'non'} → ${supprimable ? 'supprimé' : 'GARDÉ (quelqu’un y a travaillé)'}`);
  aSupprimer.activities.push(...robot.map((a) => a.id));
  if (supprimable) aSupprimer.prospects.push(p.id);
}
// Historique du robot éventuellement non rattaché à une fiche
const orphelins = ok(await sb.from('activities').select('id,prospect_id').eq('user_email', ROBOT).ilike('prospect_nom', 'test%hub%'), 'activities orphelines')
  .filter((a) => !aSupprimer.activities.includes(a.id));
aSupprimer.activities.push(...orphelins.map((a) => a.id));

console.log(`\nÀ supprimer : ${devis.length} devis, ${aSupprimer.prospects.length} prospect(s), ${aSupprimer.activities.length} entrée(s) d'historique du robot.`);
if (!APPLIQUER) { console.log('Lecture seule (relancer avec --appliquer pour supprimer).'); process.exit(0); }

if (aSupprimer.activities.length) ok(await sb.from('activities').delete().in('id', aSupprimer.activities), 'suppression activities');
if (aSupprimer.prospects.length) ok(await sb.from('prospects').delete().in('id', aSupprimer.prospects), 'suppression prospects');
if (devis.length) ok(await sb.from('devis').delete().in('reference', devis.map((d) => d.reference)), 'suppression devis');

let reste = ok(await sb.from('devis').select('reference').in('reference', devis.length ? devis.map((d) => d.reference) : ['-']), 'contrôle devis').length;
if (aSupprimer.prospects.length) reste += ok(await sb.from('prospects').select('id').in('id', aSupprimer.prospects), 'contrôle prospects').length;
if (aSupprimer.activities.length) reste += ok(await sb.from('activities').select('id').in('id', aSupprimer.activities), 'contrôle activities').length;
console.log(reste ? `⚠️ Il reste ${reste} ligne(s).` : '✅ Supprimé, contrôle : 0 restant.');
process.exit(reste ? 1 : 0);
