'use strict';
/* LANDSAFE AI backend. Zero npm dependencies. Needs Node >= 22.13 (built-in node:sqlite). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { makeSync } = require('./datasync');
const scoring = require('./scoring');
const ZONES = require('./zones.json');

// ---- tiny .env loader -------------------------------------------------------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = +process.env.PORT || 3000;
// DEMO_MODE (default on): seeds the 1-click demo accounts + sample reports. Set DEMO_MODE=0 for a real deployment.
const DEMO_MODE = process.env.DEMO_MODE !== '0';
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET not set: logins will reset on restart. Set it in .env');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'landsafe.db');
const PUBLIC = path.join(__dirname, 'public');

// ---- database ---------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, name TEXT NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Public', phone TEXT DEFAULT '', zone INTEGER DEFAULT 0,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, zone INTEGER NOT NULL, hazard TEXT NOT NULL,
  username TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS checkins(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, zone INTEGER NOT NULL,
  kind TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, zone INTEGER NOT NULL, level INTEGER NOT NULL,
  message TEXT NOT NULL, by_user TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sms_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_phone TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS zone_metrics(
  zone TEXT PRIMARY KEY, rain_mm_24h REAL, soil_pct REAL, ndvi REAL, insar_mm REAL, slope_deg REAL,
  elevation_m REAL, past_slides INTEGER, risk_score INTEGER, risk_level TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// Safe migrations
try { db.exec('ALTER TABLE zone_metrics ADD COLUMN soil_pct REAL'); } catch {}
try { db.exec('ALTER TABLE zone_metrics ADD COLUMN risk_score INTEGER'); } catch {}
try { db.exec('ALTER TABLE zone_metrics ADD COLUMN risk_level TEXT'); } catch {}

const sync = makeSync(db);

// ---- passwords + tokens (Node crypto only) ----------------------------------
const hashPw = (pw) => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const checkPw = (pw, stored) => {
  const [s, h] = String(stored).split(':'); if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (p) => { const body = b64({ ...p, exp: Date.now() + 12 * 3600e3 }); return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); };
const verifyTok = (t) => {
  try {
    const [body, sig] = String(t).split('.');
    const ok = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};

// Demo accounts exist ONLY in DEMO_MODE. With DEMO_MODE=0, create the first admin from ADMIN_USER / ADMIN_PASS.
if (DEMO_MODE) {
  for (const [u, pw, role, name] of [['admin', 'admin123', 'Admin', 'Administrator'], ['officer', 'officer123', 'Field Officer', 'Field Officer'], ['public', 'public123', 'Public', 'Resident']]) {
    if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(u)) db.prepare('INSERT INTO users(username,name,pass,role,zone) VALUES(?,?,?,?,2)').run(u, name, hashPw(pw), role);
    else db.prepare('UPDATE users SET pass=?, role=? WHERE username=?').run(hashPw(pw), role, u);
  }
} else if (process.env.ADMIN_USER && process.env.ADMIN_PASS && process.env.ADMIN_PASS.length >= 8) {
  const au = process.env.ADMIN_USER.toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(au)) db.prepare("INSERT INTO users(username,name,pass,role,zone) VALUES(?,?,?,'Admin',0)").run(au, 'Administrator', hashPw(process.env.ADMIN_PASS));
} else if (!db.prepare("SELECT 1 FROM users WHERE role='Admin'").get()) console.warn('[warn] DEMO_MODE=0 and no Admin exists. Set ADMIN_USER and ADMIN_PASS (8+ chars) in .env');

// Seed sample reports once (demo only) so the officer queue is not empty
if (DEMO_MODE && !db.prepare('SELECT 1 FROM reports').get()) {
  db.prepare('INSERT INTO reports(zone,hazard,username) VALUES(8,?,?)').run('Rockfall', 'resident_gtk');
  db.prepare('INSERT INTO reports(zone,hazard,username) VALUES(5,?,?)').run('Water seepage', 'resident_cpj');
}

// ---- SMS (Twilio if configured, otherwise dry-run) ---------------------------
async function sendSms(to, message) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from } = process.env;
  let status = 'dry-run (set TWILIO_* in .env to send real SMS)';
  if (sid && tok && from) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: message }),
      });
      status = r.ok ? 'sent' : 'provider error ' + r.status;
    } catch (e) { status = 'network error: ' + e.message; }
  }
  db.prepare('INSERT INTO sms_log(to_phone,message,status) VALUES(?,?,?)').run(to, message, status);
  console.log(`[sms] ${to}: ${status}`);
  return status;
}

// ---- helpers ------------------------------------------------------------------
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); };
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) { no(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error('bad json')); } });
});
const fmtTime = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pro = (u) => u && (u.role === 'Admin' || u.role === 'Field Officer');
const publicUser = (u) => ({ n: u.username, r: u.role, name: u.name, zone: u.zone, phone: u.phone });

// Rate limiting with client IP extraction (supporting x-forwarded-for) and automatic TTL pruning
const attempts = new Map();
const tooMany = (ip) => {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now);
  attempts.set(ip, a);
  return a.length > 10;
};
// Clean up expired rate-limit IP records every minute to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of attempts.entries()) {
    const valid = timestamps.filter((t) => now - t < 60000);
    if (valid.length === 0) attempts.delete(ip);
    else attempts.set(ip, valid);
  }
}, 60000).unref();

const rep = (r) => ({ id: 'LR-' + (1000 + r.id), dbid: r.id, zi: r.zone, hz: r.hazard, u: r.username, t: fmtTime(r.created), st: r.status });
const chk = (c) => ({ id: c.id, t: fmtTime(c.created), u: c.username, zi: c.zone, k: c.kind, d: c.handled ? 1 : 0 });

// ---- Server-Side Explainable Risk Scoring Engine -----------------------------
function getZoneRisk(zoneNameOrIdx) {
  let zIdx = -1, zConfig = null;
  if (Number.isInteger(+zoneNameOrIdx) && +zoneNameOrIdx >= 0 && +zoneNameOrIdx < ZONES.length) {
    zIdx = +zoneNameOrIdx;
    zConfig = ZONES[zIdx];
  } else {
    zIdx = ZONES.findIndex((z) => z.name.toLowerCase() === String(zoneNameOrIdx).trim().toLowerCase());
    if (zIdx >= 0) zConfig = ZONES[zIdx];
  }
  if (!zConfig) return null;

  const m = db.prepare('SELECT * FROM zone_metrics WHERE zone=?').get(zConfig.name) || {};
  const verifiedCount = db.prepare("SELECT COUNT(*) AS c FROM reports WHERE zone=? AND status='Verified'").get(zIdx)?.c || 0;

  const evaluated = scoring.calculateRisk({
    rain: m.rain_mm_24h != null ? m.rain_mm_24h : 25,
    soil: m.soil_pct != null ? m.soil_pct : 45,
    insar: m.insar_mm != null ? m.insar_mm : (m.slope_deg ? (m.slope_deg / 40) * 1.5 : 1.5),
    ndvi: m.ndvi != null ? m.ndvi : 0.65,
    sl: m.slope_deg != null ? m.slope_deg : 28,
    h: m.past_slides != null ? m.past_slides : 2,
    verifiedReports: verifiedCount,
  });

  // Data quality: which inputs are measured/live and which fall back to modelled defaults
  const live = { rain: m.rain_mm_24h != null, soil: m.soil_pct != null, slope: m.slope_deg != null, history: m.past_slides != null, insar: m.insar_mm != null, ndvi: m.ndvi != null };
  const ageMin = m.updated ? Math.round((Date.now() - new Date(String(m.updated).replace(' ', 'T') + 'Z').getTime()) / 60000) : null;
  const stale = ageMin == null || ageMin > 180;
  const quality = {
    ...scoring.inputConfidence(live, stale),
    live_inputs: Object.keys(live).filter((k) => live[k]),
    default_inputs: Object.keys(live).filter((k) => !live[k]),
    data_age_min: ageMin, stale,
  };

  return {
    zone: zConfig.name,
    zone_id: zIdx,
    state: zConfig.state,
    lat: zConfig.lat,
    lon: zConfig.lon,
    risk_score: evaluated.score,
    level: evaluated.level,
    level_idx: evaluated.levelIdx,
    color: evaluated.color,
    symbol: evaluated.symbol,
    advice: evaluated.advice,
    thresholds: evaluated.thresholds,
    breakdown: evaluated.breakdown,
    reasons: evaluated.reasons,
    verified_reports_count: verifiedCount,
    data_quality: quality,
  };
}

// 15-minute alert cooldown per zone to prevent spamming residents
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// ---- Early-warning engine: score -> store -> history -> automatic alert -----------
db.exec(`CREATE TABLE IF NOT EXISTS risk_history(id INTEGER PRIMARY KEY AUTOINCREMENT, zone TEXT NOT NULL, score INTEGER NOT NULL, level TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_risk_history ON risk_history(zone, id);`);
const AUTO_COOLDOWN_MIN = +process.env.AUTO_COOLDOWN_MIN || 180;
const autoOn = () => process.env.AUTO_ALERTS !== '0';

async function evaluateZone(idx) {
  const r = getZoneRisk(idx); if (!r) return null;
  db.prepare('INSERT INTO zone_metrics(zone,risk_score,risk_level) VALUES(?,?,?) ON CONFLICT(zone) DO UPDATE SET risk_score=excluded.risk_score, risk_level=excluded.risk_level').run(r.zone, r.risk_score, r.level);
  const last = db.prepare("SELECT score, created >= datetime('now','-60 minutes') AS fresh FROM risk_history WHERE zone=? ORDER BY id DESC LIMIT 1").get(r.zone);
  if (!last || last.score !== r.risk_score || !last.fresh) db.prepare('INSERT INTO risk_history(zone,score,level) VALUES(?,?,?)').run(r.zone, r.risk_score, r.level);

  // Automatic alert: HIGH/CRITICAL, once per cooldown window per zone (an escalation to a higher level still fires)
  if (autoOn() && r.level_idx >= 2) {
    const dup = db.prepare("SELECT 1 FROM alerts WHERE zone=? AND level>=? AND created >= datetime('now', ?) LIMIT 1").get(idx, r.level_idx, `-${AUTO_COOLDOWN_MIN} minutes`);
    if (!dup) {
      const msg = `LANDSAFE ${r.level}: ${r.zone}, ${r.state}. Risk ${r.risk_score}/100. ${r.reasons[0]}. ${r.advice}`.slice(0, 300);
      db.prepare('INSERT INTO alerts(zone,level,message,by_user) VALUES(?,?,?,?)').run(idx, r.level_idx, msg, 'auto-engine');
      const subs = db.prepare("SELECT phone FROM users WHERE zone=? AND phone<>''").all(idx);
      for (const s of subs) await sendSms(s.phone, msg);
      return { ...r, auto_alert: { raised: true, texted: subs.length } };
    }
  }
  return r;
}
async function evaluateAll() {
  const out = [];
  for (let i = 0; i < ZONES.length; i++) out.push(await evaluateZone(i));
  db.prepare("DELETE FROM risk_history WHERE created < datetime('now','-7 days')").run();
  return out;
}

// ---- routes -------------------------------------------------------------------
async function api(req, res, url) {
  const xf = req.headers['x-forwarded-for'];
  const ip = (xf ? String(xf).split(',').pop().trim() : req.socket.remoteAddress) || '127.0.0.1';
  const m = req.method, p = url.pathname;
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claims = verifyTok(tok);
  const me = claims ? db.prepare('SELECT * FROM users WHERE username=?').get(claims.u) : null;
  const need = (cond = true) => { if (!me) { json(res, 401, { error: 'Sign in required' }); return false; } if (!cond) { json(res, 403, { error: 'Not allowed for your role' }); return false; } return true; };

  if (p === '/api/health') return json(res, 200, { ok: true, sms: !!process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'dry-run', model: 'explainable-empirical-v1', demo: DEMO_MODE, auto_alerts: autoOn(), zones: ZONES.length });

  if (p === '/api/auth/login' && m === 'POST') {
    if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts, wait a minute' });
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || '').toLowerCase());
    if (!u || !checkPw(String(b.password || ''), u.pass)) return json(res, 401, { error: 'Wrong username or password.' });
    return json(res, 200, { token: sign({ u: u.username }), user: publicUser(u) });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts, wait a minute' });
    const b = await readBody(req);
    const name = String(b.name || '').trim(), u = String(b.username || '').trim().toLowerCase(), pw = String(b.password || ''), ph = String(b.phone || '').trim();
    if (name.length < 2) return json(res, 400, { error: 'Enter your name.' });
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return json(res, 400, { error: 'Username: 3 to 20 letters, numbers or underscores.' });
    if (pw.length < 8) return json(res, 400, { error: 'Password needs at least 8 characters.' });
    if (ph && !/^\+\d{10,15}$/.test(ph)) return json(res, 400, { error: 'Phone must start with + and the country code.' });
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(u)) return json(res, 409, { error: 'That username is taken.' });
    const zone = Math.max(0, Math.min(ZONES.length - 1, +b.zone || 0));
    db.prepare('INSERT INTO users(username,name,pass,role,phone,zone) VALUES(?,?,?,?,?,?)').run(u, name.slice(0, 60), hashPw(pw), 'Public', ph, zone);
    const nu = db.prepare('SELECT * FROM users WHERE username=?').get(u);
    return json(res, 201, { token: sign({ u }), user: publicUser(nu) });
  }

  // Password change endpoint
  if (p === '/api/auth/password' && (m === 'POST' || m === 'PATCH')) {
    if (!need()) return;
    const b = await readBody(req);
    const oldPw = String(b.old_password || ''), newPw = String(b.new_password || '');
    if (!checkPw(oldPw, me.pass)) return json(res, 401, { error: 'Current password is incorrect.' });
    if (newPw.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters.' });
    db.prepare('UPDATE users SET pass=? WHERE username=?').run(hashPw(newPw), me.username);
    return json(res, 200, { ok: true, message: 'Password updated successfully.' });
  }

  if (p === '/api/me' && m === 'GET') { if (!need()) return; return json(res, 200, { user: publicUser(me) }); }

  // admin: list users and promote to Field Officer
  if (p === '/api/users' && m === 'GET') {
    if (!need(me && me.role === 'Admin')) return;
    return json(res, 200, db.prepare('SELECT username,name,role,zone,phone,created FROM users ORDER BY created').all());
  }
  let mm;
  if ((mm = p.match(/^\/api\/users\/([a-z0-9_]+)\/role$/)) && m === 'PATCH') {
    if (!need(me && me.role === 'Admin')) return;
    const b = await readBody(req);
    if (!['Public', 'Field Officer', 'Admin'].includes(b.role)) return json(res, 400, { error: 'Bad role' });
    db.prepare('UPDATE users SET role=? WHERE username=?').run(b.role, mm[1]);
    return json(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/users\/([a-z0-9_]+)$/)) && m === 'DELETE') {
    if (!need(me && me.role === 'Admin')) return;
    if (['admin', 'officer', 'public', me.username].includes(mm[1])) return json(res, 400, { error: 'Cannot remove this account' });
    db.prepare('DELETE FROM users WHERE username=?').run(mm[1]);
    return json(res, 200, { ok: true });
  }

  // citizen reports
  if (p === '/api/reports' && m === 'GET') {
    if (!need()) return;
    const rows = pro(me) ? db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 200').all()
      : db.prepare('SELECT * FROM reports WHERE username=? ORDER BY id DESC LIMIT 100').all(me.username);
    return json(res, 200, rows.map(rep));
  }
  if (p === '/api/reports' && m === 'POST') {
    if (!need()) return;
    const b = await readBody(req);
    const hz = String(b.hazard || '').slice(0, 60), zone = Number.isInteger(+b.zone) ? +b.zone : me.zone;
    if (!hz) return json(res, 400, { error: 'Choose a hazard' });
    if (zone < 0 || zone >= ZONES.length) return json(res, 400, { error: 'Unknown zone' });
    if (!pro(me) && db.prepare("SELECT COUNT(*) c FROM reports WHERE username=? AND created >= datetime('now','-1 hour')").get(me.username).c >= 5)
      return json(res, 429, { error: 'Report limit reached (5 per hour). Officers are reviewing your earlier reports.' });
    const r = db.prepare('INSERT INTO reports(zone,hazard,username) VALUES(?,?,?)').run(zone, hz, me.username);
    return json(res, 201, rep(db.prepare('SELECT * FROM reports WHERE id=?').get(r.lastInsertRowid)));
  }
  if ((mm = p.match(/^\/api\/reports\/(\d+)$/)) && m === 'PATCH') {
    if (!need(pro(me))) return;
    const b = await readBody(req);
    if (!['Verified', 'Dismissed'].includes(b.status)) return json(res, 400, { error: 'Bad status' });
    db.prepare('UPDATE reports SET status=? WHERE id=?').run(b.status, +mm[1]);
    const updatedRep = rep(db.prepare('SELECT * FROM reports WHERE id=?').get(+mm[1]));
    
    // Community loop: recalculate zone risk automatically on verification
    const zoneRisk = await evaluateZone(updatedRep.zi);
    return json(res, 200, { ...updatedRep, updated_zone_risk: zoneRisk });
  }

  // check-ins ("I'm safe" / "I need help")
  if (p === '/api/checkins' && m === 'GET') {
    if (!need(pro(me))) return;
    return json(res, 200, db.prepare('SELECT * FROM checkins ORDER BY id DESC LIMIT 50').all().map(chk));
  }
  if (p === '/api/checkins' && m === 'POST') {
    if (!need()) return;
    const b = await readBody(req);
    if (!['safe', 'help'].includes(b.kind)) return json(res, 400, { error: 'Bad kind' });
    const r = db.prepare('INSERT INTO checkins(username,zone,kind) VALUES(?,?,?)').run(me.username, me.zone, b.kind);
    return json(res, 201, chk(db.prepare('SELECT * FROM checkins WHERE id=?').get(r.lastInsertRowid)));
  }
  if ((mm = p.match(/^\/api\/checkins\/(\d+)\/handled$/)) && m === 'PATCH') {
    if (!need(pro(me))) return;
    db.prepare('UPDATE checkins SET handled=1 WHERE id=?').run(+mm[1]);
    return json(res, 200, { ok: true });
  }

  // alerts: officers raise an alert; it is stored and texted to registered residents of that zone
  if (p === '/api/alerts' && m === 'GET') {
    if (!need()) return;
    return json(res, 200, db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 50').all()
      .map((a) => ({ id: a.id, zi: a.zone, lv: a.level, m: a.message, t: fmtTime(a.created), auto: a.by_user === 'auto-engine' })));
  }
  if (p === '/api/alerts' && m === 'POST') {
    if (!need(pro(me))) return;
    const b = await readBody(req);
    const zone = +b.zone, level = +b.level, msg = String(b.message || '').slice(0, 300);
    if (!Number.isInteger(zone) || ![0, 1, 2, 3].includes(level) || !msg) return json(res, 400, { error: 'zone, level (0-3) and message required' });
    
    // Alert Cooldown: enforce 15-min cooldown per zone for high/critical alerts unless forced by Admin
    const force = b.force === true && me.role === 'Admin';
    if (!force && level >= 2) {
      const lastAlert = db.prepare('SELECT created FROM alerts WHERE zone=? AND level>=2 ORDER BY id DESC LIMIT 1').get(zone);
      if (lastAlert) {
        const elapsed = Date.now() - new Date(lastAlert.created.replace(' ', 'T') + 'Z').getTime();
        if (elapsed < ALERT_COOLDOWN_MS) {
          const waitMin = Math.ceil((ALERT_COOLDOWN_MS - elapsed) / 60000);
          return json(res, 429, { error: `Alert cooldown active for zone ${zone}. Please wait ${waitMin} min before sending again.` });
        }
      }
    }

    db.prepare('INSERT INTO alerts(zone,level,message,by_user) VALUES(?,?,?,?)').run(zone, level, msg, me.username);
    const subs = level >= 2 ? db.prepare("SELECT phone FROM users WHERE zone=? AND phone<>''").all(zone) : [];
    const results = [];
    for (const s of subs) results.push(await sendSms(s.phone, msg));
    return json(res, 201, { ok: true, texted: subs.length, results });
  }

  // compatibility with the console's "SMS backend URL" box (Restricted to Admin for security)
  if (p === '/send' && m === 'POST') {
    if (!need(me && me.role === 'Admin')) return;
    const b = await readBody(req);
    if (!/^\+\d{10,15}$/.test(String(b.to || '')) || !b.message) return json(res, 400, { error: 'to (+countrycode) and message required' });
    const status = await sendSms(b.to, String(b.message).slice(0, 300));
    return json(res, status.startsWith('provider') || status.startsWith('network') ? 502 : 200, { status });
  }
  if (p === '/api/sms' && m === 'GET') {
    if (!need(me && me.role === 'Admin')) return;
    return json(res, 200, db.prepare('SELECT * FROM sms_log ORDER BY id DESC LIMIT 50').all());
  }

  // Server-side Risk Evaluation Endpoint
  if (p === '/api/risk' && m === 'GET') {
    const list = ZONES.map((_, i) => getZoneRisk(i)).filter(Boolean);
    return json(res, 200, list);
  }
  if ((mm = p.match(/^\/api\/risk\/(\d+)$/)) && m === 'GET') {
    const r = getZoneRisk(+mm[1]);
    if (!r) return json(res, 404, { error: 'Zone not found' });
    return json(res, 200, r);
  }

  if ((mm = p.match(/^\/api\/risk\/(\d+)\/history$/)) && m === 'GET') {
    const z = ZONES[+mm[1]]; if (!z) return json(res, 404, { error: 'Zone not found' });
    return json(res, 200, db.prepare('SELECT score,level,created FROM risk_history WHERE zone=? ORDER BY id DESC LIMIT 200').all(z.name).reverse());
  }

  // Model Explainability & NASA GLC Backtest Results
  if (p === '/api/backtest' && m === 'GET') {
    return json(res, 200, scoring.runBacktest());
  }

  // Real Sensor Ingestion Endpoint (ESP32 LoRa / Gateway Telemetry)
  if (p === '/api/telemetry' && m === 'POST') {
    // Sensor nodes authenticate with the shared device key (x-api-key = TELEMETRY_KEY); staff may also post with a login.
    const k = String(req.headers['x-api-key'] || ''), want = process.env.TELEMETRY_KEY || '';
    const keyOk = want && k.length === want.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want));
    if (!keyOk && !pro(me)) return json(res, me ? 403 : 401, { error: 'Telemetry needs the device key (x-api-key) or a Field Officer/Admin login' });
    const b = await readBody(req);
    const zIdx = +b.zone_id;
    if (!Number.isInteger(zIdx) || zIdx < 0 || zIdx >= ZONES.length) return json(res, 400, { error: 'Valid zone_id (0-15) required' });
    const zoneName = ZONES[zIdx].name;
    const fin = (v) => (v == null || v === '' || !isFinite(+v) ? null : +v);
    const soil = fin(b.soil_pct) == null ? null : Math.max(0, Math.min(100, fin(b.soil_pct)));
    const rain = fin(b.rain_mm) == null ? null : Math.max(0, Math.min(1000, fin(b.rain_mm)));
    if (soil == null && rain == null) return json(res, 400, { error: 'soil_pct and/or rain_mm (24 h total) required' });
    
    db.prepare(`INSERT INTO zone_metrics(zone, soil_pct, rain_mm_24h, updated) VALUES(?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(zone) DO UPDATE SET
        soil_pct=COALESCE(excluded.soil_pct, soil_pct),
        rain_mm_24h=COALESCE(excluded.rain_mm_24h, rain_mm_24h),
        updated=CURRENT_TIMESTAMP`).run(zoneName, soil, rain);

    const evaluated = await evaluateZone(zIdx);
    return json(res, 200, { ok: true, node: b.node_id || 'node', zone: zoneName, risk: evaluated });
  }

  if (p === '/api/datasources' && m === 'GET') return json(res, 200, sync.statusRows());
  if (p === '/api/sync' && m === 'POST') {
    if (!need(me && me.role === 'Admin')) return;
    await sync.runAll(true);
    return json(res, 200, sync.statusRows());
  }

  // satellite / GIS feed the console can load (Sources page -> Feed URL). Admin uploads rows, everyone's console reads them.
  if ((p === '/api/zone_metrics.json' || p === '/zone_metrics.json') && m === 'GET')
    return json(res, 200, db.prepare('SELECT zone,rain_mm_24h,soil_pct,ndvi,insar_mm,slope_deg,elevation_m,past_slides,risk_score,risk_level FROM zone_metrics').all());
  if (p === '/api/zone_metrics' && m === 'PUT') {
    if (!need(me && me.role === 'Admin')) return;
    const rows = await readBody(req);
    if (!Array.isArray(rows)) return json(res, 400, { error: 'Send a JSON array of zone rows' });
    const st = db.prepare(`INSERT INTO zone_metrics(zone,rain_mm_24h,soil_pct,ndvi,insar_mm,slope_deg,elevation_m,past_slides,updated) VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(zone) DO UPDATE SET rain_mm_24h=COALESCE(excluded.rain_mm_24h,rain_mm_24h),soil_pct=COALESCE(excluded.soil_pct,soil_pct),ndvi=COALESCE(excluded.ndvi,ndvi),insar_mm=COALESCE(excluded.insar_mm,insar_mm),slope_deg=COALESCE(excluded.slope_deg,slope_deg),elevation_m=COALESCE(excluded.elevation_m,elevation_m),past_slides=COALESCE(excluded.past_slides,past_slides),updated=CURRENT_TIMESTAMP`);
    const n = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
    for (const r of rows) if (r.zone) st.run(String(r.zone), n(r.rain_mm_24h), n(r.soil_pct), n(r.ndvi), n(r.insar_mm), n(r.slope_deg), n(r.elevation_m), n(r.past_slides));
    await evaluateAll();
    return json(res, 200, { ok: true, rows: rows.length });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---- static files + server ----------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/scoring.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, 'scoring.js'))); }  // same model in browser and server
    if (url.pathname.startsWith('/api/') || url.pathname === '/send' || url.pathname === '/zone_metrics.json') return await api(req, res, url);
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    let f = path.normalize(path.join(PUBLIC, rel === '/' ? 'index.html' : rel));
    if (f !== PUBLIC && !f.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (path.extname(rel)) { res.writeHead(404); return res.end(); }   // missing asset: 404, not the HTML shell
      f = path.join(PUBLIC, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.message === 'bad json' ? 400 : e.message === 'too large' ? 413 : 500, { error: e.message === 'bad json' ? 'Invalid JSON' : e.message === 'too large' ? 'Request too large' : 'Server error' });
  }
});
if (require.main === module) server.listen(PORT, () => {
  console.log(`LANDSAFE AI running on http://localhost:${PORT}  (SMS: ${process.env.TWILIO_ACCOUNT_SID ? 'Twilio' : 'dry-run'})`);
  if (!process.env.NO_SYNC) {
    console.log('Fetching live data (Open-Meteo, NASA landslide catalog) in the background...');
    sync.runAll().then(() => evaluateAll()).catch((e) => console.error('[sync]', e.message));
    setInterval(() => sync.weather().then(() => evaluateAll()).catch((e) => console.error('[engine]', e.message)), 30 * 60 * 1000).unref();
  }
});
module.exports = server;
