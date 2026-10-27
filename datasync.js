'use strict';
/* Pulls free, keyless public data into the zone_metrics table:
 *  - Open-Meteo forecast API : rainfall (last 24 h) and modelled soil moisture
 *  - Open-Meteo elevation API : Copernicus DEM elevation, slope from 5 points around each zone
 *  - NASA Global Landslide Catalog (CSV): count of past rainfall-triggered slides near each zone
 * Nothing here is simulated. If a source is unreachable the old value is kept and the status says why.
 */
const ZONES = require('./zones.json');

const OM = 'https://api.open-meteo.com/v1';
const GLC_URL = 'https://data.nasa.gov/api/views/dd9e-wu2v/rows.csv?accessType=DOWNLOAD';
const GLC_RADIUS_KM = 30;
const GLC_MAX_AGE_DAYS = 30;

const hav = (a, b, c, d) => { const r = (x) => (x * Math.PI) / 180, s = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(s)); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function parseCsv(t) {
  const rows = []; let r = [], c = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { r.push(c); c = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; r.push(c); c = ''; if (r.length > 1 || r[0] !== '') rows.push(r); r = []; }
    else c += ch;
  }
  r.push(c); if (r.length > 1 || r[0] !== '') rows.push(r);
  return rows;
}

function makeSync(db, fetchFn = fetch) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_status(source TEXT PRIMARY KEY, ok INTEGER, message TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
  try { db.exec('ALTER TABLE zone_metrics ADD COLUMN soil_pct REAL'); } catch {}

  const status = (source, ok, message) => {
    db.prepare('INSERT INTO sync_status(source,ok,message,updated) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source) DO UPDATE SET ok=excluded.ok,message=excluded.message,updated=CURRENT_TIMESTAMP').run(source, ok ? 1 : 0, message);
    console.log(`[sync] ${source}: ${ok ? 'ok' : 'FAILED'} - ${message}`);
  };
  const upsert = db.prepare(`INSERT INTO zone_metrics(zone,rain_mm_24h,soil_pct,slope_deg,elevation_m,past_slides,updated)
    VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(zone) DO UPDATE SET
      rain_mm_24h=COALESCE(excluded.rain_mm_24h,rain_mm_24h), soil_pct=COALESCE(excluded.soil_pct,soil_pct),
      slope_deg=COALESCE(excluded.slope_deg,slope_deg), elevation_m=COALESCE(excluded.elevation_m,elevation_m),
      past_slides=COALESCE(excluded.past_slides,past_slides), updated=CURRENT_TIMESTAMP`);

  async function getJson(url, ms = 20000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetchFn(url, { signal: ctl.signal }); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { http: r.status }); return await r.json(); }
    finally { clearTimeout(t); }
  }

  // ---- rainfall + soil moisture (Open-Meteo) --------------------------------
  async function weather() {
    const lat = ZONES.map((z) => z.lat).join(','), lon = ZONES.map((z) => z.lon).join(',');
    const build = (soil) => `${OM}/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,${soil}&past_days=1&forecast_days=1&timezone=UTC`;
    let soilVar = 'soil_moisture_3_to_9cm', j;
    try {
      try { j = await getJson(build(soilVar)); }
      catch (e) { if (e.http !== 400) throw e; soilVar = 'soil_moisture_0_to_1cm'; j = await getJson(build(soilVar)); }
      const arr = Array.isArray(j) ? j : [j];
      if (arr.length !== ZONES.length) throw new Error('unexpected response size ' + arr.length);
      let n = 0;
      arr.forEach((o, i) => {
        const h = o.hourly; if (!h || !h.time) return;
        const now = new Date().toISOString().slice(0, 13);            // "YYYY-MM-DDTHH"
        let k = h.time.findIndex((t) => t.slice(0, 13) > now); k = k < 0 ? h.time.length : k; // first hour after now
        const last = Math.max(0, k - 1);
        const rain = h.precipitation.slice(Math.max(0, last - 23), last + 1).reduce((a, v) => a + (v || 0), 0);
        const vwc = h[soilVar][last];
        const soil = vwc == null ? null : clamp((vwc / 0.5) * 100, 5, 95);   // 0.5 m3/m3 treated as saturated
        upsert.run(ZONES[i].name, Math.round(rain * 10) / 10, soil == null ? null : Math.round(soil * 10) / 10, null, null, null);
        n++;
      });
      status('open-meteo-weather', true, `${n} zones updated (rain 24 h + ${soilVar})`);
    } catch (e) { status('open-meteo-weather', false, e.message); }
  }

  // ---- elevation + slope (Open-Meteo / Copernicus DEM) -----------------------
  async function terrain() {
    const d = 0.005, offs = [[0, 0], [0, d], [0, -d], [d, 0], [-d, 0]], pts = [];
    ZONES.forEach((z) => offs.forEach((o) => pts.push([z.lat + o[0], z.lon + o[1]])));
    try {
      const j = await getJson(`${OM}/elevation?latitude=${pts.map((p) => p[0].toFixed(4)).join(',')}&longitude=${pts.map((p) => p[1].toFixed(4)).join(',')}`);
      const e = j.elevation; if (!e || e.length !== pts.length) throw new Error('unexpected response');
      ZONES.forEach((z, i) => {
        const b = i * 5, m = 2 * d * 111320;
        const dy = (e[b + 3] - e[b + 4]) / m, dx = (e[b + 1] - e[b + 2]) / (m * Math.cos((z.lat * Math.PI) / 180));
        const slope = clamp(Math.round((Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI), 3, 60);
        upsert.run(z.name, null, null, slope, Math.round(e[b]), null);
      });
      status('copernicus-dem', true, `${ZONES.length} zones updated (elevation, slope)`);
    } catch (e) { status('copernicus-dem', false, e.message); }
  }

  // ---- past landslides (NASA Global Landslide Catalog) -----------------------
  async function landslides(force = false) {
    const row = db.prepare("SELECT value FROM meta WHERE key='glc_synced'").get();
    if (!force && row && Date.now() - +row.value < GLC_MAX_AGE_DAYS * 864e5) return;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
      let text; try { const r = await fetchFn(GLC_URL, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); text = await r.text(); } finally { clearTimeout(t); }
      const rows = parseCsv(text); const head = rows.shift().map((h) => h.trim().toLowerCase());
      const iLat = head.findIndex((h) => /^lat/.test(h)), iLon = head.findIndex((h) => /^(lon|lng)/.test(h));
      if (iLat < 0 || iLon < 0) throw new Error('latitude/longitude columns not found in catalog');
      const ev = rows.map((r) => [parseFloat(r[iLat]), parseFloat(r[iLon])]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
      ZONES.forEach((z) => upsert.run(z.name, null, null, null, null, ev.filter((p) => hav(z.lat, z.lon, p[0], p[1]) <= GLC_RADIUS_KM).length));
      db.prepare("INSERT INTO meta(key,value) VALUES('glc_synced',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()));
      status('nasa-glc', true, `${ev.length} catalog events; counted within ${GLC_RADIUS_KM} km of each zone`);
    } catch (e) { status('nasa-glc', false, e.message); }
  }

  const runAll = async (forceGlc = false) => { await terrain(); await weather(); await landslides(forceGlc); };
  const statusRows = () => db.prepare('SELECT source,ok,message,updated FROM sync_status ORDER BY source').all();
  return { weather, terrain, landslides, runAll, statusRows };
}

module.exports = { makeSync, parseCsv };
