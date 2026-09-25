// Migration ponctuelle : statut « A appeler » -> « A contacter ».
//
// Pourquoi ce script plutôt que le SQL Editor de Supabase : la clé service_role
// n'existe que dans les secrets GitHub, c'est donc ici qu'on peut écrire.
//
// Garanties :
//   · SAUVEGARDE complète de prospects + activities AVANT toute écriture,
//     déposée en artefact du run (le plan Supabase FREE n'a aucun backup auto) ;
//   · IDEMPOTENT : le filtre ne prend que les lignes encore en « A appeler »,
//     relancer le script ne fait donc plus rien ;
//   · RÉVERSIBLE : --annuler rejoue la bascule dans l'autre sens ;
//   · --dry-run compte sans rien écrire.
//
// Ce script et son workflow sont à SUPPRIMER une fois la migration vérifiée.

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ANCIEN = 'A appeler';
const NOUVEAU = 'A contacter';

const has = (f) => process.argv.includes(f);
const DRY = has('--dry-run');
const ANNULER = has('--annuler');
const [de, vers] = ANNULER ? [NOUVEAU, ANCIEN] : [ANCIEN, NOUVEAU];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY manquants'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

const log = (...a) => console.log(...a);

// --- Lecture paginée : PostgREST plafonne à 1000 lignes par requête ---------
async function tout(table, cols) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(cols).order('id').range(from, from + 999);
    if (error) throw new Error(`${table} : ${error.message}`);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function compte(table, colonne, valeur) {
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }).eq(colonne, valeur);
  if (error) throw new Error(`${table}.${colonne} : ${error.message}`);
  return count || 0;
}

const main = async () => {
  log('═══ MIGRATION « %s » -> « %s » ═══', de, vers);
  log(DRY ? '🧪 MODE À BLANC : rien ne sera écrit.\n' : '');

  // 1. État avant
  const avant = {
    prospects: await compte('prospects', 'statut', de),
    actsAncien: await compte('activities', 'ancien_statut', de),
    actsNouveau: await compte('activities', 'nouveau_statut', de),
  };
  log('AVANT :');
  log('  prospects.statut           = « %s » : %d', de, avant.prospects);
  log('  activities.ancien_statut   = « %s » : %d', de, avant.actsAncien);
  log('  activities.nouveau_statut  = « %s » : %d', de, avant.actsNouveau);

  // Répartition complète, pour vérifier qu'on ne casse rien d'autre
  const tousStatuts = await tout('prospects', 'statut');
  const rep = {};
  for (const p of tousStatuts) rep[p.statut ?? '(vide)'] = (rep[p.statut ?? '(vide)'] || 0) + 1;
  log('\n  Répartition des %d prospects :', tousStatuts.length);
  for (const [s, n] of Object.entries(rep).sort((a, b) => b[1] - a[1])) log('    %s : %d', String(s).padEnd(16), n);

  if (!avant.prospects && !avant.actsAncien && !avant.actsNouveau) {
    log('\n✅ Rien à migrer : la base est déjà alignée.');
    return;
  }

  if (DRY) { log('\n🧪 MODE À BLANC : arrêt avant écriture.'); return; }

  // 2. SAUVEGARDE avant d'écrire quoi que ce soit
  const dossier = 'sauvegarde-migration';
  fs.mkdirSync(dossier, { recursive: true });
  for (const [table, cols] of [['prospects', '*'], ['activities', '*']]) {
    const lignes = await tout(table, cols);
    fs.writeFileSync(path.join(dossier, table + '.json'), JSON.stringify(lignes, null, 1), 'utf8');
    log('\n💾 Sauvegarde %s : %d lignes', table, lignes.length);
  }

  // 3. Bascule
  log('\n── Écriture ──');
  const maj = async (table, colonne) => {
    const { error, count } = await sb.from(table)
      .update({ [colonne]: vers }, { count: 'exact' })
      .eq(colonne, de);
    if (error) throw new Error(`${table}.${colonne} : ${error.message}`);
    log('  %s.%s : %d ligne(s) migrée(s)', table, colonne, count ?? 0);
  };
  await maj('prospects', 'statut');
  await maj('activities', 'ancien_statut');
  await maj('activities', 'nouveau_statut');

  // 4. Contrôle
  const apres = {
    prospects: await compte('prospects', 'statut', de),
    actsAncien: await compte('activities', 'ancien_statut', de),
    actsNouveau: await compte('activities', 'nouveau_statut', de),
    cible: await compte('prospects', 'statut', vers),
  };
  log('\nAPRÈS :');
  log('  reste en « %s »          : %d prospects, %d + %d activités', de, apres.prospects, apres.actsAncien, apres.actsNouveau);
  log('  désormais en « %s »      : %d prospects', vers, apres.cible);

  const total = (await tout('prospects', 'id')).length;
  log('  total prospects           : %d (doit être inchangé : %d)', total, tousStatuts.length);

  if (apres.prospects || apres.actsAncien || apres.actsNouveau) {
    console.error('\n❌ Il reste des lignes non migrées.');
    process.exit(1);
  }
  if (total !== tousStatuts.length) {
    console.error('\n❌ Le nombre de prospects a changé — anomalie.');
    process.exit(1);
  }
  log('\n✅ Migration terminée et vérifiée.');
};

main().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
