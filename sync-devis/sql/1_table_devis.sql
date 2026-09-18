-- ============================================================
--  GAMEDOOR·41 CRM — TABLE MIROIR DES DEVIS 4escape
--  À exécuter dans Supabase : SQL Editor → New Query → Run
--  Sans risque : ne crée qu'une table neuve, ne touche à aucune donnée existante.
-- ============================================================
--
--  RÔLE : mémoire de la synchro. Le robot y recopie l'état de chaque devis
--  4escape à chaque passage. C'est elle qui permet au bouton « Synchroniser »
--  de ne traiter QUE les nouveautés et de re-vérifier uniquement les devis
--  encore EN COURS. prospects / clients / activities en sont dérivés, ce qui
--  supprime la duplication d'historique et l'empilement des notes.
-- ============================================================

CREATE TABLE IF NOT EXISTS devis (
  -- Identité (référence 4escape = clé stable)
  reference        TEXT PRIMARY KEY,            -- '2026-D0103'
  annee            INT  NOT NULL,               -- 2026   ┐ décomposé pour trier
  type_ref         TEXT NOT NULL DEFAULT 'D',   -- 'D'    │ (devis vs facture)
  numero           INT  NOT NULL,               -- 103    ┘

  -- Client
  societe          TEXT,
  est_societe      BOOLEAN DEFAULT FALSE,       -- TYPE = Société (vs Particulier)
  client_nom       TEXT,                        -- Contact
  contact_email    TEXT,
  contact_tel      TEXT,

  -- Montants
  montant_ttc      NUMERIC(12,2) DEFAULT 0,     -- Montant TTC
  reste_du         NUMERIC(12,2) DEFAULT 0,     -- Total reste dû (0 = soldé)
  nb_joueurs       INT,

  -- Statut brut 4escape :
  --   completed / refunded = payé (figé)
  --   on-hold  = en attente de confirmation  ┐ EN COURS (re-vérifiés)
  --   pending  = en attente de paiement       ┘
  --   cancelled / failed = perdu (figé)
  statut           TEXT NOT NULL,

  -- Dates (colonnes réelles de l'export « entêtes de commande »)
  date_validation  DATE,                        -- Date validation
  date_evenement   DATE,                        -- Date evenement
  date_creation    TIMESTAMPTZ,                 -- Created On
  due_date         DATE,                        -- Due Date (échéance)
  recall_date      DATE,                        -- Recall Date (relance)
  date_cloture     DATE,                        -- Date de clôture

  -- Prestations (déduites de l'export « lignes de commande »)
  produits         TEXT,
  privatisation    BOOLEAN DEFAULT FALSE,
  repas            BOOLEAN DEFAULT FALSE,

  -- Suivi commercial
  contact_interne  TEXT,                        -- commercial qui suit
  source           TEXT,

  -- État dérivé : un devis figé n'est plus jamais re-traité pour mise à jour
  fige             BOOLEAN GENERATED ALWAYS AS
                     (statut IN ('completed','refunded','cancelled','failed')) STORED,

  -- Horodatage de synchro — matière première des futures « vitesses »
  premier_vu_le    TIMESTAMPTZ DEFAULT NOW(),   -- 1re fois vu par le robot
  vu_le            TIMESTAMPTZ DEFAULT NOW(),    -- dernier passage l'ayant touché
  statut_precedent TEXT,                        -- statut au passage précédent
  statut_change_le TIMESTAMPTZ,                 -- quand le statut a changé
  paye_le          TIMESTAMPTZ                  -- posé au passage où il devient payé
);

CREATE INDEX IF NOT EXISTS idx_devis_encours     ON devis(statut) WHERE fige = FALSE;
CREATE INDEX IF NOT EXISTS idx_devis_societe      ON devis(societe);
CREATE INDEX IF NOT EXISTS idx_devis_annee_numero ON devis(annee, type_ref, numero);
CREATE INDEX IF NOT EXISTS idx_devis_event        ON devis(date_evenement);

-- Sécurité : lecture réservée aux connectés du CRM ; écriture par le robot via
-- la clé service_role (qui contourne la RLS). On n'ouvre pas l'écriture au front.
ALTER TABLE devis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "devis_read" ON devis;
CREATE POLICY "devis_read" ON devis FOR SELECT TO authenticated USING (true);

-- ============================================================
--  Vérifs utiles (facultatif) :
--    SELECT count(*) FROM devis;
--    SELECT reference, societe, statut, reste_du
--      FROM devis WHERE fige = FALSE ORDER BY annee DESC, numero DESC;   -- les « en cours »
-- ============================================================
