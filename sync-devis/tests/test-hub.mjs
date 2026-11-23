// Source « Hub » de la synchro des devis (lib/hub.mjs) + règles d'écriture (lib/store.mjs) : hors ligne, aucune donnée réelle.
//   node tests/test-hub.mjs
import { generateKeyPairSync, verify } from 'node:crypto';
import { transformHub, statutSynchro, fetchHub } from '../lib/hub.mjs';
import { remplacerBloc, garderConnu, makeStore, enParallele } from '../lib/store.mjs';
import { calcSeuils } from '../lib/score.mjs';
import { blocQuestionnaire, remplacerBlocQuestionnaire, planQuestionnaires, planClientsQuestionnaires, idsDejaNotes, descriptionActivite } from '../lib/questionnaires.mjs';
import { sallesDuTexte, fusionnerSalles, famillesDe } from '../lib/activites.mjs';
import { normSociete } from '../lib/csv.mjs';
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
  { reference: 'HD-2026-0090', type: 'devis', statut: 'annulee', etat: 'perdu', societe: 'TEST HUB SARL', est_societe: true, montant_ttc: 10 },
  { reference: 'HD-2026-0091', type: 'devis', statut: 'en_attente_confirmation', etat: 'en_cours', societe: '', client_nom: 'test hub', montant_ttc: 10 },
  { reference: 'HD-2026-0092', type: 'devis', statut: 'en_attente_confirmation', etat: 'en_cours', societe: 'TESTA HUBERT SAS', est_societe: true, montant_ttc: 300 },
] };
const { devis, ignores } = transformHub(reponse);
const par = Object.fromEntries(devis.map((d) => [d.reference, d]));
verif(devis.length === 5 && ignores.remplaces === 1 && !par['2026-D0110'], '5 devis gardés, le devis repris dans le Hub écarté, le doublon ignoré');
verif(ignores.essais === 2 && !par['HD-2026-0090'] && !par['HD-2026-0091'] && par['HD-2026-0092'], 'devis d\'essai « TEST HUB » écartés (société ou nom), une vraie société au nom voisin gardée');
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

// --- Écriture (store.appliquer) sur un Supabase simulé : en parallèle = exactement les mêmes écritures qu'une par une ---
function fauxSupabase(base) {
  const ops = []; let enVol = 0, maxEnVol = 0;
  const attente = (cle) => new Promise((r) => setTimeout(r, (String(cle).length * 7) % 13)); // ordre d'arrivée brassé
  const from = (table) => ({
    select: () => ({
      range: async (a, b) => ({ data: (base[table] || []).slice(a, b + 1), error: null }),
      eq: (col, val) => ({ range: async (a, b) => ({ data: (base[table] || []).filter((x) => x[col] === val).slice(a, b + 1), error: null }) }),
    }),
    upsert: async (rows) => { ops.push(['upsert', table, rows]); return { error: null }; },
    update: (patch) => ({ eq: async (_k, id) => {
      enVol++; maxEnVol = Math.max(maxEnVol, enVol); await attente(id); enVol--;
      ops.push(['update', table, id, patch]); return { error: null };
    } }),
    insert: (rows) => ({
      then: (res, rej) => { ops.push(['insert', table, rows]); return Promise.resolve({ error: null }).then(res, rej); },
      select: () => ({ single: async () => {
        enVol++; maxEnVol = Math.max(maxEnVol, enVol); await attente(rows.societe); enVol--;
        ops.push(['insert', table, rows]); return { data: { id: `nouveau-${rows.societe}` }, error: null };
      } }),
    }),
  });
  return { sb: { from }, ops, max: () => maxEnVol };
}
const base = () => ({
  devis: [],
  clients: [{ id: 'c1', societe: 'LA POSTE' }],
  prospects: [{ id: 'p1', societe: 'BETA', notes: 'note manuelle\n⟦Hub⟧ancien⟦/Hub⟧', date_relance: '2026-12-01', email: 'x', email_direct: null, telephone: '', contact_direct: null, checks_json: null }],
  activities: [],
});
const ecrire = async (parallele) => {
  const f = fauxSupabase(base());
  const store = makeStore({ sb: f.sb, parallele });
  const ents = grouperParEntreprise(devis);
  const res = await store.appliquer({ devis, entreprises: ents, plan: { nouveaux: devis, changes: [] }, seuils: calcSeuils(ents), now: new Date('2026-11-23T12:00:00Z') });
  const canon = f.ops.map((o) => JSON.stringify(o)).sort();
  return { res, canon, max: f.max() };
};
const un = await ecrire(1), huit = await ecrire(8);
verif(JSON.stringify(un.canon) === JSON.stringify(huit.canon) && JSON.stringify(un.res) === JSON.stringify(huit.res),
  `écriture 8 à la fois = écriture une par une (${un.canon.length} écritures identiques, ${huit.res.prospects} prospects, ${huit.res.clients} client(s), ${huit.res.activities} activités)`);
verif(un.max === 1 && huit.max > 1, `les fiches partent bien en parallèle (${huit.max} à la fois, contre 1 avant)`);
const actsUn = JSON.parse(un.canon.find((o) => o.includes('"activities"')) || '[0,0,[]]')[2];
verif(actsUn.length > 0 && actsUn.every((a) => a.prospect_id), 'chaque entrée d\'historique reste rattachée à sa fiche (identifiant connu après les écritures parallèles)');
let vus = []; await enParallele([1, 2, 3, 4, 5], 3, async (x) => { vus.push(x); });
verif(vus.sort().join() === '1,2,3,4,5', 'enParallele traite chaque élément une fois et une seule');

// --- Questionnaires entreprises (Hub, 23/11/2026) → fiche entreprise ---
const Q1 = { id: 'q_00000000000000a1', recu_le: '2026-11-24T10:02:10.000Z', entreprise: 'ACME Normandie', societe_hub: 'ACME NORMANDIE SAS', referent: 'Camille Robert', fonction: 'RH', date_evenement: '2026-11-23', participants: 14,
  notes: { globale: 5, accueil: 4 }, nps: 9, revenir: 'Oui, dans les 6 prochains mois', objectif: 'Cohésion d\'équipe', objectif_atteint: 'En partie', autorisations: { nom: ['Site web', 'LinkedIn'], logo: ['LinkedIn'], temoignage: [], photos: ['Instagram', 'LinkedIn'] },
  signature: 'Nom de l\'entreprise', preferences: { valider_photos: true }, compte_reseaux: '@acme_normandie', nouveautes: 'Non merci', marque: 'Le quiz', ameliorer: 'Plus de place', anecdote: '' };
const Q2 = { ...Q1, id: 'q_00000000000000a2', recu_le: '2026-12-10T09:00:00.000Z', date_evenement: '2026-12-09', nps: 10, autorisations: {} };
const QX = { ...Q1, id: 'q_00000000000000b1', entreprise: 'Inconnue SARL', societe_hub: null };
const bq = blocQuestionnaire(Q1);
verif(bq.startsWith('⟦Questionnaire⟧\n📋 Questionnaire du 24/11/2026 · venue du 23/11/2026 · 14 participants · Camille Robert (RH)') && bq.endsWith('⟦/Questionnaire⟧'), 'bloc questionnaire : date, venue, participants, référent');
verif(bq.includes('Satisfaction 5/5 · recommande 9/10 · revenir : Oui, dans les 6 prochains mois') && bq.includes('✅ Autorise : citer le nom (Site web, LinkedIn) · logo (LinkedIn) · photos / vidéos (Instagram, LinkedIn)') && !bq.includes('témoignage ('), 'bloc : notes, recommandation, autorisations canal par canal (témoignage non autorisé absent)');
verif(bq.includes('valider les photos avant publication') && bq.includes('à taguer : @acme_normandie') && bq.includes('Marqué : « Le quiz »') && !bq.includes('Anecdote'), 'bloc : préférences, compte à taguer, verbatims (vides omis)');
verif(blocQuestionnaire(Q2).includes('⛔ Aucune autorisation de communication') && !blocQuestionnaire(Q2).includes('témoignage signé'), 'aucune autorisation : dit clairement, signature du témoignage omise');
const notesFiche = 'Note manuelle : rappeler en janvier\n\n⟦Hub⟧\n— Hub : 2 devis\n⟦/Hub⟧';
const nq1 = remplacerBlocQuestionnaire(notesFiche, bq);
verif(nq1.startsWith(notesFiche) && nq1.endsWith(bq) && remplacerBlocQuestionnaire(nq1, bq) === nq1, 'bloc ajouté à la fin, notes manuelles et bloc ⟦Hub⟧ intacts, rejouer ne change rien');
const nq2 = remplacerBlocQuestionnaire(nq1, blocQuestionnaire(Q2));
verif((nq2.match(/⟦Questionnaire⟧/g) || []).length === 1 && nq2.includes('venue du 09/12/2026') && remplacerBloc(nq2, '⟦Hub⟧\n— Hub : 3 devis\n⟦/Hub⟧').includes('venue du 09/12/2026'), 'nouvelle réponse : bloc remplacé (jamais empilé) ; la synchro des devis ne touche pas au bloc questionnaire');
const fiches = [{ id: 'p1', societe: 'ACME Normandie SAS', notes: notesFiche }, { id: 'p2', societe: 'Autre' }];
const pq = planQuestionnaires([Q2, Q1, QX], { prospects: fiches });
verif(pq.rattaches === 2 && pq.non_rattaches.join() === 'Inconnue SARL' && pq.activites.length === 2 && pq.activites.every((a) => a.prospect_id === 'p1' && a.action_type === 'questionnaire'), 'rattachement par la société du Hub (forme juridique ignorée), réponse sans fiche signalée');
verif(pq.notes.length === 1 && pq.notes[0].notes.includes('venue du 09/12/2026') && !pq.notes[0].notes.includes('venue du 23/11/2026'), 'le bloc de la fiche = la DERNIÈRE réponse');
verif(pq.activites[0].description === descriptionActivite(Q1) && /\[q_00000000000000a1\]$/.test(pq.activites[0].description) && pq.activites[0].created_at === Q1.recu_le, 'historique daté de la réponse, identifiant entre crochets');
const pq2 = planQuestionnaires([Q2, Q1], { prospects: [{ ...fiches[0], notes: pq.notes[0].notes }], dejaNotes: idsDejaNotes(pq.activites) });
verif(pq2.activites.length === 0 && pq2.notes.length === 0 && pq2.deja === 2, 'synchro suivante : aucune entrée en double, aucune note réécrite (idempotent)');
{
  const f = fauxSupabase({ prospects: fiches.map((p) => ({ ...p })), activities: [{ action_type: 'questionnaire', description: descriptionActivite(Q1) }] });
  const store = makeStore({ sb: f.sb });
  const apercu = await store.questionnaires([Q1, Q2, QX], { ecrire: false });
  verif(apercu.recus === 3 && apercu.nouvelles === 1 && apercu.fiches === 1 && !apercu.ecrit && f.ops.length === 0, 'aperçu (dry-run) : rien d’écrit, 1 nouvelle réponse (Q1 déjà à l’historique)');
  const r = await store.questionnaires([Q1, Q2, QX]);
  const insert = f.ops.find((o) => o[0] === 'insert' && o[1] === 'activities'); const maj = f.ops.find((o) => o[0] === 'update' && o[1] === 'prospects');
  verif(r.ecrit && insert && insert[2].length === 1 && insert[2][0].description.includes('[q_00000000000000a2]') && maj && maj[2] === 'p1' && Object.keys(maj[3]).join() === 'notes', 'écriture : 1 entrée d’historique, notes de la fiche seules mises à jour');
}

// --- Salles jouées (filtres de l'onglet Clients du CRM, 23/11/2026) ---
const cles = (t) => [...sallesDuTexte(t)].sort().join();
verif(cles('Quiz Game : "Buzz Your Brain" --- Émissions Au Choix !') === 'quiz' && cles('GARDE À VUE') === 'gav' && cles('IN PRISON') === 'gav' && cles("BACK TO THE 80'S") === '80s' && cles('BACK TO THE 80') === '80s'
  && cles('PERDUS DANS LES BACKROOMS') === 'backrooms' && cles('Escape Box') === 'box' && cles('PSYCHIATRIC · Plateau repas') === 'psy', 'salles reconnues sous leurs noms du Hub et de 4escape (In Prison = Garde à vue)');
verif(cles('Forfait 80 € par personne · Privatisation Etablissement · Plateau repas') === '' && cles('') === '' && cles(null) === '', 'un prix « 80 € », la privatisation ou un repas ne sont pas des salles');
verif([...famillesDe(new Set(['psy', 'quiz', 'box']))].sort().join() === 'action,escape,quiz' && famillesDe(new Set()).size === 0, 'familles : escape, quiz, action');
verif(fusionnerSalles('PSYCHIATRIC, IN PRISON', new Set(['gav', 'quiz'])) === 'PSYCHIATRIC, IN PRISON, BUZZ YOUR BRAIN', 'salle manquante ajoutée à la fin ; « IN PRISON » vaut Garde à vue (rien de renommé)');
verif(fusionnerSalles('Psychiatric x2 ;in prison', new Set(['psy', 'gav'])) === 'Psychiatric x2 ;in prison' && fusionnerSalles(null, new Set()) === '', 'rien à ajouter : texte saisi rendu au caractère près');
const fs1 = fusionnerSalles('', new Set(['quiz', 'psy']));
verif(fs1 === 'PSYCHIATRIC, BUZZ YOUR BRAIN' && fusionnerSalles(fs1, new Set(['quiz', 'psy'])) === fs1, 'fiche vide : salles dans l’ordre du Hub ; rejouer ne change rien');
const dvS = [
  { reference: 'X1', _key: normSociete('GAMMA'), societe: 'GAMMA', est_societe: true, statut: 'completed', montant_ttc: 300, produits: 'PSYCHIATRIC · Plateau repas', date_evenement: '2026-10-01' },
  { reference: 'X2', _key: normSociete('GAMMA'), societe: 'GAMMA', est_societe: true, statut: 'on-hold', montant_ttc: 200, produits: 'Quiz Game : "Buzz Your Brain"', date_evenement: '2026-12-20' },
  { reference: 'X3', _key: normSociete('LA POSTE'), societe: 'LA POSTE', est_societe: true, statut: 'refunded', montant_ttc: 500, produits: 'GARDE À VUE · BUZZ YOUR BRAIN', date_evenement: '2026-09-01' },
];
const entS = grouperParEntreprise(dvS);
verif([...entS.find((e) => e.societe === 'GAMMA').salles].join() === 'psy', 'seules les salles des devis HONORÉS comptent (le quiz encore en devis ne compte pas)');
{
  const f = fauxSupabase({ devis: [], clients: [{ id: 'c1', societe: 'LA POSTE', salles_jouees: 'IN PRISON' }], prospects: [], activities: [] });
  const store = makeStore({ sb: f.sb });
  const res = await store.appliquer({ devis: dvS, entreprises: entS, plan: { nouveaux: dvS, changes: [] }, seuils: calcSeuils(entS), now: new Date('2026-11-23T12:00:00Z') });
  const majPoste = f.ops.find((o) => o[0] === 'update' && o[1] === 'clients' && o[2] === 'c1');
  const insGamma = f.ops.find((o) => o[0] === 'insert' && o[1] === 'clients' && o[2].societe === 'GAMMA');
  verif(majPoste && majPoste[3].salles_jouees === 'IN PRISON, BUZZ YOUR BRAIN' && insGamma && insGamma[2].salles_jouees === 'PSYCHIATRIC' && res.salles === 2, `fiches clients : salles complétées (LA POSTE garde « IN PRISON » + le quiz) ou créées (GAMMA), ${res.salles} fiches`);
  verif(majPoste && !('notes' in majPoste[3]) && !('satisfaction' in majPoste[3]), 'la synchro des devis ne touche ni aux notes ni à la satisfaction du client');
  const f2 = fauxSupabase({ devis: [], clients: [{ id: 'c1', societe: 'LA POSTE', salles_jouees: majPoste ? majPoste[3].salles_jouees : '' }, { id: 'c2', societe: 'GAMMA', salles_jouees: 'PSYCHIATRIC' }], prospects: [], activities: [] });
  const res2 = await makeStore({ sb: f2.sb }).appliquer({ devis: dvS, entreprises: entS, plan: { nouveaux: [], changes: [] }, seuils: calcSeuils(entS), now: new Date('2026-11-23T12:00:00Z') });
  verif(res2.salles === 0 && f2.ops.filter((o) => o[0] === 'update' && o[1] === 'clients').every((o) => !('salles_jouees' in o[3])), 'synchro suivante : colonne salles non réécrite (idempotent)');
  const ap = await makeStore({ sb: fauxSupabase({ clients: [{ id: 'c1', societe: 'LA POSTE', salles_jouees: 'IN PRISON' }, { id: 'c3', societe: 'DELTA', salles_jouees: 'in prison, Psychiatric' }] }).sb }).apercuSalles(entS);
  verif(ap.clients === 2 && ap.avecSalles === 2 && ap.aCompleter === 1 && ap.nouvelles === 1 && ap.mots.get('IN PRISON') === 2, 'aperçu dry-run : fiches à compléter, nouvelles fiches, vocabulaire déjà saisi');
}

// --- Questionnaire → fiches CLIENTS (filtres « A répondu », « OK photos »…) ---
{
  const cli = [{ id: 'c9', societe: 'ACME NORMANDIE', notes: 'manuel', satisfaction: null }, { id: 'c8', societe: 'Autre', satisfaction: 3 }];
  const pc = planClientsQuestionnaires([Q2, Q1, QX], cli);
  verif(pc.length === 1 && pc[0].id === 'c9' && pc[0].maj.notes.startsWith('manuel') && pc[0].maj.notes.includes('venue du 09/12/2026') && pc[0].maj.satisfaction === 5, 'client : bloc de la dernière réponse ajouté aux notes, satisfaction vide = note globale');
  const pc2 = planClientsQuestionnaires([Q1, Q2], [{ ...cli[0], notes: pc[0].maj.notes, satisfaction: 4 }]);
  verif(pc2.length === 0, 'satisfaction déjà saisie jamais écrasée ; rejouer ne réécrit rien');
  const f = fauxSupabase({ prospects: [], activities: [], clients: cli.map((c) => ({ ...c })) });
  const r = await makeStore({ sb: f.sb }).questionnaires([Q1, Q2]);
  const maj = f.ops.find((o) => o[0] === 'update' && o[1] === 'clients');
  verif(r.clients === 1 && maj && maj[2] === 'c9' && Object.keys(maj[3]).sort().join() === 'notes,satisfaction', 'écriture : fiche client mise à jour (notes + satisfaction seulement)');
}

console.log(`\n${ok} vérifications réussies, ${ko} en échec`); process.exit(ko ? 1 : 0);
