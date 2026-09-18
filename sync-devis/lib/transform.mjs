// Transforme les DEUX exports 4escape (résumé « entêtes de commande » +
// détail « lignes de commande ») en une liste de devis normalisés, prête à
// être comparée à la table `devis` de Supabase.

import { parseObjects, num, dateFR, iso, isoTs, normSociete } from './csv.mjs';

const RE_PRIVA = /privatisation/i;
const RE_REPAS = /restauration|traiteur|viennoiserie|boisson|cocktail|ap[ée]ritif|repas/i;

// statuts qui NE bougeront plus (inutile de re-vérifier / réécrire l'historique)
export const STATUTS_FIGES = new Set(['completed', 'refunded', 'cancelled', 'failed']);
// statuts qui comptent comme « honoré » (CA réalisé)
export const STATUTS_HONORES = new Set(['completed', 'refunded']);

// statut technique 4escape -> statut CRM (repris du CRM existant)
export const STATUT_CRM = {
  completed: 'Client', refunded: 'Client',
  'on-hold': 'Devis envoyé', pending: 'Relance',
  cancelled: 'Perdu', failed: 'Perdu',
};

// Corrections ponctuelles de fiches 4escape mal saisies (repris du CRM)
const OVERRIDES = {
  '2026-D0097': { societe: 'LA POSTE', est_societe: true },
};

export function transform(resumeCSV, detailCSV) {
  const resume = parseObjects(resumeCSV);
  const detail = detailCSV ? parseObjects(detailCSV) : [];

  // produits par référence (depuis le détail)
  const prodsParRef = {};
  for (const l of detail) {
    const ref = l['Reference'];
    if (!ref) continue;
    (prodsParRef[ref] = prodsParRef[ref] || []).push(l['Produit'] || '');
  }

  const devis = [];
  for (const r of resume) {
    const ref = (r['Reference'] || '').trim();
    if (!ref) continue;
    const ov = OVERRIDES[ref] || {};

    const m = ref.match(/^(\d{4})-([A-Za-z])(\d+)/);
    const annee = m ? +m[1] : 0;
    const type_ref = m ? m[2].toUpperCase() : '?';
    const numero = m ? +m[3] : 0;

    const prods = prodsParRef[ref] || [];
    const statut = (r['Status'] || '').trim();

    devis.push({
      reference: ref,
      annee, type_ref, numero,
      societe: (ov.societe || r['Société'] || '').trim(),
      est_societe: ov.est_societe !== undefined ? ov.est_societe : (r['Est Societé'] === 'OUI'),
      client_nom: (r['Contact'] || '').trim(),
      contact_email: (r['Contact Email'] || '').trim().toLowerCase() || null,
      contact_tel: (r['Contact Portable'] || '').trim() || null,
      montant_ttc: num(r['Montant TTC']),
      reste_du: num(r['Total reste dû']),
      nb_joueurs: parseInt(r['Nombre de joueurs'] || '0', 10) || null,
      statut,
      date_validation: iso(dateFR(r['Date validation'])),
      date_evenement: iso(dateFR(r['Date evenement'])),
      date_creation: isoTs(dateFR(r['Created On'])),
      due_date: iso(dateFR(r['Due Date'])),
      recall_date: iso(dateFR(r['Recall Date'])),
      date_cloture: iso(dateFR(r['Date de clôture'])),
      produits: [...new Set(prods.filter(Boolean))].join(' · ') || null,
      privatisation: prods.some((p) => RE_PRIVA.test(p)),
      repas: prods.some((p) => RE_REPAS.test(p)),
      contact_interne: (r['Contact interne'] || '').trim() || null,
      source: (r['Source'] || '').trim() || null,
      // champ interne, non stocké tel quel : clé de regroupement par entreprise
      _key: normSociete(ov.societe || r['Société'] || r['Contact'] || ref),
    });
  }
  return devis;
}

// Regroupe les devis par entreprise (clé normalisée) -> agrégats servant au
// scoring et aux fiches prospects/clients.
export function grouperParEntreprise(devis) {
  const now = new Date();
  const g = {};
  for (const d of devis) {
    const k = d._key;
    const e = g[k] || (g[k] = {
      key: k, societe: d.societe || d.client_nom, est_societe: d.est_societe,
      noms: new Set(), emails: new Set(), tels: new Set(),
      devis: [], ca: 0, nbHonores: 0, nbTotal: 0,
      nbAnnules: 0, resteDuSouffrance: 0,
      priva: false, repas: false,
      dernierHonore: null, prochainEvent: null,
      aEncours: false, montantEncours: 0,
    });
    if (d.societe) e.noms.add(d.societe);
    if (d.contact_email) e.emails.add(d.contact_email);
    if (d.contact_tel) e.tels.add(d.contact_tel);
    e.devis.push(d);
    e.nbTotal++;
    if (d.privatisation) e.priva = true;
    if (d.repas) e.repas = true;

    const ev = d.date_evenement ? new Date(d.date_evenement) : null;
    if (STATUTS_HONORES.has(d.statut)) {
      e.ca += d.montant_ttc;
      e.nbHonores++;
      if (ev && (!e.dernierHonore || ev > e.dernierHonore)) e.dernierHonore = ev;
      if (d.reste_du > 0) e.resteDuSouffrance += d.reste_du; // payé mais reste dû
    }
    if (d.statut === 'cancelled' || d.statut === 'failed') e.nbAnnules++;
    if (!STATUTS_FIGES.has(d.statut)) { // on-hold / pending = en cours
      e.aEncours = true;
      e.montantEncours += d.montant_ttc;
      if (ev && ev >= now && (!e.prochainEvent || ev < e.prochainEvent)) e.prochainEvent = ev;
    }
  }
  return Object.values(g);
}
