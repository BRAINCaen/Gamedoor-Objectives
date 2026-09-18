-- ============================================================
--  GAMEDOOR·41 CRM — JOURNAL DES SYNCHROS
--  À exécuter dans Supabase après les autres. Sans risque (table neuve).
-- ============================================================
--  Le robot écrit ici une ligne par synchro (début → fin). Le CRM lit la
--  dernière ligne pour afficher au bouton « Synchroniser » son avancement et
--  son rapport, sans interroger GitHub.
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_runs (
  id           SERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  source       TEXT DEFAULT 'bouton',             -- bouton | cron | manuel
  rapport      JSONB,                              -- compteurs + tops
  message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sync_runs_read" ON sync_runs;
CREATE POLICY "sync_runs_read" ON sync_runs FOR SELECT TO authenticated USING (true);

-- Vérif : SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 5;
