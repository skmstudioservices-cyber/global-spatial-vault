# Global Spatial Vault

Custom **Data Ingestion & Spatial Partitioning Plugin** for hyper-local geospatial data —
drones, localized utilities, and precise pothole tracking — with a zero-cost,
scraper-resistant static delivery model.

The engine is a single dependency-free CommonJS module, `spatial-vault.js`, plus a
browser-side mirror, `spatial-vault.client.js`.

```text
node spatial-vault.js     # ingest -> geohash -> DIGIPIN -> encrypt -> tile -> verify
```

---

## What it does (the six requirements)

| # | Capability | Implementation |
|---|------------|----------------|
| 1 | **Micro-precision ingestion** | 8-decimal coordinate parsing (~1 mm) → 13-char Geohash (~4.7 mm cell, sub-centimeter). |
| 2 | **Regional mapping & fallbacks** | Point-in-polygon India boundary check → 10-char India Post DIGIPIN-style code; global country/ZIP fallbacks over land, forest, and ocean. |
| 3 | **Multi-niche unified grid** | One spatial grid holds `potholes`, `safe-alleys`, `ev-chargers`, `transit-stops`; a multi-tiered **Safe Alleys Matrix** with demographics, threat classes, and 7 color-coded time slots. |
| 4 | **Anti-scraping moat** | Records grouped by first 5 Geohash chars into nested dirs (`/dist/tiles/t/d/r/1/w/tdr1w.dat`), each a Base64 + XOR rotation-cipher stream keyed by `73` with a checksum envelope. |
| 5 | **Directory profile slugs** | `/[category]/[country]/[city]/[name-uniquemicroid]` per record, plus a `profile.json` per slug directory. |
| 6 | **Browser decryption utility** | `spatial-vault.client.js` mirrors the cipher, fetches `.dat` over HTTPS, and caches to IndexedDB for 5–50 km offline use. |

---

## Quick start

```bash
cd C:\global-spatial-vault
node spatial-vault.js
```

Output (written to `dist/`):

```text
dist/
├── tiles/                        # encrypted, nested by 5-char Geohash prefix
│   ├── t/d/r/1/w/tdr1w.dat
│   ├── t/t/n/f/t/ttnft.dat
│   └── ...
├── profiles/                     # human-readable slug directories
│   └── potholes/india/bengaluru/koramangala-80ft-rd-pit-<microid>/profile.json
├── manifest.dat                  # encrypted master index of all tiles
├── slugs.json                    # plaintext route index (non-sensitive)
└── verify.txt                    # human-readable build + self-test report
```

The build prints a summary and exits `0` only when every tile decrypts back
intact and all self-tests pass. It emits **zero warnings**.

---

## Precision math

- **8 decimal places** = `1e-8` degrees ≈ **1.1 mm** at the equator.
- **13-char Geohash** = 65 bits (33 longitude + 32 latitude) ≈ **4.67 mm × 4.67 mm**
  cell — well under the 1 cm micro-local target (12 chars ≈ 3.7 cm).

Both are asserted in the self-test suite (`13-char cell < 1 cm (4.67 mm x 4.67 mm)`).

---

## DIGIPIN (India Post digital address)

`computeDigipin(lat, lng)` returns a **10-character alphanumeric** code for points
inside India, derived from a **4 m × 4 m** grid over the national bounding box and
encoded in a 32-glyph ambiguity-free alphabet (`0, 1, I, O` removed), with a checksum
character. It returns `null` outside India.

> **Accuracy note.** India Post publishes DIGIPIN as an open grid, but the
> authoritative grid parameters are not distributed in a machine-readable form.
> This module ships a **deterministic reference encoder** that honors the published
> observable contract (10 alphanumeric chars, 4 m × 4 m cells, lat/lng derived).
> To use the official algorithm, override the resolver:
>
> ```js
> const vault = require('./spatial-vault');
> vault.REGIONS.IN.digipin.compute = officialDigipinResolver; // your authenticated impl
> vault.REGIONS.IN.digipin.contains = officialIndiaBoundaryCheck;
> ```
>
> The reference India boundary is a simplified mainland polygon
> (`INDIA_POLYGON`); inject the authoritative GeoJSON to include islands.

---

## Safe Alleys Matrix schema

```jsonc
{
  "category": "safe-alleys",
  "safeAlleysMatrix": {
    "demographics": { "male": 88, "female": 72, "kids": 81, "family": 84 },
    "threats": {
      "robbery":       { "level": 1, "incidents": 2, "lastReported": "2025-11-02" },
      "theft":         { "level": 2, "incidents": 7, "lastReported": "2026-01-14" },
      "animalAttacks": { "level": 0, "incidents": 0, "lastReported": null },
      "misbehave":     { "level": 2, "incidents": 5, "lastReported": "2025-12-30" }
    },
    "timeSlots": {
      "dawn": { "score": 18 }, "morning": { "score": 22 }, "noon": { "score": 30 },
      "afternoon": { "score": 26 }, "evening": { "score": 48 }, "night": { "score": 66 },
      "midnight": { "score": 74 }
    }
  }
}
```

The pipeline normalizes this into 7 color-coded slots using a risk palette:

| Band | Score | Color | Hex |
|------|-------|-------|-----|
| Low | 0–20 | green | `#22c55e` |
| Moderate | 21–40 | yellow | `#eab308` |
| Elevated | 41–60 | amber | `#f97316` |
| High | 61–80 | orange | `#ef4444` |
| Critical | 81–100 | red | `#b91c1c` |

---

## Cipher (anti-scraping moat)

Each flat asset is produced by `encryptJSON(obj)`:

1. Serialize the payload to UTF-8 JSON.
2. Prefix a 10-byte envelope: magic `SVV1` + version + flags + **FNV-1a 32** checksum.
3. Apply a symmetric **XOR rotation-cipher stream** seeded by key `73`; the key
   rotates via `k = (k * 33 + 17) mod 2^32` per byte.
4. Base64-encode the result.

The envelope is encrypted too, so the `.dat` files contain **no plaintext magic**.
`decryptJSON` verifies magic, version, and checksum — a scraper grabbing files gets
opaque blobs, and any tampering or wrong key is rejected.

---

## Browser decryption (Astro / Leaflet PWA)

`spatial-vault.client.js` is a zero-dependency mirror of the cipher with an
IndexedDB tile cache. The frontend never runs a backend query — it pulls static
`.dat` files from a CDN and decrypts them locally.

```html
<script type="module">
  import { openDB, loadTilesAround } from './spatial-vault.client.js';

  const db = await openDB('spatial-vault', 'tiles');
  // 25 km offline radius around Bengaluru; first hit fetches + decrypts,
  // subsequent hits are served entirely from IndexedDB.
  const records = await loadTilesAround(db, 12.9716, 77.5946, 25000, {
    // `baseUrl` is the dist root that CONTAINS tiles/ and manifest.dat.
    baseUrl: 'https://cdn.example.com/dist',
    prefixLen: 5,
  });
  records.forEach((r) => L.marker([r.lat, r.lng]).addTo(map));
</script>
```

**Asset root.** `baseUrl` points at the folder holding `tiles/` and
`manifest.dat` (the `dist/` directory), so a tile resolves to
`{baseUrl}/tiles/t/d/r/1/w/tdr1w.dat`. Serving the repo root makes it `/dist`;
serving `dist/` itself makes it `''`.

**Missing cells are normal.** A radius spans many 5-char cells while only a few
hold data, so empty cells return `404` and are **skipped, never fatal**. When
`manifest.dat` is reachable the loader requests only tiles that exist, so 25–50 km
costs a handful of requests instead of hundreds.

Non-module fallback: `window.SpatialVault.loadTilesAround(...)`.

### Leaflet risk layer

`spatial-vault.map.js` renders color-coded threat pins for the current time slot:

```js
SpatialVaultMap.attachLayer(map, { baseUrl: '/dist', radiusMeters: 25000 });
```

See `frontend/demo.html` for a runnable example (it auto-detects the asset root).

### Verifying the browser path without a browser

`browser-sim.test.js` serves the repo over real HTTP and exercises the exact
client path — manifest decrypt → candidate narrowing → tile fetch → record decode:

```bash
node browser-sim.test.js
```


---

## Extending

- **New categories** — add to `CATEGORIES`; unknown categories fall through to `other`.
- **New countries/regions** — add entries to `REGIONS` (ISO codes, postal labels,
  optional DIGIPIN-style resolver).
- **Official DIGIPIN** — override `REGIONS.IN.digipin.compute` / `.contains`.
- **Tile granularity** — `TILE_PREFIX_LENGTH` (5 chars ≈ 4.9 km cells) controls the
  offline-fetch tradeoff; raise it for finer cells, lower it for coarser.

The full public API is exported from `spatial-vault.js` (geohash, boundary/DIGIPIN,
matrix, cipher, tiles, pipeline, and the build runner).
