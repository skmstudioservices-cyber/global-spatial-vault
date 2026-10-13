'use strict';
/**
 * sources.js — read any raw file into a uniform shape.
 *
 * Zero dependencies. Handles the formats your data actually arrives in:
 *   .csv  .tsv  .txt (delimited, delimiter auto-sniffed)
 *   .json        (array of objects, or { data: [...] })
 *   .jsonl/.ndjson
 *   .geojson     (features -> properties + lat/lng)
 *
 * Everything returns:
 *   { format, delimiter?, headers: string[], rows: object[], columns: Column[] }
 */
const fs = require('node:fs');
const path = require('node:path');
const xlsx = require('./xlsx');

/* ------------------------------------------------------------- delimited -- */

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** RFC-4180-ish parser: quotes, escaped quotes, embedded newlines. */
function parseDelimitedRaw(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = stripBom(text);

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Score a candidate delimiter by column-count consistency. */
function scoreDelimiter(text, delimiter) {
  const rows = parseDelimitedRaw(text.split(/\r?\n/).slice(0, 25).join('\n'), delimiter);
  if (!rows.length) return -1;
  const widths = rows.map((r) => r.length).filter((w) => w > 0);
  if (!widths.length) return -1;
  const counts = new Map();
  for (const w of widths) counts.set(w, (counts.get(w) || 0) + 1);
  let modal = 0;
  let modalHits = 0;
  for (const [w, n] of counts) if (n > modalHits || (n === modalHits && w > modal)) { modal = w; modalHits = n; }
  if (modal < 2) return -1;
  const consistency = modalHits / widths.length;
  return consistency * 1000 + modal;
}

function detectDelimiter(text) {
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const score = scoreDelimiter(text, d);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * A header row is textual, unique across columns, and — allowing for ONE blank
 * cell — non-empty. A single leading/trailing blank column is extremely common
 * in real exports (especially Indian Excel files), so it must not disqualify
 * the row.
 */
function looksLikeHeader(row, nextRow) {
  if (!row || !row.length) return false;
  const values = row.map((v) => String(v).trim());
  if (values.filter((v) => v === '').length > 1) return false;

  const nonEmpty = values.filter((v) => v !== '');
  if (nonEmpty.length < 2) return false;

  const uniq = new Set(nonEmpty.map((v) => v.toLowerCase()));
  if (uniq.size !== nonEmpty.length) return false;

  const textual = nonEmpty.filter((v) => !/^-?[\d.,]+$/.test(v)).length;
  if (textual < nonEmpty.length) return false;
  if (!nextRow) return true;

  const nextNumeric = nextRow.filter((v) => /^-?[\d.,]+$/.test(String(v).trim())).length;
  return nextNumeric > 0 || textual === nonEmpty.length;
}

/* ------------------------------------------------------------ type sniff -- */

function inferType(values) {
  const sample = values
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v !== '')
    .slice(0, 200);
  if (!sample.length) return 'text';
  if (sample.every((v) => /^-?\d+$/.test(v))) return 'integer';
  if (sample.every((v) => {
    const n = Number(v.replace(/[₹$€£,\s]/g, ''));
    return v !== '' && Number.isFinite(n);
  })) return 'number';
  if (sample.every((v) => /^(true|false|yes|no|y|n)$/i.test(v))) return 'boolean';
  // Dates must actually LOOK like dates — otherwise an id such as "XLS-3001"
  // (which contains four digits) is misread as one.
  const looksDate = (v) => /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/.test(v);
  if (sample.every((v) => looksDate(v) && !Number.isNaN(Date.parse(v)))) return 'date';
  return 'text';
}

/** Uniform column descriptors, used for mapping previews and validation. */
function describeColumns(headers, rows) {
  return headers.map((name) => {
    const values = rows.map((r) => r[name]);
    const nonEmpty = values.filter((v) => v != null && String(v).trim() !== '').length;
    return {
      name,
      type: inferType(values),
      nonEmpty,
      fillRate: rows.length ? Math.round((nonEmpty / rows.length) * 100) : 0,
      sample: values.find((v) => v != null && String(v).trim() !== '') ?? '',
    };
  });
}

function rowsFromMatrix(matrix, hasHeader) {
  if (!matrix.length) return { headers: [], rows: [] };
  if (hasHeader) {
    const headers = matrix[0].map((h, i) => {
      const clean = String(h).trim();
      return clean === '' ? `column_${i + 1}` : clean;
    });
    const rows = matrix.slice(1).map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] === undefined ? '' : cells[i]; });
      return obj;
    });
    return { headers, rows };
  }
  const width = Math.max(...matrix.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
  const rows = matrix.map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] === undefined ? '' : cells[i]; });
    return obj;
  });
  return { headers, rows };
}

/* --------------------------------------------------------------- readers -- */

function readDelimited(text, explicitDelimiter) {
  const delimiter = explicitDelimiter || detectDelimiter(text);
  const matrix = parseDelimitedRaw(text, delimiter).filter(
    (r) => !(r.length === 1 && String(r[0]).trim() === '')
  );
  const hasHeader = looksLikeHeader(matrix[0], matrix[1]);
  const { headers, rows } = rowsFromMatrix(matrix, hasHeader);
  return {
    format: delimiter === '\t' ? 'tsv' : 'csv',
    delimiter,
    hasHeader,
    headers,
    rows,
    columns: describeColumns(headers, rows),
  };
}

function readJson(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.data) ? parsed.data
      : (parsed && Array.isArray(parsed.rows) ? parsed.rows : null));
  if (!list) throw new Error('JSON must be an array, or an object with a data[] / rows[] array');

  const rows = list.map((item) => (item && typeof item === 'object' ? flatten(item) : { value: item }));
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { format: 'json', headers, rows, hasHeader: true, columns: describeColumns(headers, rows) };
}

function readJsonl(text) {
  const rows = stripBom(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => flatten(JSON.parse(line)));
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { format: 'jsonl', headers, rows, hasHeader: true, columns: describeColumns(headers, rows) };
}

function readGeoJson(text) {
  const gj = JSON.parse(text);
  const features = gj.type === 'FeatureCollection' ? (gj.features || []) : [gj];
  const rows = features.map((f) => {
    const props = flatten(f.properties || {});
    const geom = f.geometry || {};
    if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      props.lng = geom.coordinates[0];
      props.lat = geom.coordinates[1];
    }
    return props;
  });
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { format: 'geojson', headers, rows, hasHeader: true, columns: describeColumns(headers, rows) };
}

/** Flatten one level of nesting so `a.b` becomes a column (deep objects stay JSON). */
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const nested = flatten(v, key);
      const keys = Object.keys(nested);
      if (keys.length && keys.length <= 12) Object.assign(out, nested);
      else out[key] = JSON.stringify(v);
    } else {
      out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ xlsx -- */

/**
 * Read a real Excel workbook (.xlsx) with no dependency.
 * `opts.sheet` picks a worksheet by name or 1-based index; default is the first
 * non-empty sheet.
 */
function readXlsx(file, opts = {}) {
  const sheets = xlsx.readXlsxSheets(file).filter((s) => s.matrix.length);
  if (!sheets.length) throw new Error('The workbook has no non-empty worksheet');

  let chosen = sheets[0];
  if (opts.sheet !== undefined && opts.sheet !== null && opts.sheet !== true) {
    const wanted = String(opts.sheet).toLowerCase();
    chosen = sheets.find((s) => s.name.toLowerCase() === wanted)
      || sheets[Number(opts.sheet) - 1]
      || chosen;
  }

  // Exports often carry leading/trailing empty rows; drop them before sniffing.
  const matrix = chosen.matrix.filter((row) => row.some((c) => String(c).trim() !== ''));
  const hasHeader = looksLikeHeader(matrix[0], matrix[1]);
  const { headers, rows } = rowsFromMatrix(matrix, hasHeader);

  return {
    format: 'xlsx',
    sheet: chosen.name,
    sheets: sheets.map((s) => s.name),
    hasHeader,
    headers,
    rows,
    columns: describeColumns(headers, rows),
  };
}

/* ----------------------------------------------------------------- public -- */

const FORMATS = {
  csv: readDelimited,
  tsv: (text) => readDelimited(text, '\t'),
  txt: readDelimited,
  json: readJson,
  jsonl: readJsonl,
  ndjson: readJsonl,
  geojson: readGeoJson,
};

/** Read any supported file into { format, headers, rows, columns }. */
function readSource(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const ext = path.extname(abs).toLowerCase().replace('.', '');

  if (ext === 'xlsx') {
    return { ...readXlsx(abs, opts), file: abs, bytes: fs.statSync(abs).size };
  }
  if (ext === 'xls' || ext === 'xlsm') {
    throw new Error(`.${ext} is not a plain .xlsx — save as .xlsx or CSV UTF-8`);
  }
  if (ext === 'zip' || ext === 'gz') {
    throw new Error(`${ext.toUpperCase()} archives are not supported — extract the file first`);
  }

  const text = fs.readFileSync(abs, 'utf8');
  const reader = FORMATS[ext];
  const result = reader ? reader(text) : readDelimited(text);

  // Guard against a mismatched extension (e.g. a .txt that is really JSON).
  if (!result.headers.length && /^\s*[[{]/.test(text)) return readJson(text);

  return { ...result, file: abs, bytes: Buffer.byteLength(text, 'utf8'), ...opts };
}

module.exports = {
  readSource, readDelimited, readJson, readJsonl, readGeoJson, readXlsx,
  detectDelimiter, inferType, describeColumns, parseDelimitedMatrix: parseDelimitedRaw,
  rowsFromMatrix, flatten, looksLikeHeader,
};
