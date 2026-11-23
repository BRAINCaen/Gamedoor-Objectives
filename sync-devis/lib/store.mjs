// Couche d'écriture Supabase de la synchro. Règles :
//  · idempotente : n'écrit d'historique que pour les devis nouveaux/changés ;
//  · préserve le travail manuel (notes libres, satisfaction, salles, services) : aux salles jouées, la synchro n'AJOUTE que celles des
//    devis honorés qui manquent (lib/activites.mjs, filtres de l'onglet Clients) ; une satisfaction vide prend la note du questionnaire ;
//  · remplace le bloc de note auto au lieu de l'empiler (marqueurs ⟦Hub⟧, ou ⟦4escape⟧ avant le 02/11/2026) ;
//  · n'efface jamais une donnée connue d'un devis par un champ vide de la source (téléphone, date de validation…).

import { createClient } from '@supabase/supabase-js';
import { normSociete, iso } from './csv.mjs';
import { STATUTS_HONORES, STATUTS_FIGES, STATUT_CRM, LIBELLE_STATUT } from './transform.mjs';
import { scoreValeur, scorePotentiel } from './score.mjs';
import { scoreFinal } from './engagement.mjs';
import { planQuestionnaires, planClientsQuestionnaires, idsDejaNotes, ACTION as ACTION_QUESTIONNAIRE } from './questionnaires.mjs';
import { fusionnerSalles, morceaux } from './activites.mjs';

const CHUNK = 500;
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const estPaye = (statut) => STATUTS_HONORES.has(statut);

// Les fiches clients/prospects s'écrivent une par une (≈ 900 requêtes, ~0,15 s chacune : 2 min 30 au total).
// On en envoie N à la fois : mêmes écritures, même résultat, ~N fois plus vite (bouton « Synchroniser » du CRM).
export async function enParallele(items, n, fn) {
  let i = 0;
  const ouvriers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(ouvriers);
}

// Source des devis : 'hub' (depuis le 02/11/2026) ou '4escape' (avant). Le bloc auto porte le nom de la source ; un
// ancien bloc ⟦4escape⟧ est REMPLACÉ par le bloc ⟦Hub⟧ (jamais deux blocs sur une même fiche).
export const SOURCES = {
  hub: { marque: 'Hub', robot: 'Synchro Hub', action: 'Devis Hub' },
  '4escape': { marque: '4escape', robot: 'Synchro 4escape', action: 'Devis 4escape' },
};
const RE_BLOC = /⟦(4escape|Hub)⟧[\s\S]*?⟦\/\1⟧/;
export function remplacerBloc(notes, bloc, marque = 'Hub') {
  const b = `⟦${marque}⟧\n${bloc}\n⟦/${marque}⟧`;
  if (notes && RE_BLOC.test(notes)) return notes.replace(RE_BLOC, () => b);
  return notes ? `${notes.trim()}\n\n${b}` : b;
}
function noteAuto(e, marque) {
  const L = [`— ${marque} : ${e.devis.length} devis`];
  if (e.ca) L.push(`CA réalisé : ${Math.round(e.ca).toLocaleString('fr-FR')} € sur ${e.nbHonores} honoré(s)`);
  if (e.dernierHonore) L.push(`Dernière venue : ${e.dernierHonore.toLocaleDateString('fr-FR')}`);
  if (e.prochainEvent) L.push(`Prochaine date : ${e.prochainEvent.toLocaleDateString('fr-FR')}`);
  if (e.aEncours) L.push(`${e.devis.filter((d) => !STATUTS_FIGES.has(d.statut)).length} devis en cours`);
  if (e.priva) L.push('A déjà privatisé');
  if (e.repas) L.push('A déjà pris une prestation repas');
  if (e.noms.size > 1) L.push(`Regroupe : ${[...e.noms].join(' / ')}`);
  return L.join('\n');
}

// statut CRM agrégé d'une entreprise (repris de la logique du CRM)
function statutCRM(e) {
  const st = e.devis.map((d) => d.statut);
  if (st.some((s) => STATUTS_HONORES.has(s))) return 'Client';
  if (st.includes('on-hold')) return 'Devis envoyé';
  if (st.includes('pending') || st.includes('expired')) return 'Relance';
  return 'Perdu';
}

// Colonnes de `devis` qu'une source peut laisser vides alors qu'on les connaît déjà (ex. le téléphone des devis de 4escape,
// que le Hub n'a pas repris) : la valeur connue est gardée. Statuts, montants et cases à cocher ne sont jamais concernés.
const GARDER_SI_VIDE = ['societe', 'client_nom', 'contact_email', 'contact_tel', 'nb_joueurs', 'date_validation', 'date_evenement',
  'date_creation', 'due_date', 'recall_date', 'date_cloture', 'produits', 'contact_interne', 'source'];
const vide = (v) => v === null || v === undefined || v === '';
export function garderConnu(row, ex) {
  if (!ex) return row;
  for (const k of GARDER_SI_VIDE) if (vide(row[k]) && !vide(ex[k])) row[k] = ex[k];
  return row;
}

export function makeStore({ source = 'hub', sb: sbFourni = null, parallele = 8 } = {}) {
  const S = SOURCES[source] || SOURCES.hub;
  let sb = sbFourni; // client simulé pour les tests hors ligne
  if (!sb) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY manquants');
    sb = createClient(url, key, { auth: { persistSession: false } });
  }

  const fetchAll = async (table, cols) => {
    let out = [], from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      if (!data || !data.length) break;
      out = out.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    return out;
  };

  async function chargerDevis() {
    // Toutes les colonnes : garderConnu() et le contrôle de continuité du dry-run (sync.mjs) en ont besoin.
    const rows = await fetchAll('devis', '*');
    return new Map(rows.map((r) => [r.reference, r]));
  }

  // Journal des synchros (pour le suivi côté CRM)
  async function debutRun(source = 'bouton') {
    const { data, error } = await sb.from('sync_runs').insert({ status: 'running', source }).select('id').single();
    if (error) return null;               // le journal ne doit jamais bloquer la synchro
    return data.id;
  }
  async function finRun(id, { status, rapport, message }) {
    if (!id) return;
    await sb.from('sync_runs').update({ status, rapport: rapport || null, message: message || null, finished_at: new Date().toISOString() }).eq('id', id);
  }

  async function appliquer({ devis, entreprises, plan, seuils, now }) {
    const nowISO = now.toISOString();
    const existants = new Map((await chargerDevis()).entries());
    const res = { devisUpserts: 0, prospects: 0, clients: 0, salles: 0, activities: 0 };

    // 1) TABLE DEVIS — upsert avec horodatages préservés/calculés
    const changeSet = new Set(plan.changes.map((c) => c.d.reference));
    const newSet = new Set(plan.nouveaux.map((d) => d.reference));
    const lignes = devis.map((d) => {
      const { _key, ...row } = d;
      const ex = existants.get(d.reference);
      row.vu_le = nowISO;
      if (!ex) {
        row.premier_vu_le = nowISO; row.statut_precedent = null;
        row.statut_change_le = nowISO; row.paye_le = estPaye(d.statut) ? nowISO : null;
      } else if (ex.statut !== d.statut) {
        row.premier_vu_le = ex.premier_vu_le; row.statut_precedent = ex.statut;
        row.statut_change_le = nowISO; row.paye_le = ex.paye_le || (estPaye(d.statut) ? nowISO : null);
      } else {
        row.premier_vu_le = ex.premier_vu_le; row.statut_precedent = ex.statut_precedent;
        row.statut_change_le = ex.statut_change_le; row.paye_le = ex.paye_le;
      }
      return garderConnu(row, ex);
    });
    for (const c of chunk(lignes, CHUNK)) {
      const { error } = await sb.from('devis').upsert(c, { onConflict: 'reference' });
      if (error) throw new Error(`devis upsert: ${error.message}`);
      res.devisUpserts += c.length;
    }

    // On ne touche prospects/clients/activities QUE pour les SOCIÉTÉS (CRM B2B).
    const soc = entreprises.filter((e) => e.est_societe && e.societe);

    // 2) CLIENTS (sociétés ayant au moins un devis honoré) — préserve le manuel
    const cliExist = new Map((await fetchAll('clients', 'id,societe,salles_jouees')).map((c) => [normSociete(c.societe), c]));
    await enParallele(soc.filter((e) => e.nbHonores > 0), parallele, async (e) => {
      const sv = scoreValeur(e, seuils, now);
      const derivé = {
        ca_total: Math.round(e.ca * 100) / 100, nb_sessions: e.nbHonores,
        privatisation: e.priva, repas: e.repas, type_client: 'Entreprise',
        derniere_visite: iso(e.dernierHonore), prochaine_visite: iso(e.prochainEvent),
        score_valeur: sv, score_detail: { ca: e.ca, venues: e.nbHonores, calc: 'valeur' },
      };
      const ex = cliExist.get(e.key);
      if (ex) {
        // Salles : seulement celles qui manquent, ajoutées à la fin (rien d'effacé ni de renommé) ; sinon la colonne n'est pas touchée.
        const salles = fusionnerSalles(ex.salles_jouees, e.salles);
        const maj = salles !== (ex.salles_jouees || '') ? { ...derivé, salles_jouees: salles } : derivé;
        const { error } = await sb.from('clients').update(maj).eq('id', ex.id); // ne touche pas notes/satisfaction/…
        if (!error) { res.clients++; if (maj !== derivé) res.salles++; }
      } else {
        const salles = fusionnerSalles('', e.salles) || null;
        const { error } = await sb.from('clients').insert({
          societe: e.societe, email: [...e.emails][0] || '', telephone: [...e.tels][0] || '', ...derivé, salles_jouees: salles,
        });
        if (!error) { res.clients++; if (salles) res.salles++; }
      }
    });

    // 3) PROSPECTS (toutes les sociétés) — remplace le bloc note, garde le reste
    // On relit aussi les coordonnées : le score tient compte de la qualité de
    // la fiche (joignable, décideur identifié, checklist), pas seulement des devis.
    const proExist = new Map((await fetchAll('prospects',
      'id,societe,notes,date_relance,email,email_direct,telephone,contact_direct,checks_json'))
      .map((p) => [normSociete(p.societe), p]));
    const prospectIdParKey = new Map();
    await enParallele(soc, parallele, async (e) => {
      // Le score POTENTIEL issu des devis sert de BASE ; l'avancement dans le
      // pipeline et l'état de la fiche la modulent (±4). Règle identique à
      // celle du CRM (lib/engagement.mjs ↔ section SCORE D'ENGAGEMENT de
      // crm.html) : sans ça le score sauterait d'une valeur à l'autre entre
      // une sauvegarde dans le CRM et la synchro de la nuit suivante.
      const base = scorePotentiel(e, seuils, now);
      const statut = statutCRM(e);
      const ex = proExist.get(e.key);
      const notes = remplacerBloc(ex ? ex.notes : '', noteAuto(e, S.marque), S.marque);

      const fiche = {
        statut, notes,
        email: ex ? ex.email : ([...e.emails][0] || ''),
        email_direct: ex ? ex.email_direct : null,
        telephone: ex ? ex.telephone : ([...e.tels][0] || ''),
        contact_direct: ex ? ex.contact_direct : null,
        checks_json: ex ? ex.checks_json : null,
      };
      const r = scoreFinal(base, fiche);

      const commun = {
        statut, score: r.score,
        score_detail: {
          base, modificateur: r.modificateur, avancement: r.avancement, fiche: r.fiche,
          raisons: r.raisons, calc: 'engagement-v1', maj: nowISO,
          enCours: e.aEncours, montantEncours: e.montantEncours,
        },
        date_relance: iso(e.prochainEvent),
      };

      if (ex) {
        const patch = { ...commun, notes };
        if (!commun.date_relance) patch.date_relance = ex.date_relance; // ne pas effacer une relance saisie
        const { error } = await sb.from('prospects').update(patch).eq('id', ex.id);
        if (!error) { res.prospects++; prospectIdParKey.set(e.key, ex.id); }
      } else {
        const { data, error } = await sb.from('prospects').insert({
          societe: e.societe, contact: e.societe, email: fiche.email, telephone: fiche.telephone,
          notes, ...commun,
        }).select('id').single();
        if (!error && data) { res.prospects++; prospectIdParKey.set(e.key, data.id); }
      }
    });

    // 4) ACTIVITIES — seulement nouveaux + changements (idempotent)
    const acts = [];
    for (const d of devis) {
      const estNouveau = newSet.has(d.reference), estChange = changeSet.has(d.reference);
      if (!estNouveau && !estChange) continue;
      if (!d.est_societe) continue;
      const pid = prospectIdParKey.get(d._key) || null;
      const ex = existants.get(d.reference);
      acts.push({
        prospect_id: pid, prospect_nom: d.societe || d.client_nom,
        user_email: 'robot@gamedoor41', user_name: S.robot,
        action_type: S.action,
        description: `${d.reference} — ${d.montant_ttc.toFixed(2)} € — ${LIBELLE_STATUT[d.statut] || STATUT_CRM[d.statut] || d.statut}`
          + (d.reste_du > 0 ? ` (reste dû ${d.reste_du.toFixed(2)} €)` : ''),
        ancien_statut: estChange && ex ? (STATUT_CRM[ex.statut] || ex.statut) : null,
        nouveau_statut: STATUT_CRM[d.statut] || null,
        created_at: estNouveau ? (d.date_creation || nowISO) : nowISO,
      });
    }
    for (const c of chunk(acts, 200)) {
      const { error } = await sb.from('activities').insert(c);
      if (!error) res.activities += c.length;
    }

    return res;
  }

  // 5) QUESTIONNAIRES ENTREPRISES (Hub, 23/11/2026) — bloc ⟦Questionnaire⟧ de la dernière réponse + une entrée d'historique par
  // réponse (une seule fois). Lu APRÈS appliquer() : les notes relues portent déjà le bloc ⟦Hub⟧ du jour. ecrire=false : aperçu.
  // Aperçu (dry-run) des salles jouées : combien de fiches clients la synchro compléterait, et le vocabulaire déjà saisi.
  async function apercuSalles(entreprises) {
    const clients = await fetchAll('clients', 'id,societe,salles_jouees');
    const parCle = new Map(clients.map((c) => [normSociete(c.societe), c]));
    let aCompleter = 0, nouvelles = 0;
    for (const e of entreprises.filter((x) => x.est_societe && x.societe && x.nbHonores > 0)) {
      const c = parCle.get(e.key);
      if (!c) { if (e.salles.size) nouvelles++; continue; }
      if (fusionnerSalles(c.salles_jouees, e.salles) !== (c.salles_jouees || '')) aCompleter++;
    }
    const mots = new Map();
    for (const c of clients) for (const m of morceaux(c.salles_jouees)) { const k = m.toUpperCase(); mots.set(k, (mots.get(k) || 0) + 1); }
    return { clients: clients.length, avecSalles: clients.filter((c) => String(c.salles_jouees || '').trim()).length, aCompleter, nouvelles, mots };
  }

  async function questionnaires(liste, { ecrire = true } = {}) {
    const prospects = await fetchAll('prospects', 'id,societe,notes');
    const clients = await fetchAll('clients', 'id,societe,notes,satisfaction');
    const planCli = planClientsQuestionnaires(liste, clients);
    const deja = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('activities').select('description').eq('action_type', ACTION_QUESTIONNAIRE).range(from, from + 999);
      if (error) throw new Error(`activities (questionnaires) : ${error.message}`);
      deja.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    const plan = planQuestionnaires(liste, { prospects, dejaNotes: idsDejaNotes(deja) });
    const res = { recus: (liste || []).length, rattaches: plan.rattaches, non_rattaches: plan.non_rattaches, nouvelles: plan.activites.length, fiches: plan.notes.length, clients: planCli.length, ecrit: false };
    if (!ecrire) return res;
    await enParallele(plan.notes, parallele, async (x) => {
      const { error } = await sb.from('prospects').update({ notes: x.notes }).eq('id', x.id);
      if (error) throw new Error(`prospects (questionnaire) : ${error.message}`);
    });
    for (const c of chunk(plan.activites, 200)) {
      const { error } = await sb.from('activities').insert(c);
      if (error) throw new Error(`activities (questionnaire) : ${error.message}`);
    }
    await enParallele(planCli, parallele, async (x) => {
      const { error } = await sb.from('clients').update(x.maj).eq('id', x.id);
      if (error) throw new Error(`clients (questionnaire) : ${error.message}`);
    });
    return { ...res, ecrit: true };
  }

  return { chargerDevis, appliquer, debutRun, finRun, questionnaires, apercuSalles };
}
