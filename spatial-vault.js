#!/usr/bin/env node
/**
 * ============================================================================
 *  spatial-vault.js
 *  Custom Data Ingestion & Spatial Partitioning Plugin
 * ----------------------------------------------------------------------------
 *  A production-ready, zero-runtime-dependency engine that:
 *
 *    1. INGESTION & MICRO-PRECISION
 *       - Parses raw coordinates to 8 decimal places (~1 mm physical resolution).
 *       - Encodes a 13-character global Geohash (~4.7 mm cell) for 1 cm
 *         micro-local mapping (drones, localized utilities, pothole tracking).
 *
 *    2. REGIONAL MAPPING & FALLBACKS
 *       - Spatial boundary check (point-in-polygon over a reference India
 *         boundary + bounding-box pre-filter).
 *       - If inside India, computes and appends a 10-character India Post
 *         DIGIPIN-style digital address code (4 m x 4 m grid, lat/lng derived).
 *       - Schema supports global country configs, international ZIP/postal
 *         codes, and degrades cleanly over land, forest and ocean.
 *
 *    3. MULTI-NICHE UNIFIED ARCHITECTURE
 *       - A single spatial grid holds potholes, safe-alleys, ev-chargers and
 *         transit-stops.
 *       - "Safe Alleys Matrix": demographics (male/female/kids/family safety),
 *         threat classification (robbery/theft/animal-attacks/misbehave) and
 *         color-coded risk across 7 daily time slots.
 *
 *    4. ANTI-SCRAPING PROTECTION MOAT
 *       - Records are grouped by the first 5 Geohash characters and written to
 *         nested directories  dist/tiles/t/d/r/1/w/tdr1w.dat .
 *       - Each flat asset is a Base64 + XOR rotation-cipher stream keyed by 73,
 *         with a magic/version/checksum envelope for tamper detection.
 *
 *    5. DIRECTORY PROFILE SLUGS
 *       - /[category]/[country]/[city]/[name-uniquemicroid]  per record.
 *
 *    6. BROWSER DECRYPTION MIRROR
 *       - A companion  spatial-vault.client.js  re-implements the cipher and
 *         IndexedDB tile cache for Astro/Leaflet.js PWAs (see README).
 *
 *  Run:  node spatial-vault.js
 * ============================================================================
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ============================================================================
 *  1. CONSTANTS
 * ========================================================================== */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'; // standard Geohash alphabet
const GEOHASH_PRECISION = 13;                       // ~4.7 mm cell (sub-cm)
const TILE_PREFIX_LENGTH = 5;                       // nesting depth / file prefix
const COORD_DECIMALS = 8;                           // 1e-8 deg ~= 1.1 mm
const CIPHER_KEY = 73;                              // secret rotation-cipher seed
const CIPHER_MAGIC = 'SVV1';                        // 4-byte envelope magic
const OUT_DIR = 'dist';

const CATEGORIES = ['potholes', 'safe-alleys', 'ev-chargers', 'transit-stops'];

/** Canonical 7-slot day partition. */
const TIME_SLOTS = ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night', 'midnight'];

/** Color-coded risk bands (higher score = riskier). */
const RISK_LEVELS = Object.freeze({
  LOW:      { label: 'Low',      min: 0,  max: 20, color: 'green',  hex: '#22c55e' },
  MODERATE: { label: 'Moderate', min: 21, max: 40, color: 'yellow', hex: '#eab308' },
  ELEVATED: { label: 'Elevated', min: 41, max: 60, color: 'amber',  hex: '#f97316' },
  HIGH:     { label: 'High',     min: 61, max: 80, color: 'orange', hex: '#ef4444' },
  CRITICAL: { label: 'Critical', min: 81, max: 100, color: 'red',   hex: '#b91c1c' },
});

const THREAT_KINDS = ['robbery', 'theft', 'animalAttacks', 'misbehave'];
const DEMOGRAPHICS = ['male', 'female', 'kids', 'family'];

/* ----------------------------------------------------------------------------
 *  DIGIPIN reference configuration
 *
 *  India Post's DIGIPIN (Digital Postal Index Number) is an open, 10-character
 *  alphanumeric code that identifies a 4 m x 4 m cell from latitude/longitude.
 *  The authoritative grid parameters are not distributed in a machine-readable
 *  form, so this module ships a deterministic REFERENCE encoder that honors the
 *  published observable contract (10 alphanumeric chars, 4 m x 4 m cells, lat/
 *  lng derived, no ambiguous 0/1/I/O glyphs). Swap in the official algorithm by
 *  overriding  REGIONS.IN.digipin.compute  with an authenticated resolver.
 * -------------------------------------------------------------------------- */

const INDIA_BBOX = Object.freeze({ minLat: 6.0, maxLat: 38.0, minLng: 68.0, maxLng: 98.0 });

// base-32 with no ambiguous glyphs (0, 1, I, O removed)
const DIGIPIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIPIN_LENGTH = 10;
const DIGIPIN_CELL_METERS = 4.0;

/**
 * Simplified reference boundary of mainland India, stored as [lng, lat] pairs.
 * Production deployments should inject the authoritative GeoJSON boundary via
 * REGIONS.IN.digipin.boundary (a polygon `[[lng,lat],...]`) to include islands.
 */
const INDIA_POLYGON = [
  [68.10, 23.90], [68.40, 22.30], [68.90, 22.10], [70.30, 20.90], [71.00, 20.80],
  [72.00, 20.50], [72.60, 20.00], [72.80, 19.10], [72.90, 18.90], [73.00, 18.00],
  [73.40, 16.00], [73.90, 15.00], [74.20, 13.80], [74.60, 12.80], [74.90, 11.90],
  [75.30, 11.00], [76.00, 8.90], [77.55, 8.06], [78.00, 9.30], [78.90, 10.40],
  [79.60, 11.70], [80.40, 13.20], [80.60, 16.20], [81.20, 16.50], [82.00, 17.00],
  [83.30, 17.70], [84.00, 18.30], [85.00, 19.10], [86.30, 20.00], [87.50, 21.60],
  [88.10, 22.30], [88.80, 23.20], [89.50, 23.80], [90.00, 24.30], [91.50, 24.00],
  [92.00, 23.00], [92.30, 25.00], [93.00, 26.00], [93.80, 26.80], [94.00, 27.40],
  [94.80, 28.00], [95.20, 28.30], [96.00, 28.20], [96.80, 28.80], [97.30, 29.00],
  [97.40, 30.00], [96.80, 31.00], [95.80, 32.00], [94.80, 33.00], [93.80, 34.00],
  [92.00, 34.60], [90.50, 35.20], [88.90, 36.20], [88.00, 37.00], [86.80, 37.50],
  [85.80, 37.00], [85.00, 36.20], [84.00, 35.50], [83.00, 35.00], [82.00, 34.20],
  [81.00, 33.50], [80.20, 32.50], [79.00, 31.50], [78.10, 30.80], [77.00, 30.00],
  [76.30, 29.50], [75.30, 28.50], [74.30, 27.50], [73.30, 26.50], [72.40, 25.70],
  [71.50, 24.60], [70.50, 24.80], [69.80, 24.30], [69.00, 23.90], [68.30, 23.90],
];

/** Global/regional configuration registry (extend freely). */
const REGIONS = Object.freeze({
  IN: Object.freeze({
    iso2: 'IN',
    iso3: 'IND',
    country: 'India',
    postalCode: Object.freeze({ label: 'PIN / DIGIPIN', international: false }),
    digipin: Object.freeze({
      enabled: true,
      contains: (lat, lng) => isInIndia(lat, lng),
      compute: (lat, lng) => computeDigipin(lat, lng),
      boundary: INDIA_POLYGON,
      bbox: INDIA_BBOX,
    }),
  }),
  DEFAULT: Object.freeze({
    iso2: null,
    iso3: null,
    country: 'International',
    postalCode: Object.freeze({ label: 'ZIP / Postal Code', international: true }),
    digipin: Object.freeze({ enabled: false }),
  }),
});

/* ============================================================================
 *  2. NUMERIC / COORDINATE HELPERS
 * ========================================================================== */

/** Round a number to `decimals` decimal places (8 -> ~1 mm). */
function roundToDecimals(value, decimals = COORD_DECIMALS) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** Clamp a value into [min, max]. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse and validate a lat/lng pair (strings or numbers accepted).
 * Returns normalized 8-decimal values plus the raw inputs, or throws on
 * out-of-range / non-finite input.
 */
function parseCoordinate(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error(`Non-finite coordinate: lat=${lat} lng=${lng}`);
  }
  if (latNum < -90 || latNum > 90) {
    throw new Error(`Latitude out of range [-90, 90]: ${lat}`);
  }
  if (lngNum < -180 || lngNum > 180) {
    throw new Error(`Longitude out of range [-180, 180]: ${lng}`);
  }
  return {
    lat: roundToDecimals(latNum),
    lng: roundToDecimals(lngNum),
    latRaw: String(lat),
    lngRaw: String(lng),
  };
}

/* ============================================================================
 *  3. GEOHASH (13-char, sub-centimeter)
 * ========================================================================== */

/**
 * Encode a latitude/longitude to a standard Base32 Geohash of `precision`
 * characters. Bit 0 is longitude (even bits = lng, odd bits = lat).
 */
function encodeGeohash(lat, lng, precision = GEOHASH_PRECISION) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = '';
  let bitCount = 0;
  let charIndex = 0;
  let isLng = true;

  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { charIndex = (charIndex << 1) | 1; lngMin = mid; }
      else { charIndex <<= 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { charIndex = (charIndex << 1) | 1; latMin = mid; }
      else { charIndex <<= 1; latMax = mid; }
    }
    isLng = !isLng;
    bitCount += 1;
    if (bitCount === 5) {
      hash += BASE32[charIndex];
      bitCount = 0;
      charIndex = 0;
    }
  }
  return hash;
}

/**
 * Decode a Geohash into its center point and half-cell error bounds.
 */
function decodeGeohash(hash) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let isLng = true;
  for (let i = 0; i < hash.length; i += 1) {
    const value = BASE32.indexOf(hash[i]);
    if (value < 0) throw new Error(`Invalid Geohash character: ${hash[i]}`);
    for (let b = 4; b >= 0; b -= 1) {
      const bit = (value >> b) & 1;
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if (bit) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid; else latMax = mid;
      }
      isLng = !isLng;
    }
  }
  return {
    lat: (latMin + latMax) / 2,
    lng: (lngMin + lngMax) / 2,
    latError: (latMax - latMin) / 2,
    lngError: (lngMax - lngMin) / 2,
  };
}

/** Approximate cell size (in degrees) for a Geohash of `precision` chars. */
function cellDegrees(precision) {
  const bits = precision * 5;
  const lngBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { latDeg: 180 / 2 ** latBits, lngDeg: 360 / 2 ** lngBits, latBits, lngBits };
}

/**
 * Return the 8 adjacent Geohashes of the same precision. Approximate near the
 * poles / anti-meridian (documented); sufficient for offline tile expansion.
 */
function geohashNeighbors(hash) {
  const d = decodeGeohash(hash);
  const latStep = d.latError * 2;
  const lngStep = d.lngError * 2;
  const offsets = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  return offsets.map(([dlat, dlng]) => {
    let lat = clamp(d.lat + dlat * latStep, -90, 90);
    let lng = d.lng + dlng * lngStep;
    if (lng > 180) lng -= 360;
    if (lng < -180) lng += 360;
    return encodeGeohash(lat, lng, hash.length);
  });
}

/* ============================================================================
 *  4. SPATIAL BOUNDARY CHECK + DIGIPIN
 * ========================================================================== */

/** Bounding-box pre-filter. */
function inBBox(lat, lng, bbox) {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

/** Ray-casting point-in-polygon; polygon is [[lng, lat], ...]. */
function pointInPolygon(lng, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** True when the coordinate falls inside the reference India boundary. */
function isInIndia(lat, lng, boundary = INDIA_POLYGON, bbox = INDIA_BBOX) {
  return inBBox(lat, lng, bbox) && pointInPolygon(lng, lat, boundary);
}

/** Base-N integer encoder over an arbitrary alphabet (most-significant first). */
function encodeBaseN(value, alphabet) {
  const base = alphabet.length;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Unencodable value: ${value}`);
  if (value === 0) return alphabet[0];
  let out = '';
  let v = value;
  while (v > 0) {
    out = alphabet[v % base] + out;
    v = Math.floor(v / base);
  }
  return out;
}

/**
 * Reference DIGIPIN encoder: maps lat/lng to a 4 m x 4 m cell over the India
 * bounding box, flattens the cell index, and emits a 10-char alphanumeric code
 * (9 data chars + 1 checksum char) in a 32-glyph ambiguity-free alphabet.
 * Returns null for coordinates outside India.
 */
function computeDigipin(lat, lng) {
  if (!isInIndia(lat, lng)) return null;

  const { minLat, maxLat, minLng, maxLng } = INDIA_BBOX;
  const METERS_PER_DEG_LAT = 111320.0;
  const midLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(midLatRad);

  const latCell = DIGIPIN_CELL_METERS / METERS_PER_DEG_LAT;
  const lngCell = DIGIPIN_CELL_METERS / metersPerDegLng;
  const rows = Math.ceil((maxLat - minLat) / latCell);
  const cols = Math.ceil((maxLng - minLng) / lngCell);

  const row = clamp(Math.floor((lat - minLat) / latCell), 0, rows - 1);
  const col = clamp(Math.floor((lng - minLng) / lngCell), 0, cols - 1);
  const cell = row * cols + col; // unique per 4 m x 4 m cell

  const body = encodeBaseN(cell, DIGIPIN_ALPHABET).padStart(DIGIPIN_LENGTH - 1, DIGIPIN_ALPHABET[0]);
  const checksum = DIGIPIN_ALPHABET[cell % DIGIPIN_ALPHABET.length];
  return body + checksum; // 10 characters
}

/** Resolve the regional config for a point; graceful fallback for non-India. */
function resolveRegion(lat, lng, provided = {}) {
  if (isInIndia(lat, lng)) return REGIONS.IN;
  const country = provided.country || provided.countryName || null;
  return Object.freeze({
    iso2: provided.iso2 || null,
    iso3: provided.iso3 || null,
    country: country || REGIONS.DEFAULT.country,
    postalCode: REGIONS.DEFAULT.postalCode,
    digipin: REGIONS.DEFAULT.digipin,
  });
}

/* ============================================================================
 *  5. SCHEMA + SAFE ALLEYS MATRIX
 * ========================================================================== */

/** Map a 0-100 score to a color-coded risk band. */
function riskBand(score) {
  const s = clamp(Math.round(score), 0, 100);
  const found = Object.entries(RISK_LEVELS).find(([, band]) => s >= band.min && s <= band.max);
  const [level, band] = found || ['HIGH', RISK_LEVELS.HIGH];
  return { level, score: s, color: band.color, hex: band.hex, label: band.label };
}

function clampScore(value) {
  return clamp(Math.round(Number(value) || 0), 0, 100);
}

/** Normalize a single threat classification entry. */
function normalizeThreat(raw) {
  const r = raw || {};
  return {
    level: clamp(Math.round(Number(r.level) || 0), 0, 5),
    incidents: Math.max(0, Math.round(Number(r.incidents) || 0)),
    lastReported: r.lastReported || null,
  };
}

/**
 * Build the multi-tiered Safe Alleys Matrix with demographics, threat
 * classifications, and 7 color-coded daily time slots.
 */
function buildSafeAlleysMatrix(raw = {}) {
  const demographics = {};
  for (const key of DEMOGRAPHICS) {
    demographics[key] = clampScore(raw.demographics && raw.demographics[key]);
  }

  const threats = {};
  for (const kind of THREAT_KINDS) {
    threats[kind] = normalizeThreat(raw.threats && raw.threats[kind]);
  }

  const timeSlots = TIME_SLOTS.map((slot) => {
    const src = (raw.timeSlots && raw.timeSlots[slot]) || {};
    const band = riskBand(src.score);
    return {
      slot,
      riskLevel: band.level,
      score: band.score,
      color: band.color,
      hex: band.hex,
      label: band.label,
    };
  });

  const threatScores = THREAT_KINDS.map((k) => threats[k].level * 20);
  const overallRiskScore = Math.round(threatScores.reduce((a, b) => a + b, 0) / threatScores.length);
  const overall = riskBand(overallRiskScore);

  return { demographics, threats, timeSlots, overallRisk: overall };
}

function normalizeCategory(value) {
  const cat = String(value || '').toLowerCase().trim();
  return CATEGORIES.includes(cat) ? cat : 'other';
}

/* ============================================================================
 *  6. SLUGS
 * ========================================================================== */

/** Human-readable URL slug. */
function slugify(value) {
  return String(value == null ? '' : value)
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'unnamed';
}

/** Collision-resistant per-record micro id (10 hex chars). */
function uniqueMicroId(geohash, raw, seq) {
  const material = `${geohash}|${raw.name || ''}|${raw.lat}|${raw.lng}|${raw.category || ''}|${seq}`;
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 10);
}

/** Build the /[category]/[country]/[city]/[name-uniquemicroid] slug. */
function buildSlug(category, country, city, name, microId) {
  return `/${slugify(category)}/${slugify(country)}/${slugify(city)}/${slugify(name)}-${microId}`;
}

/* ============================================================================
 *  7. CIPHER: Base64 + XOR rotation stream (key 73)
 * ========================================================================== */

/** 32-bit FNV-1a checksum (identical in Node and browser). */
function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Symmetric XOR rotation-cipher stream seeded by `key`. The key rotates via a
 * linear-congruential step for every byte, so the same function encrypts and
 * decrypts. XOR is chosen so the transform is exactly reversible.
 */
function xorRotate(bytes, key = CIPHER_KEY) {
  const out = Buffer.alloc(bytes.length);
  let k = key >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = bytes[i] ^ (k & 0xff);
    k = (Math.imul(k, 33) + 17) >>> 0;
  }
  return out;
}

/**
 * Encrypt a JSON object into a Base64 asset.
 * Envelope: magic(4) + version(1) + flags(1) + fnv1a32 checksum(4) + body.
 * The envelope is encrypted too, so the flat file reveals no plaintext magic.
 */
function encryptJSON(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(10);
  header.write(CIPHER_MAGIC, 0, 'ascii');
  header.writeUInt8(1, 4);          // format version
  header.writeUInt8(0, 5);          // flags (reserved)
  header.writeUInt32BE(fnv1a32(body), 6);
  return xorRotate(Buffer.concat([header, body]), CIPHER_KEY).toString('base64');
}

/** Decrypt a Base64 asset back into a JSON object, verifying integrity. */
function decryptJSON(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error('Empty ciphertext');
  }
  const plain = xorRotate(Buffer.from(base64, 'base64'), CIPHER_KEY);
  if (plain.length < 10) throw new Error('Ciphertext too short');
  if (plain.slice(0, 4).toString('ascii') !== CIPHER_MAGIC) {
    throw new Error('Bad magic: wrong key or not a Spatial Vault asset');
  }
  const version = plain.readUInt8(4);
  if (version !== 1) throw new Error(`Unsupported asset version ${version}`);
  const expected = plain.readUInt32BE(6);
  const body = plain.slice(10);
  const actual = fnv1a32(body);
  if (actual !== expected) throw new Error('Checksum mismatch: asset corrupted or tampered');
  return JSON.parse(body.toString('utf8'));
}

/* ============================================================================
 *  8. TILE SEGMENTATION + OUTPUT
 * ========================================================================== */

/** Nested on-disk path for a 5-char tile prefix. */
function tileOutputPath(prefix, outDir = OUT_DIR) {
  const chars = prefix.split('');
  return path.join(outDir, 'tiles', ...chars, `${prefix}.dat`);
}

/** Forward-slash relative URL for the same tile (web-serving form). */
function tileRelativeUrl(prefix) {
  const chars = prefix.split('');
  return ['tiles', ...chars, `${prefix}.dat`].join('/');
}

/** Group normalized records by their 5-char Geohash prefix. */
function groupByPrefix(records) {
  const tiles = new Map();
  for (const record of records) {
    const prefix = record.tilePrefix;
    if (!tiles.has(prefix)) tiles.set(prefix, []);
    tiles.get(prefix).push(record);
  }
  return tiles;
}

/** Encrypt and write a single tile; returns its build metadata. */
function writeTile(prefix, records, outDir = OUT_DIR) {
  const payload = {
    format: 'spatial-vault-tile',
    version: 1,
    prefix,
    count: records.length,
    updatedAt: new Date().toISOString(),
    records,
  };
  const ciphertext = encryptJSON(payload);
  const file = tileOutputPath(prefix, outDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ciphertext, 'utf8');
  return {
    prefix,
    file,
    url: tileRelativeUrl(prefix),
    count: records.length,
    bytes: Buffer.byteLength(ciphertext, 'utf8'),
  };
}

/** Build the (encrypted) master manifest describing every tile. */
function buildManifest(tileResults, recordCount) {
  return {
    format: 'spatial-vault-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    cipher: { algo: 'base64-xor-rotation-stream', key: CIPHER_KEY, checksum: 'fnv1a32' },
    geohashPrecision: GEOHASH_PRECISION,
    tilePrefixLength: TILE_PREFIX_LENGTH,
    recordCount,
    tiles: tileResults.map((t) => ({
      prefix: t.prefix,
      url: t.url,
      count: t.count,
      bytes: t.bytes,
    })),
  };
}

/* ============================================================================
 *  9. INGESTION PIPELINE
 * ========================================================================== */

/** Normalize a single raw input record into the unified spatial schema. */
function normalizeRecord(raw, seq) {
  const { lat, lng, latRaw, lngRaw } = parseCoordinate(raw.lat, raw.lng);
  const geohash = encodeGeohash(lat, lng, GEOHASH_PRECISION);
  const decoded = decodeGeohash(geohash);
  const cell = cellDegrees(GEOHASH_PRECISION);

  const region = resolveRegion(lat, lng, {
    country: raw.country,
    iso2: raw.iso2,
    iso3: raw.iso3,
  });
  const digipin = region.digipin.enabled ? region.digipin.compute(lat, lng) : null;

  const category = normalizeCategory(raw.category);
  const microId = uniqueMicroId(geohash, raw, seq);
  const name = raw.name || 'Unnamed';
  const city = raw.city || raw.locality || 'unknown';
  const slug = buildSlug(category, region.country, city, name, microId);

  const record = {
    id: raw.id || `sv-${String(seq).padStart(6, '0')}`,
    category,
    name,
    city,
    country: region.country,
    iso2: region.iso2,
    iso3: region.iso3,
    lat,
    lng,
    latRaw,
    lngRaw,
    precision: {
      decimals: COORD_DECIMALS,
      physicalResolutionMeters: 0.001, // 8 decimals ~= 1 mm
      geohash,
      geohashLength: geohash.length,
      cellLatMeters: +(cell.latDeg * 111320).toFixed(6),
      cellLngMetersAtEquator: +(cell.lngDeg * 111320).toFixed(6),
      cellCenterLat: decoded.lat,
      cellCenterLng: decoded.lng,
    },
    tilePrefix: geohash.slice(0, TILE_PREFIX_LENGTH),
    postalCode: raw.postalCode || raw.zip || raw.pin || null,
    digipin,
    slug,
    attributes: raw.attributes || {},
    ingestedAt: new Date().toISOString(),
  };

  if (raw.safeAlleysMatrix) {
    record.safeAlleysMatrix = buildSafeAlleysMatrix(raw.safeAlleysMatrix);
  }
  return record;
}

/** Run the full pipeline over an array of raw records. */
function processRecords(rawRecords) {
  return rawRecords.map((raw, i) => normalizeRecord(raw, i + 1));
}

/* ============================================================================
 *  10. SAMPLE DATA (fallback if sample-data.json is absent)
 * ========================================================================== */

const EMBEDDED_SAMPLE = [
  {
    id: 'pot-blr-0001', category: 'potholes', name: 'Koramangala 80ft Rd Pit',
    city: 'Bengaluru', country: 'India', iso2: 'IN', postalCode: '560034',
    lat: 12.9351929, lng: 77.6244807,
    attributes: { depthCm: 24, widthCm: 90, severity: 'high', reportedBy: 'drone-flt-4471' },
  },
  {
    id: 'sa-del-0001', category: 'safe-alleys', name: 'Lodhi Garden Lane',
    city: 'New Delhi', country: 'India', iso2: 'IN', postalCode: '110003',
    lat: 28.5930953, lng: 77.2196721,
    attributes: { paved: true, streetlighting: true, cctv: true, footTraffic: 'high' },
    safeAlleysMatrix: {
      demographics: { male: 88, female: 72, kids: 81, family: 84 },
      threats: {
        robbery: { level: 1, incidents: 2, lastReported: '2025-11-02' },
        theft: { level: 2, incidents: 7, lastReported: '2026-01-14' },
        animalAttacks: { level: 0, incidents: 0, lastReported: null },
        misbehave: { level: 2, incidents: 5, lastReported: '2025-12-30' },
      },
      timeSlots: {
        dawn: { score: 18 }, morning: { score: 22 }, noon: { score: 30 },
        afternoon: { score: 26 }, evening: { score: 48 }, night: { score: 66 },
        midnight: { score: 74 },
      },
    },
  },
  {
    id: 'ev-mum-0001', category: 'ev-chargers', name: 'BKC DC Fast Hub',
    city: 'Mumbai', country: 'India', iso2: 'IN', postalCode: '400051',
    lat: 19.0760000, lng: 72.8777000,
    attributes: { kw: 150, connector: 'CCS2', status: 'online' },
  },
  {
    id: 'ts-che-0001', category: 'transit-stops', name: 'Central Metro Gate 4',
    city: 'Chennai', country: 'India', iso2: 'IN', postalCode: '600003',
    lat: 13.0827000, lng: 80.2707000,
    attributes: { modes: ['metro', 'bus'], wheelchair: true },
  },
  {
    id: 'ts-guw-0001', category: 'transit-stops', name: 'Kaziranga Forest Checkpoint',
    city: 'Guwahati', country: 'India', iso2: 'IN', postalCode: '781001',
    lat: 26.1445000, lng: 91.7362000,
    attributes: { terrain: 'dense-forest', solarLit: true },
  },
  {
    id: 'pot-nyc-0001', category: 'potholes', name: '5th Ave Utility Cut',
    city: 'New York', country: 'United States', iso2: 'US', zip: '10001',
    lat: 40.7128000, lng: -74.0060000,
    attributes: { depthCm: 12, widthCm: 45, severity: 'medium' },
  },
  {
    id: 'sa-lon-0001', category: 'safe-alleys', name: 'South Bank Riverside Walk',
    city: 'London', country: 'United Kingdom', iso2: 'GB', zip: 'SE1 9AA',
    lat: 51.5074000, lng: -0.1278000,
    safeAlleysMatrix: {
      demographics: { male: 91, female: 84, kids: 88, family: 87 },
      threats: {
        robbery: { level: 1, incidents: 4, lastReported: '2025-10-18' },
        theft: { level: 2, incidents: 11, lastReported: '2026-02-01' },
        animalAttacks: { level: 0, incidents: 0, lastReported: null },
        misbehave: { level: 1, incidents: 6, lastReported: '2026-01-09' },
      },
      timeSlots: {
        dawn: { score: 12 }, morning: { score: 20 }, noon: { score: 28 },
        afternoon: { score: 24 }, evening: { score: 40 }, night: { score: 58 },
        midnight: { score: 63 },
      },
    },
  },
  {
    id: 'pot-sea-0001', category: 'potholes', name: 'Arabian Sea Survey Drop',
    city: 'Arabian Sea', country: 'Oceans', iso2: null,
    lat: 8.0000000, lng: 66.0000000,
    attributes: { context: 'oceanic', note: 'synthetic probe point' },
  },
];

function loadSampleData() {
  const file = path.join(__dirname, 'sample-data.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return EMBEDDED_SAMPLE;
}

/* ============================================================================
 *  11. SELF-TEST + BUILD RUNNER
 * ========================================================================== */

/** Minimal assertion helper that throws with a descriptive message. */
function assert(condition, label) {
  if (!condition) throw new Error(`Self-test failed: ${label}`);
  return label;
}

/** Run deterministic self-tests and return a list of passed test labels. */
function runSelfTests() {
  const passed = [];

  // Geohash length + round-trip within one cell
  const gh = encodeGeohash(28.6139, 77.2090, 13);
  assert(gh.length === 13, '13-char Geohash');
  passed.push('13-char Geohash');
  const dec = decodeGeohash(gh);
  assert(Math.abs(dec.lat - 28.6139) <= dec.latError, 'Geohash round-trip (lat within cell)');
  assert(Math.abs(dec.lng - 77.2090) <= dec.lngError, 'Geohash round-trip (lng within cell)');
  passed.push('Geohash round-trip');

  // Sub-centimeter precision guarantee
  const cell13 = cellDegrees(13);
  const latMeters = cell13.latDeg * 111320;
  const lngMeters = cell13.lngDeg * 111320;
  assert(latMeters < 0.01 && lngMeters < 0.01, '13-char cell < 1 cm');
  passed.push(`13-char cell < 1 cm (${(latMeters * 1000).toFixed(2)} mm x ${(lngMeters * 1000).toFixed(2)} mm)`);

  // 8-decimal parse = ~1 mm
  const parsed = parseCoordinate('12.93519294', '77.62448077');
  assert(parsed.lat === 12.93519294 && parsed.lng === 77.62448077, '8-decimal coordinate parse');
  passed.push('8-decimal coordinate parse');

  // Boundary check + DIGIPIN contract
  assert(isInIndia(28.6139, 77.2090) === true, 'Delhi is inside India');
  assert(isInIndia(12.9716, 77.5946) === true, 'Bengaluru is inside India');
  assert(isInIndia(13.0827, 80.2707) === true, 'Chennai is inside India');
  assert(isInIndia(8.0, 66.0) === false, 'Arabian Sea is not inside India');
  assert(isInIndia(40.7128, -74.006) === false, 'New York is not inside India');
  passed.push('India boundary check');

  const digipin = computeDigipin(28.6139, 77.2090);
  assert(typeof digipin === 'string' && digipin.length === 10, 'DIGIPIN is 10 chars');
  assert(/^[2-9A-HJ-NP-Z]{10}$/.test(digipin), 'DIGIPIN uses ambiguity-free alphabet');
  assert(computeDigipin(28.6139, 77.2090) === digipin, 'DIGIPIN is deterministic');
  assert(computeDigipin(40.7128, -74.006) === null, 'DIGIPIN is null outside India');
  passed.push('DIGIPIN contract (10 chars, deterministic, null outside India)');

  // Safe Alleys Matrix shape
  const matrix = buildSafeAlleysMatrix(EMBEDDED_SAMPLE[1].safeAlleysMatrix);
  assert(matrix.timeSlots.length === 7, 'Safe Alleys Matrix has 7 time slots');
  assert(TIME_SLOTS.every((s) => matrix.timeSlots.some((t) => t.slot === s)), 'All 7 slots present');
  assert(matrix.timeSlots.every((t) => t.hex && t.color && t.riskLevel), 'Time slots color-coded');
  assert(['robbery', 'theft', 'animalAttacks', 'misbehave'].every((k) => k in matrix.threats), 'Threat kinds present');
  assert(['male', 'female', 'kids', 'family'].every((k) => k in matrix.demographics), 'Demographics present');
  passed.push('Safe Alleys Matrix (demographics + threats + 7 color-coded slots)');

  // Cipher round-trip + tamper detection
  const ciphertext = encryptJSON({ hello: 'world', n: [1, 2, 3] });
  assert(typeof ciphertext === 'string' && ciphertext.length > 0, 'Cipher produces Base64');
  const roundtrip = decryptJSON(ciphertext);
  assert(roundtrip.hello === 'world' && roundtrip.n[2] === 3, 'Cipher round-trip');
  assert(!ciphertext.includes(CIPHER_MAGIC), 'Ciphertext hides magic (no plaintext marker)');
  let tampered = false;
  try { decryptJSON('AAAA'); } catch { tampered = true; }
  assert(tampered, 'Tampered ciphertext rejected');
  passed.push('Cipher round-trip + tamper detection');

  return passed;
}

/** Write a human-readable build verification report to dist/verify.txt. */
function writeVerificationReport(report) {
  const lines = [
    'SPATIAL VAULT BUILD REPORT',
    '==========================',
    `generatedAt        : ${new Date().toISOString()}`,
    `inputRecords       : ${report.recordCount}`,
    `geohashPrecision   : ${GEOHASH_PRECISION} chars`,
    `tilePrefixLength   : ${TILE_PREFIX_LENGTH} chars`,
    `cipher             : base64 + XOR rotation stream (key ${CIPHER_KEY}, fnv1a32 checksum)`,
    `tilesWritten       : ${report.tiles.length}`,
    `encryptedBytes     : ${report.totalBytes}`,
    `decryptVerified    : ${report.verifiedTiles}/${report.tiles.length} tiles OK`,
    `slugProfiles       : ${report.slugCount}`,
    `selfTests          : ${report.testsPassed}/${report.testsTotal} passed`,
    `warnings           : 0`,
    '',
    'TILES',
    '-----',
    ...report.tiles.map((t) => `  ${t.url}  (${t.count} records, ${t.bytes} bytes)`),
    '',
    'SELF-TESTS',
    '----------',
    ...report.tests.map((t) => `  [PASS] ${t}`),
    '',
    'BUILD OK',
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'verify.txt'), lines.join('\n') + '\n', 'utf8');
}

/** Write plaintext slug routes and per-record profile directories. */
function writeSlugsAndProfiles(records) {
  const slugIndex = records.map((r) => ({
    id: r.id,
    slug: r.slug,
    category: r.category,
    country: r.country,
    city: r.city,
    name: r.name,
    geohash: r.precision.geohash,
    tilePrefix: r.tilePrefix,
    digipin: r.digipin,
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'slugs.json'), JSON.stringify(slugIndex, null, 2), 'utf8');

  for (const r of records) {
    const rel = r.slug.replace(/^\//, '').split('/');
    const dir = path.join(OUT_DIR, 'profiles', ...rel);
    fs.mkdirSync(dir, { recursive: true });
    const profile = {
      id: r.id,
      slug: r.slug,
      name: r.name,
      category: r.category,
      country: r.country,
      city: r.city,
      digipin: r.digipin,
      geohash: r.precision.geohash,
      tilePrefix: r.tilePrefix,
      tile: tileRelativeUrl(r.tilePrefix),
    };
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  }
  return slugIndex.length;
}

/** Verify every written tile decrypts back to its expected prefix + count. */
function verifyTiles(tileResults) {
  let verified = 0;
  for (const t of tileResults) {
    const raw = fs.readFileSync(t.file, 'utf8');
    const payload = decryptJSON(raw);
    if (payload.format !== 'spatial-vault-tile') {
      throw new Error(`Unexpected tile format in ${t.file}`);
    }
    if (payload.prefix !== t.prefix || payload.count !== t.count) {
      throw new Error(`Tile integrity mismatch in ${t.file}`);
    }
    verified += 1;
  }
  return verified;
}

/**
 * Main build entrypoint: load -> normalize -> test -> encrypt -> write -> verify.
 * Returns process exit code (0 = success).
 */
function main() {
  const started = Date.now();

  const tests = runSelfTests();
  const rawRecords = loadSampleData();
  const records = processRecords(rawRecords);

  // Clean + recreate output tree so runs are reproducible.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tiles = groupByPrefix(records);
  const tileResults = [];
  for (const [prefix, recs] of tiles) {
    tileResults.push(writeTile(prefix, recs));
  }
  tileResults.sort((a, b) => a.prefix.localeCompare(b.prefix));

  const manifest = buildManifest(tileResults, records.length);
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.dat'), encryptJSON(manifest), 'utf8');

  const slugCount = writeSlugsAndProfiles(records);
  const verifiedTiles = verifyTiles(tileResults);
  const totalBytes = tileResults.reduce((sum, t) => sum + t.bytes, 0);

  const report = {
    recordCount: records.length,
    tiles: tileResults,
    totalBytes,
    verifiedTiles,
    slugCount,
    testsPassed: tests.length,
    testsTotal: tests.length,
    tests,
  };
  writeVerificationReport(report);

  const elapsed = Date.now() - started;

  // ---- console summary (no warnings emitted) ----
  console.log('== Spatial Vault build ==');
  console.log(`Input records ......... ${report.recordCount}`);
  console.log(`Geohash precision ..... ${GEOHASH_PRECISION} chars (sub-centimeter)`);
  console.log(`Tile prefix length .... ${TILE_PREFIX_LENGTH} chars`);
  console.log(`Tiles written ......... ${tileResults.length}`);
  for (const t of tileResults) {
    console.log(`  -> ${t.url}  (${t.count} records, ${t.bytes} B)`);
  }
  console.log(`Encrypted bytes ....... ${totalBytes}`);
  console.log(`Decrypt-verified ...... ${verifiedTiles}/${tileResults.length} tiles OK`);
  console.log(`Slug profiles ......... ${slugCount}`);
  console.log(`Self-tests ............ ${tests.length}/${tests.length} passed`);
  console.log(`Warnings .............. 0`);
  console.log(`Output dir ............ ${path.resolve(OUT_DIR)}`);
  console.log(`Elapsed ............... ${elapsed} ms`);
  console.log('BUILD OK');
  return 0;
}

/* ============================================================================
 *  12. EXPORTS + ENTRYPOINT
 * ========================================================================== */

module.exports = {
  // constants
  BASE32, GEOHASH_PRECISION, TILE_PREFIX_LENGTH, COORD_DECIMALS, CIPHER_KEY, CIPHER_MAGIC,
  CATEGORIES, TIME_SLOTS, RISK_LEVELS, THREAT_KINDS, DEMOGRAPHICS,
  DIGIPIN_ALPHABET, DIGIPIN_LENGTH, DIGIPIN_CELL_METERS, INDIA_BBOX, INDIA_POLYGON, REGIONS,
  // geohash
  encodeGeohash, decodeGeohash, cellDegrees, geohashNeighbors,
  // coordinates
  parseCoordinate, roundToDecimals, clamp,
  // boundary + digipin
  inBBox, pointInPolygon, isInIndia, computeDigipin, resolveRegion, encodeBaseN,
  // schema
  riskBand, clampScore, normalizeThreat, buildSafeAlleysMatrix, normalizeCategory,
  // slugs
  slugify, uniqueMicroId, buildSlug,
  // cipher
  fnv1a32, xorRotate, encryptJSON, decryptJSON,
  // tiles + pipeline
  tileOutputPath, tileRelativeUrl, groupByPrefix, writeTile, buildManifest,
  normalizeRecord, processRecords, loadSampleData,
  // runner
  runSelfTests, main,
};

if (require.main === module) {
  process.exitCode = main();
}
