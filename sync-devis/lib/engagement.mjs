// RÈGLE DE SCORE PARTAGÉE — source de vérité.
//
// ⚠️ Cette fonction existe en DEUX exemplaires identiques :
//      · ici, pour le robot de synchro 4escape (Node) ;
//      · dans dist/crm.html, section « SCORE D'ENGAGEMENT » (navigateur).
//    Les deux doivent rester rigoureusement identiques, sinon le score
//    sauterait d'une valeur à l'autre entre une sauvegarde dans le CRM et la
//    synchro de la nuit suivante. Le test scratchpad compare les deux copies.
//    Si tu modifies ici, recopie là-bas (et inversement).
//
// Composition retenue :
//      score = base + modificateur, borné 1..10
//
//   · base          = ce que vaut l'entreprise « dans l'absolu »
//                     → score POTENTIEL 4escape pour les entreprises connues,
//                       sinon la note posée à la main (5 par défaut).
//   · modificateur  = où en est ce prospect et ce que vaut sa fiche.
//                     Borné à ±4 pour que la base garde le dernier mot :
//                     l'avancement module, il ne remplace pas le potentiel.

export const borne = (n) => Math.max(1, Math.min(10, Math.round(n)));

// Niveau d'avancement dans le pipeline. Un prospect qui a demandé un devis
// est objectivement plus chaud qu'un prospect jamais contacté.
export const AVANCEMENT = {
  'A contacter': -1,   // pas encore engagé : rien ne prouve l'intérêt
  'A appeler': -1,     // ancienne orthographe, même sens
  'Relance': 0,        // a été touché, sans réponse pour l'instant
  'Interesse': 1,
  'Devis envoyé': 2,
  'Client': 3,
};

// Calcule le modificateur et, surtout, explique chaque point compté : c'est ce
// texte qui part dans le journal d'activité.
export function engagement(p) {
  const raisons = [];
  const statut = p.statut || 'A contacter';

  // « Perdu » ne se module pas : l'affaire est close.
  if (statut === 'Perdu') {
    return { perdu: true, modificateur: 0, avancement: 0, fiche: 0, raisons: ['perdu'] };
  }

  const avancement = AVANCEMENT[statut] !== undefined ? AVANCEMENT[statut] : 0;
  if (avancement > 0) raisons.push('avancement ' + statut + ' +' + avancement);
  else if (avancement < 0) raisons.push('jamais engagé ' + avancement);

  // Qualité de la fiche : une fiche injoignable ne vaut rien, même sur un
  // beau potentiel — on ne peut simplement pas lui écrire.
  let fiche = 0;
  const joignable = !!(p.email || p.email_direct || p.telephone);
  if (joignable) { fiche += 1; raisons.push('joignable +1'); }
  else { fiche -= 1; raisons.push('injoignable -1'); }

  if (p.contact_direct) { fiche += 1; raisons.push('décideur identifié +1'); }

  const coches = compteCoches(p.checks_json);
  if (coches >= 5) { fiche += 1; raisons.push('fiche qualifiée ' + coches + '/8 +1'); }

  // L'INSEE signale l'entreprise comme fermée : inutile de la démarcher.
  if (estFermee(p.notes)) { fiche -= 3; raisons.push('signalée FERMÉE -3'); }

  fiche = Math.max(-3, Math.min(2, fiche));
  const modificateur = Math.max(-4, Math.min(4, avancement + fiche));

  return { perdu: false, modificateur, avancement, fiche, raisons };
}

// Score final à partir d'une base connue.
export function scoreFinal(base, p) {
  const e = engagement(p);
  const score = e.perdu ? 1 : borne((Number(base) || 5) + e.modificateur);
  return { score, ...e };
}

function compteCoches(checks) {
  if (!checks) return 0;
  try {
    const o = typeof checks === 'string' ? JSON.parse(checks) : checks;
    return Object.values(o).filter(Boolean).length;
  } catch (_) {
    return 0;
  }
}

// Le bloc ⟦INSEE⟧ des notes porte la mention quand l'établissement est fermé.
function estFermee(notes) {
  return /Entreprise\s+FERM/i.test(String(notes || ''));
}
