-- ============================================================
--  GAMEDOOR·41 CRM — COLONNES DE SCORE
--  À exécuter dans Supabase après 1_table_devis.sql. Sans risque : n'ajoute
--  que des colonnes (ne supprime rien, ne touche aux données existantes).
-- ============================================================
--
--  Deux scores indépendants (/10) :
--   · prospects.score        = POTENTIEL (déjà présent — était à 5 par défaut,
--                              désormais calculé par la synchro)
--   · clients.score_valeur   = VALEUR du client avéré (nouvelle colonne)
--
--  La synchro pose aussi, pour la transparence, le détail du calcul en JSON.
-- ============================================================

-- POTENTIEL : la colonne prospects.score existe déjà, on ajoute juste le détail.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS score_detail JSONB;

-- VALEUR : nouvelle colonne sur clients (1..10, NULL si pas encore calculé).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS score_valeur INT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS score_detail JSONB;

CREATE INDEX IF NOT EXISTS idx_clients_score ON clients(score_valeur DESC);

-- ============================================================
--  Vérif : SELECT societe, score_valeur FROM clients ORDER BY score_valeur DESC NULLS LAST LIMIT 20;
-- ============================================================
