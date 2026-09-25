// OUTIL PONCTUEL — confirme l'email d'UN compte du CRM, sans toucher à son mot de passe.
// À supprimer après usage.
import { createClient } from '@supabase/supabase-js';

const EMAIL = 'lily-rose@gamedoor41.fr';
const NOM = 'Lily-Rose';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function trouver() {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find(x => (x.email || '').toLowerCase() === EMAIL);
    if (u || data.users.length < 200) return u || null;
  }
  return null;
}
const etat = u => ({ id: u.id, cree: u.created_at, email_confirme: u.email_confirmed_at || 'NON', derniere_connexion: u.last_sign_in_at || 'jamais' });

const u = await trouver();
if (!u) { console.log(`Aucun compte ${EMAIL} : l'inscription n'a pas abouti, il faut la refaire.`); process.exit(1); }
console.log('AVANT :', etat(u));

if (!u.email_confirmed_at) {
  const { error } = await sb.auth.admin.updateUserById(u.id, { email_confirm: true });  // email seulement
  if (error) throw error;
}
const apres = await trouver();
console.log('APRÈS :', etat(apres));

const { data: prof } = await sb.from('profiles').select('id,name').eq('id', u.id).maybeSingle();
if (!prof) {
  const { error } = await sb.from('profiles').insert({ id: u.id, email: EMAIL, name: NOM });
  console.log(error ? 'profil : échec ' + error.message : 'profil créé (' + NOM + ')');
} else console.log('profil déjà présent :', prof.name);

if (!apres.email_confirmed_at) process.exit(1);
