# 🤖 Synchro 4escape → Gamedoor °41

Robot qui, **chaque nuit**, télécharge sur 4escape **deux exports du Journal des
ventes de la veille** (Comptabilité → Journal des ventes) et écrit une **saisie
automatique** dans le Firebase du dashboard d'équipe :

| Export | Réglages (appliqués et vérifiés par le robot) | Ce qu'on en tire |
|---|---|---|
| **VENTES** (base commande) | Type = Commandes · base = **date de commande** · Statuts = **Uniquement payé** · période = la veille | Ventes TTC du jour, ventilées : sessions / autres produits (garantie report, traiteur, privatisation, frais…) / remises. Les lignes « Chèque Cadeau » ici = bons **UTILISÉS en paiement** → **retirés** du CA (déjà encaissés à l'achat du bon). |
| **JOUÉ** (base prestation) | Type = Commandes · base = **date de prestation (date de jeu)** · Statuts = **Payé + En attente** · période = la veille | **Sessions JOUÉES** la veille + joueurs présents + CA joué TTC. Les lignes « Chèque Cadeau » ici = bons **ACHETÉS ce jour** → **ajoutés** au CA encaissé (mais pas comptés en session). |

**Formule du CA du jour** : `CA encaissé = ventes TTC − chèques utilisés + chèques achetés`.
Le dashboard reçoit : `ca` = **CA encaissé** · `sessions` = **sessions jouées**.
Le détail complet (ventilation, joué/vendu, chèques) est stocké dans la saisie (`detail`).

On utilise le **journal comptable** (données fiables) et **pas** le tableau de bord
temps réel. Le robot tourne **gratuitement** sur **GitHub Actions** — aucun PC à
laisser allumé. Si un réglage ne peut pas être vérifié, il **refuse d'exporter**
plutôt que d'écrire un chiffre faux.

---

## ⚠️ Ce que le robot remplit — et ce qui reste manuel

| Champ du dashboard | Source | Auto ? |
|---|---|---|
| **CA du jour** | Journal des ventes (commandes payées) | ✅ oui |
| **Nb de sessions** | Journal (colonne dédiée, ou nb de lignes) | ✅ oui *(à confirmer en calibration)* |
| **Ventes Co** (`options`) | — | ❌ manuel |
| **Avis Google** (`avis`) | Google (hors 4escape) | ❌ manuel |

👉 **À dire à l'équipe : ne plus saisir le CA ni les sessions à la main** (sinon
double comptage). Les game masters continuent de saisir **les avis Google** (et les
ventes co) — ce qui garde le classement / XP par personne pertinent.

La saisie du robot apparaît dans « Dernières saisies » sous **🤖 4escape (auto)**,
avec une **clé fixe par jour** (`auto-2026-07-20`) : si le robot repasse, il
**écrase** au lieu de doubler.

---

## 🔧 Installation (une seule fois)

### 1. Créer un compte 4escape dédié au robot (recommandé)
Dans 4escape : **Admin → Membres**, crée un membre (ex. `robot@ton-domaine.fr`) avec
les droits d'accès à la **Comptabilité / Journaux**. Utilise une adresse de **ton
domaine** (pas gmail/hotmail). Avantage : si tu changes ton mot de passe perso, le
robot continue, et tu limites ce qu'il peut faire.

### 2. Mettre ces fichiers dans ton dépôt GitHub
Copie dans `BRAINCaen/Gamedoor-Objectives` :
- le dossier **`sync-4escape/`**
- le fichier **`.github/workflows/sync-4escape.yml`**

### 3. Ajouter les « Secrets » GitHub
Dépôt → **Settings → Secrets and variables → Actions → New repository secret**
(valeurs **chiffrées**, invisibles même en dépôt public) :

| Secret | Valeur | Obligatoire |
|---|---|---|
| `FE_USER` | login 4escape du robot | ✅ |
| `FE_PASS` | mot de passe 4escape du robot | ✅ |
| `FB_URL` | `https://gamedoor-objectives-default-rtdb.europe-west1.firebasedatabase.app` | ✅ |
| `FE_BASE` | `https://braincaen.4escape.io` | (optionnel, défaut) |
| `JOURNAL_PATH` | `/admin/statistics/accounting/journal-sales` | (optionnel, défaut) |

### 4. ▶️ Premier essai en mode test
Onglet **Actions → « Synchro 4escape → Gamedoor » → Run workflow** :
- `target_date` : mets **hier** (ex. `2026-07-20`) — un jour avec des ventes
- `dry_run` : **`1`** (mode test — ne touche pas à Firebase)

Ouvre le run → bloc **ANALYSE DU JOURNAL** dans les logs (CA TTC, sessions, contrôle
HT + TVA = TTC). L'artefact `debug-4escape` contient la capture d'écran, le CSV
téléchargé et `parsed-preview.json`. Quand le CA affiché == le CA réel de la
journée → relance avec `dry_run` = `0`. Ensuite le robot tourne **seul chaque nuit**.

> ✅ **Déjà calibré** le 21/07/2026 sur des exports réels, validés avec l'exploitant :
> CA TTC = somme des débits des lignes de compte 411 (clients), contrôlé par
> l'identité comptable HT (70 − 709) + TVA (445) = TTC au centime près, puis
> corrigé des chèques cadeaux (− utilisés + achetés). Sessions jouées = « Session
> de jeu » distinctes (catégorie Room, garanties et chèques exclus) filtrées sur la
> **Date d'évènement**. Joueurs = somme des quantités Room. Exemple validé (20/07) :
> CA 823 € · 3 sessions jouées · 11 joueurs · CA joué 302 €.

---

## ⏰ Horaire
Planifié à **02:07 UTC** = **04:07 (été) / 03:07 (hiver)** heure de Paris, en pleine
nuit, et traite **la veille** (journée complète et clôturée). Pour changer l'heure,
modifie `cron:` dans `.github/workflows/sync-4escape.yml` (⚠️ heure en **UTC**).

---

## 🧪 Tester en local (facultatif)
```bash
cd sync-4escape
npm install
npx playwright install chromium

# PowerShell :
$env:FE_USER="..."; $env:FE_PASS="..."
node scrape.mjs --headful --dry-run              # navigateur visible, hier, n'écrit rien
node scrape.mjs --dry-run --date=2026-07-20      # un jour précis
```
`--headful` = navigateur visible · `--dry-run` = n'écrit pas dans Firebase ·
`--keep-open` = laisse la fenêtre ouverte.

---

## 🛠️ Si un chiffre devient faux (maintenance)
Le robot détecte la **colonne montant** par son intitulé (`Montant`, `TTC`,
`Encaiss…`) et **ignore la ligne « TOTAL »**. Si 4escape change les intitulés ou la
mise en page :
- il **échoue franchement** (il n'écrit pas de fausse valeur) et joint la capture +
  le fichier dans l'artefact `debug-4escape` ;
- corrige en renseignant le secret **`COL_AMOUNT`** (bout d'intitulé de la colonne)
  et/ou **`COL_SESSIONS`**.

Garde-fou intégré : le robot **relit les champs date** avant de télécharger ; si la
période n'est pas bien réglée sur la veille, il **refuse** (pour ne pas exporter tout
le mois par erreur).

---

## 🔒 SÉCURITÉ IMPORTANTE — verrouille ta base Firebase
Ta base Firebase est actuellement **ouverte en lecture ET écriture à tout le monde**
(vérifié). L'adresse est visible dans `index.html` (dépôt public) → **n'importe qui
peut lire ou effacer les chiffres de ton équipe.**

À corriger : console Firebase → **Realtime Database → Règles**. Version recommandée
(garde l'auth anonyme que `index.html` utilise déjà) :

```json
{
  "rules": {
    "state": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

⚠️ Si tu appliques ça, **préviens-moi** : le robot écrit aujourd'hui en direct (base
ouverte). Il faudra lui ajouter une petite authentification (via la clé web Firebase,
comme `index.html`). C'est rapide.

---

## Résumé technique
1. Playwright (Chromium headless) → `braincaen.4escape.io/login`, formulaire
   `username`/`password` (session cookie).
2. Ouvre le **Journal des ventes**, vérifie/règle Type = Commandes, base = date de
   commande, **Statuts = Uniquement payé** (refuse d'exporter sinon), règle
   Date de début = fin = **veille**, **relit les dates** (garde-fou), clique
   **Télécharger**, capture le fichier.
3. Lit le fichier (SheetJS, en buffer), somme la colonne montant (hors ligne TOTAL),
   compte les sessions.
4. `PUT` idempotent `state/entries/auto-<date>` dans Firebase.
5. En cas d'erreur : capture + HTML + fichier + `parsed-preview.json` dans l'artefact
   `debug-4escape`, et le job **échoue** (GitHub t'envoie un email).
