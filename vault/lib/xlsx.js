'use strict';
/**
 * xlsx.js — read a real .xlsx workbook with ZERO dependencies.
 *
 * An .xlsx is a ZIP of XML. Node ships `zlib`, so a small central-directory ZIP
 * reader plus a couple of regex passes is enough — no npm package, no install,
 * and therefore no payment card (which is the whole point of this engine).
 *
 * Returns raw matrices only; `sources.js` turns them into rows so the two modules
 * do not have to require each other.
 *
 * Handles: shared strings, inline strings, numbers, booleans, error cells,
 * date-formatted numbers, sparse cell references (gaps), multiple worksheets.
 * Not handled (deliberately): .xls (legacy binary), encrypted workbooks, ZIP64.
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

/* -------------------------------------------------------------- minimal ZIP -- */

function readZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP container (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const lo = entry.localOffset;
      if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
      const nameLen = buf.readUInt16LE(lo + 26);
      const extraLen = buf.readUInt16LE(lo + 28);
      const start = lo + 30 + nameLen + extraLen;
      const data = buf.subarray(start, start + entry.compSize);
      if (entry.method === 0) return data;
      if (entry.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported ZIP compression method ${entry.method} in ${name}`);
    },
  };
}

/* ------------------------------------------------------------------- XML -- */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] !== undefined ? NAMED[body] : whole;
  });
}

/** Concatenate every <t> run inside a fragment (shared/inline strings). */
function collectText(xml) {
  let text = '';
  const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) text += decodeXml(m[1]);
  }
  return text;
}

const colIndex = (letters) => {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
};

/**
 * Read one attribute from a tag. XML does not guarantee attribute order, so
 * every attribute must be pulled independently — never with a combined regex
 * that assumes `a="..."` comes before `b="..."`.
 */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

/* ---------------------------------------------------------------- parts -- */

function readSharedStrings(zip) {
  const part = zip.read('xl/sharedStrings.xml');
  if (!part) return [];
  const xml = part.toString('utf8');
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(collectText(m[1]));
  return out;
}

/** Style indices whose number format is a date/time — so serials render as dates. */
function readDateStyles(zip) {
  const part = zip.read('xl/styles.xml');
  const styles = new Set();
  if (!part) return styles;
  const xml = part.toString('utf8');

  const custom = new Map();
  const nfRe = /<numFmt\b[^>]*\/?>/g;
  let m;
  while ((m = nfRe.exec(xml))) {
    const id = attr(m[0], 'numFmtId');
    if (id !== null) custom.set(Number(id), attr(m[0], 'formatCode') || '');
  }

  const isDateFmt = (id, code) => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    if (!code) return false;
    const stripped = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    return /[ymd]/i.test(stripped) && !/^[#0.,%\s-]*$/.test(stripped);
  };

  // Every <xf> in cellXfs advances the style index, including ones with no
  // numFmtId at all — skipping those would shift every later index.
  const cellXfs = (xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const xfRe = /<xf\b[^>]*?\/?>/g;
  let index = 0;
  while ((m = xfRe.exec(cellXfs))) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (isDateFmt(id, custom.get(id))) styles.add(index);
    index += 1;
  }
  return styles;
}

/** Worksheet name -> ZIP part path. */
function readWorkbookSheets(zip) {
  const wbPart = zip.read('xl/workbook.xml');
  if (!wbPart) throw new Error('xl/workbook.xml missing — not a valid .xlsx workbook');
  const wb = wbPart.toString('utf8');

  const rels = {};
  const relPart = zip.read('xl/_rels/workbook.xml.rels');
  if (relPart) {
    const re = /<Relationship\b[^>]*?\/?>/g;
    let m;
    while ((m = re.exec(relPart.toString('utf8')))) {
      const id = attr(m[0], 'Id');
      const target = attr(m[0], 'Target');
      if (id && target) rels[id] = target;
    }
  }

  const sheets = [];
  const sheetRe = /<sheet\b[^>]*\/?>/g;
  let m;
  while ((m = sheetRe.exec(wb))) {
    const tag = m[0];
    const name = attr(tag, 'name') || `Sheet${sheets.length + 1}`;
    const rid = attr(tag, 'r:id');
    let target = rid ? rels[rid] : null;
    if (target) {
      target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    }
    sheets.push({ name, path: target });
  }

  // Fallback for workbooks whose rels are missing or unusual.
  if (!sheets.length || sheets.every((s) => !s.path)) {
    const parts = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    return parts.map((p, i) => ({ name: `Sheet${i + 1}`, path: p }));
  }
  return sheets;
}

/* -------------------------------------------------------------- the sheet -- */

function serialToText(serial) {
  // Excel's day 1 is 1900-01-01; the epoch is 1899-12-30 (accounting for its
  // non-existent 1900-02-29).
  const ms = Math.round(serial * 86400000);
  const date = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function cellValue(type, body, shared, styleIndex, dateStyles) {
  if (type === 'inlineStr') return collectText(body);

  const vMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  const raw = vMatch ? decodeXml(vMatch[1]) : '';
  if (raw === '') return '';

  if (type === 's') {
    const n = Number(raw);
    return shared[n] !== undefined ? shared[n] : '';
  }
  if (type === 'b') return raw === '1' ? 'true' : 'false';
  if (type === 'str' || type === 'e') return raw;
  if (dateStyles.has(styleIndex) && /^-?\d+(\.\d+)?$/.test(raw)) return serialToText(Number(raw));
  return raw;
}

function parseSheet(xml, shared, dateStyles) {
  const matrix = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[1] || '';
    const cells = [];
    let sequential = 0;

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const index = refMatch ? colIndex(refMatch[1]) : sequential;
      sequential = index + 1;

      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const styleMatch = attrs.match(/\bs="(\d+)"/);
      const styleIndex = styleMatch ? Number(styleMatch[1]) : -1;

      cells[index] = cellValue(type, inner, shared, styleIndex, dateStyles);
    }
    matrix.push(cells);
  }

  const width = matrix.reduce((w, r) => Math.max(w, r.length), 0);
  for (const row of matrix) {
    for (let i = 0; i < width; i += 1) if (row[i] === undefined) row[i] = '';
  }
  return matrix;
}

/* ---------------------------------------------------------------- public -- */

/** Read every worksheet as a raw matrix: [{ name, matrix }]. */
function readXlsxSheets(file) {
  const buf = fs.readFileSync(file);
  const zip = readZip(buf);

  if (!zip.has('xl/workbook.xml') && !zip.names.some((n) => n.startsWith('xl/worksheets/'))) {
    throw new Error('Not an .xlsx workbook (no xl/ entries). Use CSV for other spreadsheets.');
  }

  const shared = readSharedStrings(zip);
  const dateStyles = readDateStyles(zip);
  const sheets = readWorkbookSheets(zip);

  return sheets.map((s) => {
    const part = s.path ? zip.read(s.path) : null;
    return {
      name: s.name,
      matrix: part ? parseSheet(part.toString('utf8'), shared, dateStyles) : [],
    };
  });
}

module.exports = { readXlsxSheets, readZip, decodeXml, collectText, colIndex, serialToText };
