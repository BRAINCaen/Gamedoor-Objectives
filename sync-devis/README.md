# Synchro des devis 4escape → CRM

Remplace l'import manuel de CSV par une synchro : le CRM récupère les devis B2B
depuis 4escape, ne traite que les **nouveautés** et re-vérifie les **devis en
cours**, recalcule les **scores**, sans jamais dupliquer l'historique ni empiler
les notes.

## Comment ça marche

```
Bouton « Synchroniser » (CRM)
   → /api/sync (fonction Netlify, détient le token GitHub)
      → repository_dispatch → GitHub Actions (dépôt Gamedoor-Objectives)
         → Playwright : login 4escape → export des 2 CSV (résumé + détail)
            → sync.mjs : diff + upsert Supabase + scores
               → écrit un rapport dans la table sync_runs
   ← le CRM lit sync_runs et affiche l'avancement, puis recharge
```

- **Idempotent** : une 2ᵉ synchro sans changement n'écrit aucun historique.
- **Préserve le manuel** : notes libres, satisfaction, salles, services intacts ;
  le bloc de note auto (entre `⟦4escape⟧…⟦/4escape⟧`) est remplacé, pas empilé.
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
| `lib/fetch4escape.mjs` | login + export CSV via Playwright |
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
   `GITHUB_DISPATCH_TOKEN`, puis redéployer le CRM.

## Modes de `sync.mjs`

- `--from-files <resume.csv> [detail.csv]` : lit des CSV locaux (sinon login+export live).
- `--dry-run` : analyse et affiche le rapport, **n'écrit rien**.
