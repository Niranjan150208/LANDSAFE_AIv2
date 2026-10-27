// Tests the data sync with mocked API responses (no internet needed): node test-sync.js
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { makeSync } = require('./datasync');
const ZONES = require('./zones.json');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE zone_metrics(zone TEXT PRIMARY KEY, rain_mm_24h REAL, ndvi REAL, insar_mm REAL, slope_deg REAL, elevation_m REAL, past_slides INTEGER, updated TEXT)');

const nowH = new Date().toISOString().slice(0, 13);
const times = []; for (let i = -30; i <= 17; i++) times.push(new Date(Date.now() + i * 3600e3).toISOString().slice(0, 13) + ':00');
const mock = async (url) => {
  const ok = (body, text) => ({ ok: true, status: 200, json: async () => body, text: async () => text });
  if (url.includes('/forecast')) {
    if (url.includes('soil_moisture_3_to_9cm') && globalThis.__reject) return { ok: false, status: 400, json: async () => ({}) };
    const soilVar = url.includes('soil_moisture_3_to_9cm') ? 'soil_moisture_3_to_9cm' : 'soil_moisture_0_to_1cm';
    return ok(ZONES.map(() => ({ hourly: { time: times, precipitation: times.map(() => 1), [soilVar]: times.map(() => 0.25) } })));
  }
  if (url.includes('/elevation')) return ok({ elevation: ZONES.flatMap(() => [1000, 1010, 990, 1020, 980]) });
  if (url.includes('data.nasa.gov')) {
    const z = ZONES[0];
    return ok(null, `event_id,event_title,latitude,longitude\n1,"near, ${z.name}\nmultiline",${z.lat + 0.05},${z.lon}\n2,far away,10.0,10.0\n3,"also near",${z.lat},${z.lon + 0.1}\n`);
  }
  throw new Error('unexpected url ' + url);
};

(async () => {
  const s = makeSync(db, mock);
  await s.runAll(true);
  const rows = db.prepare('SELECT * FROM zone_metrics').all();
  assert.equal(rows.length, 16);
  const r = rows.find((x) => x.zone === ZONES[0].name);
  assert.equal(Math.round(r.rain_mm_24h), 24, '24 h of 1 mm/h = 24 mm');
  assert.equal(Math.round(r.soil_pct), 50, '0.25 m3/m3 -> 50 %');
  assert.equal(r.elevation_m, 1000);
  assert.ok(r.slope_deg >= 3 && r.slope_deg <= 60);
  assert.equal(r.past_slides, 2, 'two catalog events within 30 km, one far away ignored');
  assert.equal(rows.find((x) => x.zone === ZONES[1].name).past_slides, 0);
  assert.ok(s.statusRows().every((x) => x.ok === 1), JSON.stringify(s.statusRows()));

  globalThis.__reject = true;           // provider rejects the deeper soil variable -> falls back to 0-1 cm
  await s.weather();
  assert.ok(s.statusRows().find((x) => x.source === 'open-meteo-weather').message.includes('0_to_1cm'));

  const bad = makeSync(db, async () => { throw new Error('offline'); });  // offline keeps old values and reports failure
  await bad.weather();
  assert.equal(bad.statusRows().find((x) => x.source === 'open-meteo-weather').ok, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM zone_metrics').get().c, 16);
  console.log('Sync tests passed');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
