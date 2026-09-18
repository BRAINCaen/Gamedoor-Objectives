// Deux scores /10, indépendants (choix retenu avec Polar) :
//   · VALEUR    = qualité du CLIENT avéré (pondéré CA + récurrence + facilité)
//   · POTENTIEL = intérêt du PROSPECT à travailler (devis en cours, société, ré-achat)
// Bornés 1..10. Grille durcie pour ÉTALER la distribution (éviter le pic à 9).

const MOIS = (a, b) => (a && b) ? (b - a) / (30.44 * 864e5) : Infinity;
const borne = (n) => Math.max(1, Math.min(10, Math.round(n)));

// Seuils = QUARTILES (3 bornes → rang 0..4), calculés sur la base pour rendre
// le CA/montant RELATIFS à ton activité (se recalibrent tout seuls).
export function calcSeuils(entreprises) {
  const quart = (arr) => {
    const v = arr.filter((x) => x > 0).sort((a, b) => a - b);
    if (v.length < 4) return [0, 0, 0];
    return [v[Math.floor(v.length / 4)], v[Math.floor(v.length / 2)], v[Math.floor((3 * v.length) / 4)]];
  };
  const [caQ1, caQ2, caQ3] = quart(entreprises.map((e) => e.ca));
  const [enQ1, enQ2, enQ3] = quart(entreprises.map((e) => e.montantEncours));
  return { caQ1, caQ2, caQ3, enQ1, enQ2, enQ3 };
}

// rang 0..4 selon trois seuils (quartiles)
const rang4 = (v, q1, q2, q3) => (v <= 0 ? 0 : v < q1 ? 1 : v < q2 ? 2 : v < q3 ? 3 : 4);

// VALEUR — seulement pour une entreprise ayant au moins un devis honoré.
// Renvoie null sinon. Max = CA(4) + récurrence(4) + facilité(2) = 10.
export function scoreValeur(e, s, now = new Date()) {
  if (!e.nbHonores) return null;

  // CA (0-4) — relatif à la base (quartiles)
  const ca = rang4(e.ca, s.caQ1, s.caQ2, s.caQ3);

  // Récurrence (0-4) — paliers exigeants ; une seule venue ne « fidélise » pas
  let rec = e.nbHonores >= 6 ? 4 : e.nbHonores >= 4 ? 3 : e.nbHonores >= 3 ? 2 : e.nbHonores >= 2 ? 1 : 0;
  if (e.dernierHonore && MOIS(e.dernierHonore, now) > 24) rec = Math.max(0, rec - 1); // dormant

  // Facilité de relation (0-2) — significative surtout au-delà de 3 devis
  const taux = e.nbTotal ? e.nbHonores / e.nbTotal : 0;
  let fac;
  if (e.nbTotal >= 3) fac = taux >= 0.75 ? 2 : taux >= 0.5 ? 1 : 0;
  else fac = 1; // trop peu de devis pour juger → neutre
  // Malus sur des signaux RELATIFS (un gros client a mécaniquement plus
  // d'annulations/reste dû en volume, ce n'est pas un défaut) : impayé
  // SIGNIFICATIF (>20% du CA) ou fort TAUX d'annulation.
  const tauxAnnul = e.nbTotal ? e.nbAnnules / e.nbTotal : 0;
  if (e.resteDuSouffrance > 0.2 * e.ca) fac -= 1;
  if (tauxAnnul > 0.4) fac -= 1;
  fac = Math.max(0, fac);

  return borne(ca + rec + fac);
}

// POTENTIEL — intérêt commercial d'un prospect (0..10).
export function scorePotentiel(e, s, now = new Date()) {
  let p = 0;

  // Devis en cours (0-6) : montant (0-4) + fraîcheur (0-2)
  if (e.aEncours) {
    p += rang4(e.montantEncours, s.enQ1, s.enQ2, s.enQ3);
    const dernierCree = e.devis
      .filter((d) => d.date_creation)
      .map((d) => new Date(d.date_creation))
      .sort((a, b) => b - a)[0];
    const j = dernierCree ? (now - dernierCree) / 864e5 : Infinity;
    if (j < 30) p += 2; else if (j < 90) p += 1;
  }

  // Société B2B (0-1)
  if (e.est_societe) p += 1;

  // Déjà venu par le passé (0-3) : un ré-achat est très chaud
  if (e.nbHonores >= 3) p += 3; else if (e.nbHonores >= 1) p += 2;

  return borne(p || 1);
}
