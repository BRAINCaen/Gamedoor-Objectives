# HANDOVER — Dashboard GAMEDOOR °41 (« La moula » dans Synergia)

> Document de passation pour qu'un futur Claude reprenne la session sans poser de questions au user.
> **Dernière mise à jour : 2026-10-16** (session « La moula » : carte des origines, répartition B2B / B2C à la date de l'évènement, périmètre hors Backrooms, robots `origines.mjs` et `backrooms.mjs`, enrichissement de tout l'historique 2020 → 2026).

---

## 🎯 État du projet

- **Ce que c'est** : le tableau de bord d'équipe de GAMEDOOR °41 (escape game, Caen), un seul fichier `index.html` (vanilla JS + Firebase Realtime Database compat 10.12.2), publié par **GitHub Pages** depuis la racine de ce dépôt (`BRAINCaen/Gamedoor-Objectives`, branche `main`). **Un `git push` sur `main` = mise en ligne en 1 à 2 minutes** (`https://braincaen.github.io/Gamedoor-Objectives/`).
- **« La moula »** : page `/moula` de Synergia (dépôt `BRAINCaen/synergia-app`, `react-app/src/pages/MoulaPage.jsx`) = une iframe plein écran vers cette URL. **Rien à faire côté Synergia** pour faire évoluer le dashboard.
- **Accès** : code PIN d'équipe `4141` (constante `TEAM_PIN`, mémorisé dans `localStorage.gamedoor_pin_ok`).
- **Firebase** : projet `gamedoor-objectives`, RTDB `https://gamedoor-objectives-default-rtdb.europe-west1.firebasedatabase.app`, auth **anonyme** (dashboard et robots). Règles verrouillées le 24/08/2026 (`database.rules.json`, `SECURITE-FIREBASE.md`) : `/state` lisible si authentifié ; `entries` écrivable **journée par journée** seulement (`auto-AAAA-MM-JJ`) ; `"$inconnu": {".validate": false}` → **aucune nouvelle branche sous `/state` sans republier les règles** (exige `firebase login` sur un poste). D'où : les agrégats des robots vont sous **`/state/autoMeta/analyse`**, le détail par jour dans `entries/<clé>/detail.*` (libre).
- **Données** : `state/entries/auto-<date>` = `{date, ca, sessions, players, avis, gm, source, ts, detail}` — `ca` = CA encaissé **à la date de commande**, `sessions`/`players` = joués **à la date de l'évènement**. 2 217 journées depuis 2020-01. `state/config` = objectifs et options (dont `horsBackrooms`). `state/ventesCo` = ventes co remontées de Synergia.
- **Robots (GitHub Actions, dossier `sync-4escape/`, Playwright + Chromium, identifiants 4escape dans les secrets `FE_USER` / `FE_PASS`, jamais sur un PC)** : voir tableau plus bas. Documentation détaillée : `sync-4escape/README.md`.
- **Autres dossiers** : `sync-devis/` (synchro devis → CRM Supabase, autre chantier), `apply-security.mjs` (verrouillage Firebase, nécessite une session Google).

---

## 📅 Session du 16/10/2026 — ce qui a été fait (chronologique)

1. **Retrouver « La moula »** : rien sur le PC `tangu` → repérée via GitHub (`synergia-app` → iframe → ce dépôt). Les deux dépôts ont été clonés sur `Desktop\synergia-app` et `Desktop\Gamedoor-Objectives` ; `npm ci` + `npx playwright install chromium` faits dans `sync-4escape/`.
2. **Demande de Polar** : (a) carte interactive de la région d'origine des joueurs (codes postaux 4escape), (b) retirer le CA des **Backrooms** (activité de l'an dernier, arrêtée) pour des objectifs « réels », (c) répartition **B2B / B2C** en %.
3. **Robot nocturne `scrape.mjs`** enrichi (CA / sessions / avis **inchangés**, non-régression au centime sur l'export réel du 15/10) : ventilation par salle (`detail.vendu.rooms` / `detail.joue.rooms` = `[nom, CA TTC, sessions, joueurs]`), part B2B, périmètre Backrooms par détection de libellé, mode **`--enrich=début:fin`** (PATCH de `detail/` sur les journées existantes, rejouable), entrées `enrich` / `backfill` du workflow.
4. **Dashboard** : bloc **Répartition B2B / B2C** (carte dédiée, onglets Jour / Semaine / Mois / Trimestre / Année / Tout, défaut Mois, comparaison N-1 en points) ; **périmètre hors Backrooms** (option dans Réglages, cochée par défaut, partagée via `state/config.horsBackrooms` ; retiré des comparaisons N-1, records, analyse par période, objectifs automatiques ; pastille sur « Les chiffres » avec le montant retiré ; résumé dans Réglages) ; **carte « D'où viennent nos joueurs »** (Leaflet + tuiles OpenStreetMap chargés à la demande, rendu canvas, zoom molette, bouton Recentrer, sélecteur Clients / Commandes, onglets par année en mode Commandes, répartition par zone, top communes).
5. **Backrooms — l'enquête** : aucun libellé « Backrooms » dans le journal des ventes (mêmes 4 salles 2025 et 2026 : PSYCHIATRIC, GARDE À VUE, BACK TO THE 80'S, Quiz Game « Buzz Your Brain »). Polar a précisé : **salle masquée dans l'onglet Rooms**. L'export Clients a révélé le nom exact **« PERDUS DANS LES BACKROOMS »**. Ses ventes **sont dans le CA du journal mais sans libellé** (lignes client 411 via un compte d'acompte, aucune ligne de vente 70x) → nouveau robot **`backrooms.mjs`** : export **Commandes « lignes de commande »** (colonne `Room`), agrégation par jour, contrôle « totaux journaliers journal = commandes » (écart 0 € sur 48 jours), écriture `detail.backrooms` (`source:'commandes'`, `dansJournal:true`) + résumé `autoMeta/analyse/backrooms`. **Résultat : 17 750 € TTC, 68 sessions, 396 joueurs, du 05/10/2025 au 12/03/2026** (oct. 6 600 · nov. 4 850 · déc. 900 · janv. 2 700 · févr. 2 400 · mars 300 €). Octobre 2025 passe de 40 931 € à 34 331 €.
6. **Origines** : robot **`origines.mjs`** (export Clients + export Commandes « entêtes », jointure par e-mail en mémoire, géocodage `geo.api.gouv.fr` avec cache `autoMeta/analyse/geo`, écriture `autoMeta/analyse/origines`, **aucune donnée nominative**). Premier relevé : 741 clients (seule l'adresse société était lue) → corrigé : l'export porte **`User Address Postal Code`** (particuliers) ET **`Company Address Postal Code`** → **17 932 clients sur 25 426 (70 %), 1 647 codes postaux, 17 781 commandes** ; Caen & agglo 48 %, reste Calvados 20 %, reste Normandie 15 %, IdF 7 %, reste France 9 %, étranger 1 %. Cron le **1er du mois**.
7. **B2B à la date de l'évènement** (demande de Polar) : la part était d'abord calculée sur le journal « date de commande ». Désormais `detail.joue.b2b` = factures 411 du journal **« date de prestation »** (payé + en attente), une facture est B2B dès qu'une ligne porte une **Société** ; `detail.vendu.b2b` (date de commande) conservé pour info. Historique 2020 → 2026 ré-enrichi (2 159 journées sur 2 217 ; les 58 autres n'ont aucun évènement). 2026 au 15/10 : **8 %** (20 137 € / 245 464 €) vs 5 % en 2025 ; 2025 de 2 % (été) à 20 % (nov.-déc.) ; depuis 2020 : 11 %.
8. **Hygiène** : une première écriture Backrooms avait repris des libellés de codes de prévente contenant des noms → corrigé (libellés = noms de salle uniquement) et réécrit.

---

## 🤖 Robots et workflows (`.github/workflows/`)

| Workflow | Script | Déclenchement | Rôle |
|---|---|---|---|
| **Synchro 4escape → Gamedoor** (`sync-4escape.yml`) | `scrape.mjs` | crons nocturnes (plusieurs créneaux, GitHub retarde ~1 h ; fenêtre 0h-9h Paris + anti-doublon `autoMeta/lastSync`) + manuel (`target_date`, `dry_run`, **`enrich`**, **`backfill`**) | journée de la veille : CA, sessions, joueurs, avis Google, salles, B2B, Backrooms (libellés) ; XP Synergia ; ventes co. `enrich` = complète les journées existantes (ne réécrit **jamais** un `backrooms` de source `commandes`). `backfill` = crée les journées absentes. |
| **Origines des joueurs** (`origines-4escape.yml`) | `origines.mjs` | cron 1er du mois + manuel (`dry_run`) | codes postaux → `autoMeta/analyse/origines` + cache `geo` |
| **Backrooms (salle masquée)** (`backrooms-4escape.yml`) | `backrooms.mjs` | manuel (`dry_run`, `room_match`) | ventes d'une salle masquée via l'export Commandes → `detail.backrooms` + `autoMeta/analyse/backrooms`. À relancer seulement si la salle est rejouée ou si une autre salle masquée doit être isolée (`room_match`). |
| Synchro devis 4escape → CRM | `sync-devis/sync.mjs` | cron + bouton CRM | hors périmètre dashboard |
| *(non publié)* Inventaire 4escape | `sync-4escape/explore.mjs` + `explore-4escape.yml` | — | présents **uniquement en local sur le PC `tangu`**, non commités : le classificateur de sécurité de Claude Code a refusé leur publication. Plus nécessaires. |

Lancer un workflow : `gh workflow run <fichier.yml> -f cle=valeur`, suivre : `gh run watch <id>`, logs : `gh run view <id> --log`. Chaîne d'enrichissement multi-années : un run à la fois (le groupe de concurrence ne garde **qu'un** run en attente, les autres sont annulés).

---

## 🧪 Vérifier / tester

- **Robot** : `node --check sync-4escape/scrape.mjs` ; tests de non-régression (agrégation sur l'export réel + journée synthétique Backrooms / B2B) : script `test-agregat.mjs` écrit dans le scratchpad de session de Claude le 16/10 (à recréer au besoin : il importe `analyseJournal`, `roomOf`, `isBackrooms`, `backroomsDetail` depuis `scrape.mjs` et compare à `parsed-preview.json` de l'artefact `debug-4escape` d'un run réussi).
- **Dashboard** : syntaxe = extraire le dernier `<script>` d'`index.html` et `node --check` ; bout en bout = `cd sync-4escape && node debug/smoke.mjs` (Playwright, lit Firebase en lecture seule, simule données en mémoire, captures dans `debug/`, dossier ignoré par git). Vérification en ligne : charger `https://braincaen.github.io/Gamedoor-Objectives/`, poser `localStorage.gamedoor_pin_ok = '4141'`, recharger.
- **Firebase en lecture** : jeton anonyme via `identitytoolkit.googleapis.com/v1/accounts:signUp?key=<clé web publique d'index.html>` puis `GET <RTDB>/state/....json?auth=<jeton>`.
- **Artefacts des runs** : `gh run download <id>` (le robot nocturne dépose captures + CSV du journal ; les autres robots ne déposent qu'un rapport agrégé — **jamais de fichier client dans un artefact : le dépôt est public**).

---

## ⚠️ Pièges connus (appris le 16/10/2026)

- **Journal des ventes et salles masquées** : les ventes d'une salle masquée n'y portent aucun libellé (411 + acompte, pas de 70x) → impossible de les isoler par nom ; passer par l'export Commandes (`/admin/orders?mode=order`, modale `#modal-order-export`, types « Export général entêtes de commande » / « Export des lignes de commande »).
- **Export Clients 4escape** : deux jeux d'adresses (`User Address …` particulier, `Company Address …` société) + une colonne par salle jouée (dont les salles masquées : c'est ainsi qu'on a trouvé le nom). Prendre le particulier d'abord.
- **Codes « BRVIP - Prevente Backroom <nom> »** : vouchers de 300 € (préventes) utilisés en paiement ; libellés avec noms de personnes → ne jamais les recopier dans Firebase ni dans l'UI.
- **Journal « joue »** (date de prestation) : peut être vide un jour sans évènement ; statuts payé + en attente.
- **Règles RTDB** : `PATCH`/`PUT` sous `entries/<clé>/detail/...` passe ; toute branche nouvelle sous `/state` est refusée.
- **Fichiers en CRLF** (`index.html`, `scrape.mjs`, `database.rules.json`) ; l'outil Edit les gère, un script Node doit normaliser.
- **Leaflet** : `zoomSnap` fractionnaire = tuiles floues + rectangle fantôme sur captures → niveaux entiers ; `preferCanvas:true` indispensable avec ~1 600 bulles ; `innerText` d'un `<details>` fermé est vide (utiliser `textContent` dans les tests).
- **GitHub Actions** : crons en retard d'environ 1 h ; `gh run download` ne trouve rien sur un run « sauté » (fenêtre horaire) ; les dates d'évènement futures (réservations 2027-2028) existent dans les exports → onglets limités aux années ≤ année courante.
- **Classificateur de sécurité Claude Code (mode auto)** : a refusé de publier/lancer l'outil d'inventaire et de lire le journal d'un run `origines` ; a laissé passer `gh workflow run` des robots existants, la lecture des logs des runs Synchro / Backrooms et le téléchargement des artefacts agrégés. Sur demande explicite de Polar, Claude a lancé lui-même tous les runs.

---

## 📐 Décisions produit

- **B2B** = commande passée au nom d'une société dans 4escape, montants TTC facturés, **comptés à la date de l'évènement** (jamais encaissement ni devis).
- **Hors Backrooms** = option cochée par défaut ; seules des **ventes** Backrooms (CA net positif, `brut > 0`) sont retirées ; un jour « voucher seul » ne change rien ; `dansJournal:false` (si un jour des ventes n'étaient pas dans le journal) ne retire rien.
- **Carte** : mesure **Clients** par défaut (base la plus large), Commandes pour les onglets par année ; zones = Caen & agglo (< 15 km de Caen) / reste du Calvados / reste de la Normandie / Île-de-France / reste de la France / étranger.
- **Objectifs** : « 📥 Récupérer depuis les données » calcule désormais la référence et la saisonnalité **hors Backrooms** (2025 : 341 957 € brut → 329 607 €). Les paliers fixes (27 / 30 / 33 / 36 k€) restent à la main de Polar.

---

## ▶️ Prochaines étapes possibles

- **Vérifier le run nocturne du 17/10** (premier avec le robot modifié) : logs « Synchro 4escape → Gamedoor », lignes 🏢 / 🚪 / 🕳️, pas d'erreur ; la journée du 16/10 doit apparaître avec `detail.joue.b2b`.
- Si Polar veut recalibrer les paliers fixes : lui proposer de cocher « calcul automatique » ou de cliquer « Récupérer depuis les données » puis d'ajuster.
- Pour une carte encore plus complète : demander le code postal à la réservation dans le paramétrage 4escape (30 % des clients n'en ont pas).
- Si une autre salle est masquée à l'avenir : relancer « Backrooms (salle masquée) » avec `room_match` adapté, puis `enrich` ne l'écrasera pas.
- Le 1er novembre : contrôler le premier run cron des origines.
