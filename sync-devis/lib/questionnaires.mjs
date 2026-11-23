// Réponses au questionnaire entreprises (Hub, 23/11/2026) → fiche entreprise du CRM. Module PUR (tests : tests/test-hub.mjs).
// Le pont du Hub (/api/pont/crm-devis) les joint aux devis (champ `questionnaires`, sans les essais de l'équipe). Pour chaque
// entreprise retrouvée (même nom normalisé que ses devis) :
//  · un bloc de note ⟦Questionnaire⟧…⟦/Questionnaire⟧ = sa DERNIÈRE réponse (remplacé, jamais empilé, notes manuelles intactes) :
//    satisfaction, recommandation, envie de revenir, et surtout ce qu'on a le droit de publier et où (nom, logo, témoignage, photos) ;
//  · une entrée d'historique « Questionnaire » par réponse, une seule fois (identifiant [q_…] dans le texte).
import { normSociete } from './csv.mjs';

export const ACTION = 'questionnaire';
export const ROBOT = 'Questionnaire entreprise';
const RE_BLOC = /⟦Questionnaire⟧[\s\S]*?⟦\/Questionnaire⟧/;
const RE_ID = /\[(q_[0-9a-f]{16})\]/;
const LIB_AUT = { nom: 'citer le nom', logo: 'logo', temoignage: 'témoignage', photos: 'photos / vidéos' };

const date = (v) => { if (!v) return ''; const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[3]}/${m[2]}/${m[1]}`; return ''; };
const jourParis = (iso) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d); };
const court = (s, n = 220) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Clé de l'entreprise (comme les devis) : la société de la commande dans le Hub, sinon le nom saisi dans le questionnaire. */
export const cleEntreprise = (q) => normSociete(q.societe_hub || q.entreprise || '');

/** « satisfaction 5/5 · recommande 9/10 · autorise : citer le nom, logo » */
export function resumeQuestionnaire(q) {
  const p = [];
  if (q.notes && q.notes.globale != null) p.push(`satisfaction ${q.notes.globale}/5`);
  if (q.nps != null) p.push(`recommande ${q.nps}/10`);
  const ok = Object.entries(q.autorisations || {}).filter(([, l]) => l && l.length).map(([k]) => LIB_AUT[k] || k);
  p.push(ok.length ? `autorise : ${ok.join(', ')}` : 'aucune autorisation de communication');
  return p.join(' · ');
}

/** Texte de l'entrée d'historique (une par réponse ; l'identifiant entre crochets évite tout doublon). */
export function descriptionActivite(q) {
  return `Questionnaire du ${jourParis(q.recu_le) || '?'}${q.date_evenement ? ` (venue du ${date(q.date_evenement)})` : ''} — ${resumeQuestionnaire(q)} [${q.id}]`;
}

/** Bloc de note de la dernière réponse d'une entreprise. */
export function blocQuestionnaire(q) {
  const l = [];
  l.push(`📋 Questionnaire du ${jourParis(q.recu_le) || '?'}${q.date_evenement ? ` · venue du ${date(q.date_evenement)}` : ''}${q.participants ? ` · ${q.participants} participants` : ''}${q.referent ? ` · ${q.referent}${q.fonction ? ` (${q.fonction})` : ''}` : ''}`);
  const s = [];
  if (q.notes && q.notes.globale != null) s.push(`Satisfaction ${q.notes.globale}/5`);
  if (q.nps != null) s.push(`recommande ${q.nps}/10`);
  if (q.revenir) s.push(`revenir : ${q.revenir}`);
  if (q.objectif) s.push(`objectif « ${q.objectif} »${q.objectif_atteint ? ` : ${q.objectif_atteint}` : ''}`);
  if (s.length) l.push(s.join(' · '));
  const aut = Object.entries(LIB_AUT).map(([k, lib]) => { const c = (q.autorisations || {})[k] || []; return c.length ? `${lib} (${c.join(', ')})` : null; }).filter(Boolean);
  l.push(aut.length ? `✅ Autorise : ${aut.join(' · ')}` : '⛔ Aucune autorisation de communication');
  const d = [];
  if (aut.length && q.signature) d.push(`témoignage signé : ${q.signature}`);
  if (q.preferences && q.preferences.valider_temoignage) d.push('valider le témoignage avant publication');
  if (q.preferences && q.preferences.valider_photos) d.push('valider les photos avant publication');
  if (q.preferences && q.preferences.sponsorise) d.push('photos utilisables en publicité');
  if (q.compte_reseaux) d.push(`à taguer : ${q.compte_reseaux}`);
  if (d.length) l.push(d.join(' · '));
  if (q.nouveautes) l.push(`Nouveautés : ${q.nouveautes}`);
  const v = [];
  if (q.marque) v.push(`Marqué : « ${court(q.marque)} »`);
  if (q.ameliorer) v.push(`À améliorer : « ${court(q.ameliorer)} »`);
  if (q.anecdote) v.push(`Anecdote : « ${court(q.anecdote)} »`);
  if (v.length) l.push(v.join(' · '));
  return `⟦Questionnaire⟧\n${l.join('\n')}\n⟦/Questionnaire⟧`;
}

/** Remplace (ou ajoute à la fin) le bloc ⟦Questionnaire⟧ ; le reste des notes (manuel, ⟦Hub⟧, ⟦INSEE⟧) est intact. */
export function remplacerBlocQuestionnaire(notes, bloc) {
  const n = String(notes || '');
  if (RE_BLOC.test(n)) return n.replace(RE_BLOC, () => bloc);
  return n.trim() ? `${n.replace(/\s+$/, '')}\n\n${bloc}` : bloc;
}

/**
 * Plan d'écriture : { notes: [{ id, notes }], activites: [...], rattaches, non_rattaches: [noms], deja } à partir des réponses du Hub,
 * des fiches prospects ({ id, societe, notes }) et des identifiants de réponses déjà dans l'historique.
 */
export function planQuestionnaires(questionnaires, { prospects = [], dejaNotes = new Set() } = {}) {
  const parCle = new Map(prospects.map((p) => [normSociete(p.societe), p]));
  const derniere = new Map(); const plan = { notes: [], activites: [], rattaches: 0, non_rattaches: [], deja: 0 };
  for (const q of [...(questionnaires || [])].filter((x) => x && x.id).sort((a, b) => String(a.recu_le).localeCompare(String(b.recu_le)))) {
    const p = parCle.get(cleEntreprise(q));
    if (!p) { plan.non_rattaches.push(q.societe_hub || q.entreprise || '?'); continue; }
    plan.rattaches++;
    derniere.set(p.id, { p, q });
    if (dejaNotes.has(q.id)) { plan.deja++; continue; }
    plan.activites.push({ prospect_id: p.id, prospect_nom: p.societe, user_email: 'robot@gamedoor41', user_name: ROBOT, action_type: ACTION, description: descriptionActivite(q), created_at: q.recu_le || new Date().toISOString() });
  }
  for (const { p, q } of derniere.values()) {
    const notes = remplacerBlocQuestionnaire(p.notes, blocQuestionnaire(q));
    if (notes !== (p.notes || '')) plan.notes.push({ id: p.id, notes });
  }
  return plan;
}

/**
 * Fiches CLIENTS (onglet Clients du CRM, filtres « A répondu », « OK photos »… du 23/11/2026) : le même bloc ⟦Questionnaire⟧ (dernière
 * réponse) dans leurs notes, et la satisfaction (étoiles) prise de la note globale /5 si elle est encore vide (jamais écrasée).
 * Rend [{ id, maj: { notes?, satisfaction? } }], seulement pour les fiches qui changent.
 */
export function planClientsQuestionnaires(questionnaires, clients = []) {
  const parCle = new Map(clients.map((c) => [normSociete(c.societe), c]));
  const derniere = new Map();
  for (const q of [...(questionnaires || [])].filter((x) => x && x.id).sort((a, b) => String(a.recu_le).localeCompare(String(b.recu_le)))) {
    const c = parCle.get(cleEntreprise(q)); if (c) derniere.set(c.id, { c, q });
  }
  const plan = [];
  for (const { c, q } of derniere.values()) {
    const maj = {};
    const notes = remplacerBlocQuestionnaire(c.notes, blocQuestionnaire(q));
    if (notes !== (c.notes || '')) maj.notes = notes;
    const g = q.notes ? Number(q.notes.globale) : NaN;
    if (!c.satisfaction && Number.isInteger(g) && g >= 1 && g <= 5) maj.satisfaction = g;
    if (Object.keys(maj).length) plan.push({ id: c.id, maj });
  }
  return plan;
}

/** Identifiants [q_…] déjà présents dans l'historique. */
export const idsDejaNotes = (activites) => new Set((activites || []).map((a) => (String(a.description || '').match(RE_ID) || [])[1]).filter(Boolean));
