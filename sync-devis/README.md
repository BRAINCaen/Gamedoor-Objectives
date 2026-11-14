# Synchro des devis → CRM (Hub GAMEDOOR·41, ex-4escape)

Le CRM récupère les devis B2B, ne traite que les **nouveautés** et re-vérifie les
**devis en cours**, recalcule les **scores**, sans jamais dupliquer l'historique ni
empiler les notes.

**Depuis le 02/11/2026, la source est le Hub** (le logiciel de réservation de
GAMEDOOR·41 qui remplace 4escape) : le robot lit les devis par le pont signé
`POST https://synergia-hub.netlify.app/api/pont/crm-devis` (dépôt
`BRAINCaen/GAMEDOOR-HUB`, `docs/pont-crm-devis.md`). Signature Ed25519 : la clé
privée est le secret GitHub `HUB_PONT_CRM_CLE_PRIVEE`, le Hub n'a que la clé
publique. `lib/hub.mjs` rend les devis sous la même forme que les CSV de 4escape,
donc diff, scores, notes et historique sont inchangés :

- statuts du Hub traduits dans le vocabulaire 4escape (`payee`→`completed`,
  `en_attente_paiement`→`on-hold`, `en_attente_confirmation`→`pending`…) : un devis
  de 4escape garde exactement son statut, la bascule ne crée aucun faux changement ;
- nouveau statut `expired` (validité passée sans réponse) : figé, « Relance » dans le CRM ;
- devis de 4escape « repris dans le Hub » (remplacés par un `HD-…`) et devis « sans
  suite » (facture directe mensuelle d'un partenaire) : écartés, pour ne rien compter deux fois ;
- un devis validé dans le Hub devient une commande `H-…` mais reste suivi sous sa
  référence de devis (`2026-D…` ou `HD-…`) ;
- une info que le Hub n'a pas (le téléphone des devis de 4escape…) n'efface jamais
  celle que Supabase connaît déjà ;
- le bloc de note auto devient `⟦Hub⟧…⟦/Hub⟧` (il remplace l'ancien `⟦4escape⟧`),
  l'historique est signé « Synchro Hub » / « Devis Hub ».

Tests hors ligne : `node tests/test-hub.mjs` (lancés aussi par le workflow avant chaque synchro).

## Comment ça marche

```
Bouton « Synchroniser » (CRM)
   → /api/sync (fonction Netlify, détient le token GitHub)
      → repository_dispatch → GitHub Actions (dépôt Gamedoor-Objectives)
         → sync.mjs : requête signée au pont du Hub (lib/hub.mjs)
            → diff + upsert Supabase + scores
              (ancienne source : Playwright, login 4escape, export des 2 CSV)
               → écrit un rapport dans la table sync_runs
   ← le CRM lit sync_runs et affiche l'avancement, puis recharge
```

- **Idempotent** : une 2ᵉ synchro sans changement n'écrit aucun historique.
- **Préserve le manuel** : notes libres, satisfaction, salles, services intacts ;
  le bloc de note auto (entre `⟦Hub⟧…⟦/Hub⟧`) est remplacé, pas empilé.
- **Deux scores /10** : `prospects.score` = POTENTIEL, `clients.score_valeur` = VALEUR.

## Fichiers

| | |
|---|---|
| `sql/1_table_devis.sql` | table miroir des devis (mémoire de la synchro) |
| `sql/2_scores.sql` | colonnes de score |
| `sql/3_sync_runs.sql` | journal des synchros (suivi côté CRM) |
| `lib/csv.mjs` | parsing CSV + utilitaires |
| `lib/transform.mjs` | 2 CSV → devis normalisés + agrégats par entreprise |
| `lib/score.mjs` | calcul des scores VALEUR / POTENTIEL |
| `lib/store.mjs` | écriture Supabase (préserve le manuel, idempotent) |
| `lib/hub.mjs` | source Hub : requête signée au pont + traduction des devis |
| `tests/test-hub.mjs` | tests hors ligne (statuts, notes, signature) |
| `lib/fetch4escape.mjs` | ancienne source : login + export CSV via Playwright |
| `sync.mjs` | orchestrateur (voir modes ci-dessous) |
| `scrape-devis.mjs` | sonde de diagnostic (affiche les colonnes, n'écrit rien) |
| `../.github/workflows/sync-crm-devis.yml` | workflow GitHub Actions (en place) |

## Mise en route (une fois)

1. **Supabase** : coller `sql/1`, `sql/2`, `sql/3` dans SQL Editor → Run.
2. **`.env` local** (voir `.env.example`) : `FE_USER`, `FE_PASS`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY` (clé *service_role* : Supabase → Project Settings → API).
3. `npm install && npx playwright install chromium`
4. **Test progressif** (recommandé) :
   ```
   node sync.mjs --from-files resume.csv detail.csv --dry-run   # analyse seule
   node sync.mjs --from-files resume.csv detail.csv             # écrit depuis des CSV
   node sync.mjs --dry-run                                      # login+export, sans écrire
   node sync.mjs                                                # synchro réelle complète
   ```
5. **Déploiement automatique** : pousser `sync-devis/` + le workflow dans
   `BRAINCaen/Gamedoor-Objectives`, ajouter les secrets GitHub `SUPABASE_URL` /
   `SUPABASE_SERVICE_KEY` (les `FE_*` y sont déjà).
6. **Bouton du CRM** : créer un PAT GitHub (fine-grained, dépôt Gamedoor-Objectives,
   *Contents: Read and write*) et l'ajouter sur Netlify en variable
   `GITHUB_DISPATCH_TOKEN`, puis redéployer le CRM. (Au 14/11/2026 : pas encore fait,
   `/api/sync` répond « GITHUB_DISPATCH_TOKEN non configuré » ; la synchro de la nuit,
   elle, tourne.)

## Modes de `sync.mjs`

- `--dry-run` : lit la source, compare à Supabase (avec un contrôle de continuité
  champ par champ), affiche le rapport, **n'écrit rien**.
- `--from-hub-file reponse.json` : rejoue une réponse du pont enregistrée.
- `--source=4escape` (ou `SYNC_DEVIS_SOURCE=4escape`, input `source` du workflow) :
  ancienne source ; avec elle, `--from-files <resume.csv> [detail.csv]` lit des CSV
  locaux (sinon login + export en direct).
