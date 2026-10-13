/**
 * ============================================================================
 *  spatial-vault.map.js
 *  Leaflet.js interactive map layer for Spatial Vault decrypted tiles.
 * ----------------------------------------------------------------------------
 *  Renders 🔴 / 🟠 / 🟡 / 🟢 threat-score indicator pins straight onto a
 *  Leaflet map by:
 *
 *    1. resolving the current daily time slot from the user's local clock,
 *    2. loading + decrypting the tiles covering the viewport via
 *       spatial-vault.client.js (IndexedDB cache-first, then HTTPS fetch),
 *    3. color-coding each record from its Safe Alleys Matrix slot risk
 *       (or a neutral category color for non-alley records).
 *
 *  LOAD ORDER (it is browser-only and assumes globals `L` and `SpatialVault`):
 *
 *    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
 *    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
 *    <script src="/spatial-vault.client.js"></script>
 *    <script src="/spatial-vault.map.js"></script>
 *
 *  USAGE:
 *
 *    const map = L.map('map').setView([12.9716, 77.5946], 13);
 *    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
 *      attribution: '&copy; OpenStreetMap contributors'
 *    }).addTo(map);
 *
 *    SpatialVaultMap.attachLayer(map, {
 *      baseUrl: 'https://cdn.example.com/dist',  // dist root holding tiles/ + manifest.dat
 *      radiusMeters: 5000,
 *    });
 * ============================================================================
 */
(function attach(root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Time-slot resolution (mirrors the 7 slots in spatial-vault.js)
   * ------------------------------------------------------------------ */
  var TIME_SLOTS = ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night', 'midnight'];

  function currentTimeSlot(date) {
    var h = (date || new Date()).getHours();
    if (h >= 5 && h < 7) return 'dawn';        // 05:00-06:59
    if (h >= 7 && h < 12) return 'morning';    // 07:00-11:59
    if (h >= 12 && h < 14) return 'noon';      // 12:00-13:59
    if (h >= 14 && h < 17) return 'afternoon'; // 14:00-16:59
    if (h >= 17 && h < 19) return 'evening';   // 17:00-18:59
    if (h >= 19 && h < 23) return 'night';     // 19:00-22:59
    return 'midnight';                          // 23:00-04:59
  }

  /* ------------------------------------------------------------------ *
   *  Color / icon mapping
   * ------------------------------------------------------------------ */
  var CATEGORY_COLORS = {
    'potholes': '#ef4444',
    'safe-alleys': '#22c55e',
    'ev-chargers': '#3b82f6',
    'transit-stops': '#8b5cf6',
    'other': '#64748b',
  };
  var CATEGORY_EMOJI = {
    'potholes': '\u{1F573}\uFE0F',   // hole
    'safe-alleys': '\u{1F6E1}\uFE0F', // shield
    'ev-chargers': '\u26A1',          // lightning
    'transit-stops': '\u{1F68F}',     // bus stop
    'other': '\u{1F4CD}',             // pin
  };
  // Canonical risk hex -> indicator emoji (matches server RISK_LEVELS palette).
  var HEX_EMOJI = {
    '#22c55e': '\u{1F7E2}', // green circle
    '#eab308': '\u{1F7E1}', // yellow circle
    '#f97316': '\u{1F7E0}', // orange circle
    '#ef4444': '\u{1F534}', // red circle
    '#b91c1c': '\u{1F534}', // red circle (critical)
  };

  /** Pick the display color for a record at a given time slot. */
  function riskColorFor(record, slot) {
    if (record && record.safeAlleysMatrix) {
      var slots = record.safeAlleysMatrix.timeSlots || [];
      for (var i = 0; i < slots.length; i++) {
        if (slots[i].slot === slot) return slots[i].hex;
      }
    }
    return CATEGORY_COLORS[record.category] || CATEGORY_COLORS.other;
  }

  function emojiFor(record, color) {
    if (record && record.safeAlleysMatrix) return HEX_EMOJI[color] || '\u{1F534}';
    return CATEGORY_EMOJI[record.category] || CATEGORY_EMOJI.other;
  }

  function radiusFor(record) {
    if (record.safeAlleysMatrix && record.safeAlleysMatrix.overallRisk) {
      return 6 + record.safeAlleysMatrix.overallRisk.score / 16; // 6..12 px
    }
    return 7;
  }

  /* ------------------------------------------------------------------ *
   *  Popup builder
   * ------------------------------------------------------------------ */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function popupHtml(record, slot) {
    var head = '<b>' + esc(record.name) + '</b> <span style="color:#64748b">[' + esc(record.category) + ']</span><br>' +
      esc(record.city || '') + ', ' + esc(record.country || '');
    var body = '';

    if (record.safeAlleysMatrix) {
      var m = record.safeAlleysMatrix;
      var slotData = null;
      for (var i = 0; i < m.timeSlots.length; i++) {
        if (m.timeSlots[i].slot === slot) { slotData = m.timeSlots[i]; break; }
      }
      if (slotData) {
        body += '<br>Risk now (' + esc(slot) + '): ' +
          '<span style="color:' + slotData.hex + ';font-weight:600">\u25CF ' +
          esc(slotData.riskLevel) + ' (' + slotData.score + '/100)</span>';
      }
      var d = m.demographics || {};
      body += '<br>Safety \u{1F464}' + esc(d.male) + ' \u{1F467}' + esc(d.female) +
        ' \u{1F476}' + esc(d.kids) + ' \u{1F46A}' + esc(d.family);
      var t = m.threats || {};
      body += '<br>Threats: robbery ' + esc(t.robbery && t.robbery.level) +
        ' \u00B7 theft ' + esc(t.theft && t.theft.level) +
        ' \u00B7 animal ' + esc(t.animalAttacks && t.animalAttacks.level) +
        ' \u00B7 misbehave ' + esc(t.misbehave && t.misbehave.level);
    }

    body += '<br>DIGIPIN: ' + (record.digipin ? '<b>' + esc(record.digipin) + '</b>' : '\u2014') +
      '<br>Geohash: <code>' + esc(record.precision && record.precision.geohash) + '</code>' +
      ' \u00B7 tile <code>' + esc(record.tilePrefix) + '</code>';
    return head + body;
  }

  function makeMarker(record, color, opts, slot) {
    var latlng = [record.lat, record.lng];
    if (opts.markerStyle === 'emoji') {
      var html = '<span style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))">' +
        emojiFor(record, color) + '</span>';
      return L.marker(latlng, {
        icon: L.divIcon({ className: 'sv-pin', html: html, iconSize: [24, 24], iconAnchor: [12, 12] }),
      }).bindPopup(popupHtml(record, slot));
    }
    return L.circleMarker(latlng, {
      radius: radiusFor(record),
      fillColor: color,
      color: '#0f172a',
      weight: 1.5,
      fillOpacity: 0.85,
    }).bindPopup(popupHtml(record, slot));
  }

  /* ------------------------------------------------------------------ *
   *  Legend control
   * ------------------------------------------------------------------ */
  var LEGEND_BANDS = [
    { hex: '#22c55e', label: 'Low (0-20)' },
    { hex: '#eab308', label: 'Moderate (21-40)' },
    { hex: '#f97316', label: 'Elevated (41-60)' },
    { hex: '#ef4444', label: 'High (61-80)' },
    { hex: '#b91c1c', label: 'Critical (81-100)' },
  ];

  function addLegend(map, slot) {
    var items = LEGEND_BANDS.map(function (b) {
      return '<div><i style="background:' + b.hex + '"></i>' + esc(b.label) + '</div>';
    }).join('');
    var control = L.control({ position: 'bottomright' });
    control.onAdd = function () {
      var el = L.DomUtil.create('div', 'sv-legend');
      el.innerHTML =
        '<div class="sv-legend-title">Risk now \u00B7 ' + esc(slot) + '</div>' + items +
        '<div class="sv-legend-css">' +
        '.sv-legend{background:rgba(255,255,255,.92);padding:8px 10px;border-radius:6px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25)}' +
        '.sv-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}' +
        '.sv-legend-title{font-weight:700;margin-bottom:4px}' +
        '</div>';
      return el;
    };
    control.addTo(map);
    return control;
  }

  /* ------------------------------------------------------------------ *
   *  Main entrypoint
   * ------------------------------------------------------------------ */

  /**
   * Render an array of ALREADY-DECODED records onto a Leaflet map.
   * Returns { layer, slot, bounds, legend } so callers can clear and re-render
   * (e.g. a dashboard when the operator changes the time slot).
   *
   * opts: { markerStyle, timeSlot, fitBounds, legend }
   */
  function renderRecords(map, records, opts) {
    opts = opts || {};
    if (!map) throw new Error('renderRecords: Leaflet map instance is required');

    var slot = opts.timeSlot || currentTimeSlot();
    var layer = L.layerGroup();
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      var color = riskColorFor(record, slot);
      layer.addLayer(makeMarker(record, color, opts, slot));
    }
    layer.addTo(map);

    var bounds = null;
    if (records.length) {
      bounds = layer.getBounds().pad(0.2);
      if (opts.fitBounds !== false) map.fitBounds(bounds, { padding: [30, 30] });
    }
    var legend = opts.legend === false ? null : addLegend(map, slot);

    return { layer: layer, slot: slot, bounds: bounds, legend: legend };
  }

  /**
   * Attach the Spatial Vault layer to an existing Leaflet map.
   * Returns { records, layer, slot, bounds, legend, db } once tiles are loaded.
   *
   * opts:
   *   baseUrl      string   dist root holding tiles/ + manifest.dat (default '')
   *   radiusMeters number   offline fetch radius                 (default 5000)
   *   prefixLen    number   tile prefix length                   (default 5)
   *   center       L.LatLng optional center; defaults to map.getCenter()
   *   markerStyle  'circle' | 'emoji'                           (default 'circle')
   *   timeSlot     string   force a slot instead of local clock
   *   dbName/store string   IndexedDB names
   *   fitBounds    bool     auto-fit viewport to loaded records  (default true)
   */
  async function attachLayer(map, opts) {
    opts = opts || {};
    if (!map) throw new Error('attachLayer: Leaflet map instance is required');
    var sv = root.SpatialVault;
    if (!sv) throw new Error('attachLayer: load spatial-vault.client.js before spatial-vault.map.js');

    var db = await sv.openDB(opts.dbName || 'spatial-vault', opts.storeName || 'tiles');
    var center = opts.center || map.getCenter();
    var records = await sv.loadTilesAround(db, center.lat, center.lng, opts.radiusMeters || 5000, {
      baseUrl: opts.baseUrl == null ? '' : opts.baseUrl, // dist root holding tiles/ + manifest.dat
      prefixLen: opts.prefixLen || 5,
      key: opts.key,
      store: opts.storeName || 'tiles',
      useManifest: opts.useManifest,
      manifestUrl: opts.manifestUrl,
      onProgress: opts.onProgress,
    });

    var rendered = renderRecords(map, records, opts);
    return {
      records: records,
      layer: rendered.layer,
      slot: rendered.slot,
      bounds: rendered.bounds,
      legend: rendered.legend,
      db: db,
    };
  }

  root.SpatialVaultMap = {
    TIME_SLOTS: TIME_SLOTS,
    currentTimeSlot: currentTimeSlot,
    riskColorFor: riskColorFor,
    renderRecords: renderRecords,
    attachLayer: attachLayer,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SpatialVaultMap;
})(typeof window !== 'undefined' ? window : globalThis);
