/** Minimal RFC4180-ish CSV parser (handles quotes and commas). */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  const input = text.replace(/^\uFEFF/, '');

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return { headers, rows: rows.slice(1) };
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';
}

export const CSV_LEAD_COLUMNS = [
  'name',
  'contact_name',
  'contact_email',
  'contact_url',
  'website_url',
  'country',
  'industry',
  'requirements',
  'requested_skills',
  'budget_text',
  'notes',
  'source_url',
  'external_id',
  'post_date',
  'discovered_at',
  'stage',
] as const;
