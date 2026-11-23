// Salles et activités jouées par une entreprise (filtres « Quiz », « Escape game », salle précise de l'onglet Clients du CRM,
// 23/11/2026). Module PUR (tests : tests/test-hub.mjs).
// Familles reprises du Hub (src/lib/familles.js du dépôt GAMEDOOR-HUB) : Escape = les salles (Psychiatric, Garde à vue, qui
// s'appelait In Prison, Back to the 80's…), Quiz = Buzz Your Brain, Action = Escape Box (hors les murs).
// La colonne clients.salles_jouees reste du texte libre (saisie à la main ou import historique) : la synchro n'y AJOUTE que les
// salles des devis honorés qui n'y sont pas encore, sous leur nom du Hub ; elle n'efface ni ne renomme jamais rien.

export const SALLES = [
  { cle: 'psy', nom: 'PSYCHIATRIC', famille: 'escape', re: /psych|\bpsy\b/i },
  { cle: 'gav', nom: 'GARDE À VUE', famille: 'escape', re: /garde\s*[àa]\s*vue|prison/i },
  { cle: '80s', nom: "BACK TO THE 80'S", famille: 'escape', re: /back\s*to\s*the\s*80|ann[ée]es\s*80|\b80'?s\b/i },
  { cle: 'backrooms', nom: 'BACKROOMS', famille: 'escape', re: /backroom/i },
  { cle: 'phobie', nom: 'PHOBIE', famille: 'escape', re: /phobi/i },
  { cle: 'episode', nom: 'EPISODE', famille: 'escape', re: /[ée]pisode/i },
  { cle: 'quiz', nom: 'BUZZ YOUR BRAIN', famille: 'quiz', re: /quiz|buzz/i },
  { cle: 'box', nom: 'ESCAPE BOX', famille: 'action', re: /escape\s*box|escape\s*game\s*sur\s*site/i }, // hors les murs
];
const PAR_CLE = new Map(SALLES.map((s) => [s.cle, s]));

/** Clés des salles citées dans un texte (produits d'un devis « A · B », ou salles_jouees « A, B »). */
export function sallesDuTexte(texte) {
  const t = String(texte || '');
  return new Set(t ? SALLES.filter((s) => s.re.test(t)).map((s) => s.cle) : []);
}

/** Morceaux d'une liste saisie (« PSYCHIATRIC, IN PRISON » ; « A · B » ; une par ligne). */
export const morceaux = (texte) => String(texte || '').split(/\s*(?:[,;\n]|\s·\s)\s*/).map((x) => x.trim()).filter(Boolean);

/**
 * salles_jouees complétée par les salles `cles` qui n'y sont pas encore (une salle déjà citée sous un autre nom, ex. « IN PRISON »
 * pour Garde à vue, compte comme présente). Rend le texte d'origine, inchangé au caractère près, s'il n'y a rien à ajouter.
 */
export function fusionnerSalles(existant, cles) {
  const avant = String(existant || '');
  const deja = sallesDuTexte(avant);
  const ajouts = SALLES.filter((s) => cles && cles.has(s.cle) && !deja.has(s.cle)).map((s) => s.nom);
  if (!ajouts.length) return avant;
  return [...morceaux(avant), ...ajouts].join(', ');
}

/** Familles (escape, quiz, action) d'un ensemble de clés de salles. */
export const famillesDe = (cles) => new Set([...(cles || [])].map((k) => (PAR_CLE.get(k) || {}).famille).filter(Boolean));
