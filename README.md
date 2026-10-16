# Gamedoor-Objectives

Tableau de bord d'équipe **GAMEDOOR °41** — https://braincaen.github.io/Gamedoor-Objectives/
(affiché aussi dans Synergia, page « Moula »). Un seul fichier : `index.html`
(vanilla JS + Firebase Realtime Database, code PIN d'équipe).

| Dossier / fichier | Rôle |
|---|---|
| `index.html` | le dashboard : CA du mois et paliers, comparaison N / N-1, répartition B2B / B2C, records, ventes co, carte « d'où viennent nos joueurs », analyses, réglages |
| `sync-4escape/` | robots GitHub Actions : `scrape.mjs` (synchro nocturne 4escape → Firebase, modes `--backfill` et `--enrich`), `origines.mjs` (codes postaux → carte), `explore.mjs` (inventaire des écrans 4escape), tests |
| `sync-devis/` | synchro des devis 4escape → CRM Supabase |
| `database.rules.json`, `SECURITE-FIREBASE.md`, `apply-security.mjs` | règles de sécurité Firebase et leur mode d'emploi |
| `.github/workflows/` | planification des robots |

Un `git push` sur `main` publie le dashboard (GitHub Pages) en une à deux minutes.
Documentation détaillée des robots : [`sync-4escape/README.md`](sync-4escape/README.md).
