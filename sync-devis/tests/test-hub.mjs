// Source « Hub » de la synchro des devis (lib/hub.mjs) + règles d'écriture (lib/store.mjs) : hors ligne, aucune donnée réelle.
//   node tests/test-hub.mjs
import { generateKeyPairSync, verify } from 'node:crypto';
import { transformHub, statutSynchro, fetchHub } from '../lib/hub.mjs';
import { remplacerBloc, garderConnu } from '../lib/store.mjs';
import { grouperParEntreprise, STATUTS_FIGES, STATUT_CRM } from '../lib/transform.mjs';

let ok = 0, ko = 0;
const verif = (c, t) => { if (c) { ok++; console.log('✓', t); } else { ko++; console.log('✗', t); } };

// --- Statuts : ceux de 4escape repris un pour un, ceux propres au Hub traduits ---
const S = (statut, type = 'devis', etat = 'en_cours') => statutSynchro({ statut, type, etat });
verif(S('payee', 'commande') === 'completed' && S('remboursee', 'commande') === 'refunded' && S('en_attente_paiement', 'commande') === 'on-hold'
  && S('en_attente_confirmation') === 'pending' && S('annulee', 'devis', 'perdu') === 'cancelled' && S('inachevee', 'devis', 'perdu') === 'failed',
  'statuts de 4escape retrouvés à l’identique (aucun faux changement à la bascule)');
verif(S('payee', 'commande', 'en_cours') === 'completed', 'commande payée de 4escape : payée, même si la page Devis la lit « en cours »');
verif(S('en_attente_confirmation', 'devis', 'expire') === 'expired' && S('expire', 'devis', 'expire') === 'expired', 'validité passée : expired');
verif(S('en_attente_confirmation', 'devis', 'gagne') === 'completed', '« venu et réglé dans 4escape » : payé');
verif(S('en_attente_confirmation', 'devis', 'remplace') === null && S('annulee', 'devis', 'sans_suite') === null, 'repris dans le Hub / sans suite : écartés');
verif(S('a_reprogrammer', 'commande', 'gagne') === 'on-hold', 'à reprogrammer : engagé (on-hold)');
verif(S('statut_futur') === 'hub:statut_futur', 'statut inconnu signalé, jamais confondu');
verif(STATUTS_FIGES.has('expired') && STATUT_CRM.expired === 'Relance', 'expired : figé, à relancer dans le CRM');

// --- Transformation d'une réponse du pont ---
const reponse = { ok: true, nombre: 6, devis: [
  { reference: '2026-D0097', type: 'commande', statut: 'payee', etat: 'en_cours', societe: 'Poste centrale', est_societe: true, montant_ttc: 900, reste_du: 0, produits: ['Privatisation Etablissement'] },
  { reference: '2026-D0101', type: 'devis', statut: 'en_attente_confirmation', etat: 'expire', societe: 'ACME', est_societe: true, client_nom: 'Jean Dupont', client_email: 'Jean@ACME.fr', montant_ttc: 480, reste_du: 480, joueurs: 12, cree_le: '2026-09-01T10:00:00.000Z', echeance: '2026-10-01T22:00:00.000Z', date_evenement: '2026-11-08T13:00:00.000Z', produits: ['PSYCHIATRIC', 'Plateau repas'] },
  { reference: '2026-D0110', type: 'devis', statut: 'en_attente_confirmation', etat: 'remplace', societe: 'BETA', est_societe: true },
  { reference: 'HD-2026-0002', type: 'devis', statut: 'en_attente_confirmation', etat: 'en_cours', societe: 'BETA', est_societe: true, client_telephone: '0601020304', cree_par: 'Polar', source_vente: 'offer', montant_ttc: 250, cree_le: '2026-11-05T09:00:00.000Z' },
  { reference: 'HD-2026-0003', type: 'commande', reference_commande: 'H-2026-0040', statut: 'en_attente_paiement', etat: 'gagne', client_nom: 'Marie Martin', est_societe: false, montant_ttc: 120 },
  { reference: 'HD-2026-0003', type: 'commande', statut: 'payee', etat: 'gagne' }, // doublon : ignoré
] };
const { devis, ignores } = transformHub(reponse);
const par = Object.fromEntries(devis.map((d) => [d.reference, d]));
verif(devis.length === 4 && ignores.remplaces === 1 && !par['2026-D0110'], '4 devis gardés, le devis repris dans le Hub écarté, le doublon ignoré');
verif(par['2026-D0097'].societe === 'LA POSTE' && par['2026-D0097'].privatisation === true, 'correction ponctuelle 2026-D0097 (LA POSTE) toujours appliquée, privatisation vue');
const d1 = par['2026-D0101'];
verif(d1.annee === 2026 && d1.type_ref === 'D' && d1.numero === 101 && d1.statut === 'expired', 'référence 4escape découpée, statut expired');
verif(d1.contact_email === 'jean@acme.fr' && d1.due_date === '2026-10-02' && d1.date_evenement === '2026-11-08' && d1.nb_joueurs === 12 && d1.repas === true && d1.produits === 'PSYCHIATRIC · Plateau repas', 'email en minuscules, dates au jour de Paris (minuit ne glisse pas à la veille), joueurs, repas');
const h2 = par['HD-2026-0002'];
verif(h2.annee === 2026 && h2.type_ref === 'HD' && h2.numero === 2 && h2.statut === 'pending' && h2.contact_tel === '0601020304' && h2.contact_interne === 'Polar' && h2.source === 'offer', 'devis du Hub : HD-2026-0002 découpé, téléphone, auteur, source');
verif(par['HD-2026-0003'].statut === 'on-hold' && par['HD-2026-0003'].est_societe === false, 'devis du Hub validé : on-hold, particulier');
const cols = ['reference', 'annee', 'type_ref', 'numero', 'societe', 'est_societe', 'client_nom', 'contact_email', 'contact_tel', 'montant_ttc', 'reste_du', 'nb_joueurs', 'statut', 'date_validation', 'date_evenement', 'date_creation', 'due_date', 'recall_date', 'date_cloture', 'produits', 'privatisation', 'repas', 'contact_interne', 'source', '_key'];
verif(devis.every((d) => JSON.stringify(Object.keys(d).sort()) === JSON.stringify([...cols].sort())), 'mêmes colonnes que transform() (table Supabase devis)');
const ent = grouperParEntreprise(devis);
const beta = ent.find((e) => e.societe === 'BETA');
verif(beta && beta.aEncours && beta.montantEncours === 250, 'BETA : le devis HD en cours compte, l’ancien devis repris ne compte pas deux fois');
const acme = ent.find((e) => e.societe === 'ACME');
verif(acme && !acme.aEncours && acme.montantEncours === 0, 'ACME : un devis expiré ne compte plus comme montant en cours');

// --- Notes : l'ancien bloc ⟦4escape⟧ devient ⟦Hub⟧, le texte manuel reste ---
const notes = 'Appelé le 3/10, rappeler en janvier.\n\n⟦4escape⟧\n— 4escape : 3 devis\nCA réalisé : 900 €\n⟦/4escape⟧\n\n⟦INSEE⟧\nSIREN 123\n⟦/INSEE⟧';
const n1 = remplacerBloc(notes, '— Hub : 4 devis', 'Hub');
verif(n1.includes('⟦Hub⟧\n— Hub : 4 devis\n⟦/Hub⟧') && !n1.includes('⟦4escape⟧') && n1.startsWith('Appelé le 3/10') && n1.includes('⟦INSEE⟧\nSIREN 123'), 'bloc ⟦4escape⟧ remplacé par ⟦Hub⟧, notes manuelles et bloc INSEE intacts');
verif(remplacerBloc(n1, '— Hub : 4 devis', 'Hub') === n1, 'rejouer ne change rien (idempotent)');
verif(remplacerBloc('', 'x', 'Hub') === '⟦Hub⟧\nx\n⟦/Hub⟧' && remplacerBloc('a', 'x $& $1', 'Hub') === 'a\n\n⟦Hub⟧\nx $& $1\n⟦/Hub⟧', 'fiche sans bloc : ajouté une fois ; « $ » dans le texte sans effet');
verif(remplacerBloc('⟦Hub⟧\nvieux\n⟦/Hub⟧', 'neuf $1', 'Hub') === '⟦Hub⟧\nneuf $1\n⟦/Hub⟧', 'remplacement littéral (pas de motif $ interprété)');

// --- Valeurs connues gardées quand la source est vide ---
const row = garderConnu({ contact_tel: null, date_validation: null, societe: 'ACME', montant_ttc: 0, statut: 'pending' }, { contact_tel: '0611', date_validation: '2026-09-02', societe: 'ACME SAS', montant_ttc: 480, statut: 'on-hold' });
verif(row.contact_tel === '0611' && row.date_validation === '2026-09-02' && row.societe === 'ACME' && row.montant_ttc === 0 && row.statut === 'pending', 'téléphone et date gardés ; société, montant et statut de la source prioritaires');

// --- Requête signée vers le pont ---
const paire = generateKeyPairSync('ed25519');
let vu = null;
const faux = async (url, opt) => { vu = { url, opt }; return new Response(JSON.stringify({ ok: true, devis: [] }), { status: 200 }); };
await fetchHub({ url: 'https://hub.test/', cle: paire.privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl: faux });
const h = vu.opt.headers;
verif(vu.url === 'https://hub.test/api/pont/crm-devis' && vu.opt.method === 'POST' && /^\d{13}$/.test(h['X-Pont-Horodatage']), 'POST vers /api/pont/crm-devis, horodatage en ms');
verif(verify(null, Buffer.from(`${h['X-Pont-Horodatage']}.${vu.opt.body}`), paire.publicKey, Buffer.from(h['X-Pont-Signature'], 'base64')), 'signature Ed25519 vérifiable avec la clé publique');
let erreur = null;
await fetchHub({ url: 'https://hub.test', cle: paire.privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl: async () => new Response(JSON.stringify({ erreur: 'Signature invalide.' }), { status: 401 }) }).catch((e) => { erreur = e; });
verif(erreur && /401/.test(erreur.message) && /Signature invalide/.test(erreur.message), 'refus du Hub remonté tel quel (pas de nouvel essai sur 401)');
erreur = null; await fetchHub({ cle: '' }).catch((e) => { erreur = e; });
verif(erreur && /HUB_PONT_CRM_CLE_PRIVEE/.test(erreur.message), 'clé absente : message clair');

console.log(`\n${ok} vérifications réussies, ${ko} en échec`); process.exit(ko ? 1 : 0);
