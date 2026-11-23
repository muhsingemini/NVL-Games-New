const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

let ready = false;

async function ensureTables() {
  if (ready) return;

  // Ana veri (sitenin kullandigi): her sey tek satirda JSON olarak
  await db.execute(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY,
    data TEXT,
    updated_at INTEGER DEFAULT 0
  )`);

  // Okunabilir aynalar (sadece Turso'da bakip anlaman icin)
  await db.execute(`CREATE TABLE IF NOT EXISTS members (
    username TEXT PRIMARY KEY,
    email TEXT,
    pubg_name TEXT,
    pubg_id TEXT,
    role TEXT,
    balance REAL,
    is_admin INTEGER
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT,
    tag TEXT,
    owner TEXT,
    invite_code TEXT,
    member_count INTEGER
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY,
    title TEXT,
    mode TEXT,
    map TEXT,
    creator TEXT,
    entry_fee REAL,
    prize_pool TEXT,
    date TEXT,
    time TEXT,
    status TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    username TEXT,
    method TEXT,
    amount REAL,
    status TEXT,
    created_at TEXT
  )`);

  ready = true;
}

// --- Birlestirme yardimcilari ---------------------------------------------

function mergeByKey(existing, incoming, keyFn) {
  const map = new Map();
  (Array.isArray(existing) ? existing : []).forEach(function (item) {
    const k = keyFn(item);
    if (k !== null && k !== undefined && k !== '') map.set(String(k), item);
  });
  (Array.isArray(incoming) ? incoming : []).forEach(function (item) {
    const k = keyFn(item);
    if (k !== null && k !== undefined && k !== '') map.set(String(k), item);
  });
  return Array.from(map.values());
}

function mergeChatMap(existing, incoming) {
  const out = Object.assign({}, existing || {});
  const inc = incoming || {};
  Object.keys(inc).forEach(function (key) {
    out[key] = mergeByKey(out[key], inc[key], function (m) {
      return m && m.id !== undefined && m.id !== null ? m.id : JSON.stringify(m);
    });
  });
  return out;
}

function byId(x) { return x ? x.id : null; }
function byUsername(u) { return u ? u.username : null; }
function byIdOrJson(m) {
  return m && m.id !== undefined && m.id !== null ? m.id : JSON.stringify(m);
}

function mergeState(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming;
  const merged = Object.assign({}, existing, incoming);
  merged.users = mergeByKey(existing.users, incoming.users, byUsername);
  merged.teams = mergeByKey(existing.teams, incoming.teams, byId);
  merged.tournaments = mergeByKey(existing.tournaments, incoming.tournaments, byId);
  merged.announcements = mergeByKey(existing.announcements, incoming.announcements, byId);
  merged.payments = mergeByKey(existing.payments, incoming.payments, byId);
  merged.forumMessages = mergeByKey(existing.forumMessages, incoming.forumMessages, byIdOrJson);
  merged.dmMessages = mergeByKey(existing.dmMessages, incoming.dmMessages, byIdOrJson);
  merged.tournamentChats = mergeChatMap(existing.tournamentChats, incoming.tournamentChats);
  merged.teamChats = mergeChatMap(existing.teamChats, incoming.teamChats);
  return merged;
}

// --- Okunabilir tablolari blob'tan yeniden olustur -------------------------

async function rebuildMirrors(state) {
  const stmts = [];

  stmts.push({ sql: 'DELETE FROM members', args: [] });
  (state.users || []).forEach(function (u) {
    if (!u || !u.username) return;
    stmts.push({
      sql: 'INSERT INTO members (username, email, pubg_name, pubg_id, role, balance, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        String(u.username),
        String(u.email || ''),
        String(u.pubgName || ''),
        String(u.pubgId || ''),
        String(u.role || ''),
        Number(u.balance || 0),
        u.isAdmin ? 1 : 0
      ]
    });
  });

  stmts.push({ sql: 'DELETE FROM teams', args: [] });
  (state.teams || []).forEach(function (t) {
    if (!t || !t.id) return;
    stmts.push({
      sql: 'INSERT INTO teams (id, name, tag, owner, invite_code, member_count) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        String(t.id),
        String(t.name || ''),
        String(t.tag || ''),
        String(t.ownerUsername || ''),
        String(t.inviteCode || ''),
        Array.isArray(t.mainPlayers) ? t.mainPlayers.length : 0
      ]
    });
  });

  stmts.push({ sql: 'DELETE FROM tournaments', args: [] });
  (state.tournaments || []).forEach(function (tr) {
    if (!tr || !tr.id) return;
    stmts.push({
      sql: 'INSERT INTO tournaments (id, title, mode, map, creator, entry_fee, prize_pool, date, time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        String(tr.id),
        String(tr.title || ''),
        String(tr.mode || ''),
        String(tr.map || ''),
        String(tr.creator || ''),
        Number(tr.entryFee || 0),
        String(tr.prizePool || ''),
        String(tr.date || ''),
        String(tr.time || ''),
        String(tr.status || '')
      ]
    });
  });

  stmts.push({ sql: 'DELETE FROM payments', args: [] });
  (state.payments || []).forEach(function (p) {
    if (!p || !p.id) return;
    stmts.push({
      sql: 'INSERT INTO payments (id, username, method, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        String(p.id),
        String(p.username || ''),
        String(p.method || ''),
        Number(p.amount || 0),
        String(p.status || ''),
        String(p.createdAt || '')
      ]
    });
  });

  await db.batch(stmts, 'write');
}

// ---------------------------------------------------------------------------

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    await ensureTables();

    if (req.method === 'GET') {
      const result = await db.execute('SELECT data FROM app_state WHERE id = 1');
      if (result.rows.length === 0 || !result.rows[0].data) {
        return res.status(200).json({ state: null });
      }
      return res.status(200).json({ state: JSON.parse(result.rows[0].data) });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const incoming = body.state;

      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'state eksik' });
      }

      const current = await db.execute('SELECT data FROM app_state WHERE id = 1');
      let existing = null;
      if (current.rows.length > 0 && current.rows[0].data) {
        try { existing = JSON.parse(current.rows[0].data); } catch (e) { existing = null; }
      }

      const finalState = mergeState(existing, incoming);
      finalState.updatedAt = Date.now();

      // 1) Ana veriyi yaz (site bunu kullanir)
      await db.execute({
        sql: `INSERT INTO app_state (id, data, updated_at)
              VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at`,
        args: [JSON.stringify(finalState), finalState.updatedAt]
      });

      // 2) Okunabilir tablolari guncelle (bu hata verse bile ana kayit bozulmaz)
      try {
        await rebuildMirrors(finalState);
      } catch (mirrorErr) {
        console.error('Ayna tablo hatasi:', mirrorErr);
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('API hatasi:', err);
    return res.status(500).json({ error: err.message });
  }
};
