#!/bin/sh
# ---------------------------------------------------------------------------
# REPRISE APRES SINISTRE : reconstruit /state/entries entierement depuis 4escape.
#
# A n'utiliser que si l'historique a ete perdu ou corrompu. N'ECRASE PAS les
# jours deja presents en base (le backfill les saute), donc relancable sans risque.
#
#   sh restore-history.sh              2020 -> aujourd'hui
#   sh restore-history.sh 2026-01-01:2026-08-23    une seule plage
#
# Duree : ~40 s par annee. Necessite .env (FE_USER / FE_PASS) et Playwright.
# Ne restaure PAS les avis Google quotidiens (le backfill les met a 0) : ils se
# reconstruisent depuis l'historique des commits de BRAINCaen/GAMEDOOR41,
# fichier data/google-reviews.json, dont le message de commit porte le total.
# ---------------------------------------------------------------------------
export TZ=Europe/Paris

if [ -n "$1" ]; then
  RANGES="$1"
else
  RANGES="2020-01-01:2020-12-31 2021-01-01:2021-12-31 2022-01-01:2022-12-31 \
          2023-01-01:2023-12-31 2024-01-01:2024-12-31 2025-01-01:2025-12-31 \
          2026-01-01:$(date +%Y-%m-%d)"
fi

for RANGE in $RANGES; do
  echo "=================== BACKFILL $RANGE ==================="
  node scrape.mjs --backfill=$RANGE || echo "!!! ECHEC sur $RANGE"
done
echo "=================== TERMINE ==================="
