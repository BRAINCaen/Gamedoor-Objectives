// Parsing CSV 4escape (séparateur ';', guillemets doublés, retours ligne dans
// les champs) + petits utilitaires de conversion. Identique au parseur du CRM.

export function parseCSV(txt) {
  txt = txt.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ';') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// CSV -> tableau d'objets {colonne: valeur}
export function parseObjects(txt) {
  const rows = parseCSV(txt);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

// "1 234,50" -> 1234.5
export function num(s) {
  const n = parseFloat(String(s || '0').replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// "28/08/2026" ou "28/08/2026 23:29:45" -> Date (locale) ou null
export function dateFR(s) {
  const m = String(s || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

// Date -> 'YYYY-MM-DD' ou null
export function iso(d) { return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null; }

// Date -> ISO complet (timestamptz) ou null
export function isoTs(d) { return d ? d.toISOString() : null; }

// Normalise un nom d'entreprise pour le rapprochement (retire forme juridique,
// accents, ponctuation). Identique à impNorm du CRM.
export function normSociete(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\b(SAS|SARL|SA|EURL|SASU|EI|SCI|ASSOCIATION|ASSO|CSE|CE|GROUPE|GROUP|FRANCE)\b/g, '')
    .replace(/[^A-Z0-9]/g, '');
}
