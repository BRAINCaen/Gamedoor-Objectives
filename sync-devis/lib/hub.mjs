// Source « Hub » de la synchro (depuis la bascule du 02/11/2026 : GAMEDOOR·41 n'utilise plus 4escape, son propre logiciel,
// le Hub, gère réservations, caisse et devis). Lit les devis par le pont signé du Hub (POST /api/pont/crm-devis, dépôt
// BRAINCaen/GAMEDOOR-HUB, docs/pont-crm-devis.md) et les rend EXACTEMENT sous la forme que produisait transform() à partir
// des CSV de 4escape : diff, scores, notes et historique (store.mjs) ne changent pas.
//
// Env : HUB_PONT_CRM_CLE_PRIVEE (clé privée Ed25519, PEM ou PKCS8 DER en base64 — secret GitHub, jamais dans le code),
//       HUB_URL (défaut https://synergia-hub.netlify.app).

import { createPrivateKey, sign } from 'node:crypto';
import { normSociete } from './csv.mjs';
import { OVERRIDES } from './transform.mjs';

// Mêmes motifs que transform.mjs (lignes des CSV de 4escape).
const RE_PRIVA = /privatisation/i;
const RE_REPAS = /restauration|traiteur|viennoiserie|boisson|cocktail|ap[ée]ritif|repas/i;

// Statut brut du Hub -> vocabulaire de la synchro (celui de 4escape, que le Hub reprend un pour un depuis son import).
// Ainsi un devis de 4escape garde dans le CRM exactement le statut qu'il avait : la bascule ne crée aucun faux changement.
const STATUT_HUB = {
  payee: 'completed', remboursee: 'refunded',
  en_attente_paiement: 'on-hold', a_reprogrammer: 'on-hold',
  en_attente_confirmation: 'pending',
  annulee: 'cancelled', inachevee: 'failed',
  expire: 'expired',
};

/**
 * Statut de synchro d'un devis du Hub, ou null s'il ne doit plus compter :
 *  · `remplace` (devis de 4escape repris dans le Hub sous une référence HD-…, qui, elle, est suivie) ;
 *  · `sans_suite` (remplacé par la facture directe mensuelle d'un partenaire, Edenred…).
 * Un devis encore « en attente » que la page Devis du Hub lit comme gagné (« venu et réglé dans 4escape ») compte payé ;
 * lu comme expiré (validité passée), il devient 'expired'.
 */
export function statutSynchro(x) {
  const brut = STATUT_HUB[x.statut] || null;
  if (x.type === 'devis') {
    if (x.etat === 'remplace' || x.etat === 'sans_suite') return null;
    if (brut === 'pending' && x.etat === 'gagne') return 'completed';
    if (brut === 'pending' && x.etat === 'expire') return 'expired';
  }
  return brut || (x.statut ? `hub:${x.statut}` : null);
}

// Jour à l'heure de Paris (comme les CSV de 4escape) : une validité à minuit ne glisse pas à la veille.
const JOUR_PARIS = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const jour = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : JOUR_PARIS.format(d); };
function decouperReference(ref, creeLe) {
  let m = ref.match(/^(\d{4})-([A-Za-z])(\d+)/);                     // 4escape : 2026-D0097
  if (m) return { annee: +m[1], type_ref: m[2].toUpperCase(), numero: +m[3] };
  m = ref.match(/^([A-Za-z]+)-(\d{4})-(\d+)/);                        // Hub : HD-2026-0012
  if (m) return { annee: +m[2], type_ref: m[1].toUpperCase(), numero: +m[3] };
  return { annee: creeLe ? +String(creeLe).slice(0, 4) || 0 : 0, type_ref: '?', numero: 0 };
}

/** Réponse du pont -> { devis, ignores } ; `devis` a la forme de transform() (même colonnes que la table Supabase `devis`). */
export function transformHub(reponse) {
  const devis = [], ignores = { remplaces: 0, sans_suite: 0, inconnus: {} };
  const vus = new Set();
  for (const x of (reponse && reponse.devis) || []) {
    const ref = String(x.reference || '').trim();
    if (!ref || vus.has(ref)) continue;
    vus.add(ref);
    const statut = statutSynchro(x);
    if (!statut) { if (x.etat === 'sans_suite') ignores.sans_suite++; else ignores.remplaces++; continue; }
    if (statut.startsWith('hub:')) ignores.inconnus[statut] = (ignores.inconnus[statut] || 0) + 1;
    const ov = OVERRIDES[ref] || {};
    const societe = (ov.societe || x.societe || '').trim();
    const prods = (x.produits || []).filter(Boolean);
    devis.push({
      reference: ref,
      ...decouperReference(ref, x.cree_le),
      societe,
      est_societe: ov.est_societe !== undefined ? ov.est_societe : !!x.est_societe,
      client_nom: (x.client_nom || '').trim(),
      contact_email: (x.client_email || '').trim().toLowerCase() || null,
      contact_tel: (x.client_telephone || '').trim() || null,
      montant_ttc: Number(x.montant_ttc) || 0,
      reste_du: Number(x.reste_du) || 0,
      nb_joueurs: parseInt(x.joueurs, 10) || null,
      statut,
      date_validation: jour(x.valide_le),
      date_evenement: jour(x.date_evenement),
      date_creation: x.cree_le || null,
      due_date: jour(x.echeance),
      recall_date: jour(x.rappel),
      date_cloture: null,
      produits: [...new Set(prods)].join(' · ') || null,
      privatisation: prods.some((p) => RE_PRIVA.test(p)),
      repas: prods.some((p) => RE_REPAS.test(p)),
      contact_interne: (x.cree_par || '').trim() || null,
      source: (x.source_vente || '').trim() || null,
      _key: normSociete(ov.societe || x.societe || x.client_nom || ref),
    });
  }
  return { devis, ignores };
}

function clePrivee(texte) {
  const v = String(texte || '').replace(/\\n/g, '\n').trim();
  if (!v) throw new Error('HUB_PONT_CRM_CLE_PRIVEE manquante : la clé du robot doit être dans les secrets GitHub du dépôt.');
  return createPrivateKey(v.includes('BEGIN') ? v : { key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' });
}

/** Appelle le pont du Hub (requête signée) et renvoie sa réponse JSON. */
export async function fetchHub({ url = process.env.HUB_URL || 'https://synergia-hub.netlify.app', cle = process.env.HUB_PONT_CRM_CLE_PRIVEE, fetchImpl = fetch } = {}) {
  const k = clePrivee(cle);
  const corps = '{}', horodatage = String(Date.now());
  const signature = sign(null, Buffer.from(`${horodatage}.${corps}`), k).toString('base64');
  const point = `${url.replace(/\/+$/, '')}/api/pont/crm-devis`;
  let derniere;
  for (let essai = 1; essai <= 3; essai++) {
    try {
      const r = await fetchImpl(point, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pont-Horodatage': horodatage, 'X-Pont-Signature': signature }, body: corps });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) return j;
      derniere = new Error(`Hub ${r.status} : ${j.erreur || 'réponse inattendue'}`);
      if (r.status === 401 || r.status === 405) break; // inutile d'insister : clé ou adresse à corriger
    } catch (e) { derniere = e; }
    if (essai < 3) await new Promise((res) => setTimeout(res, 3000 * essai));
  }
  throw derniere;
}
