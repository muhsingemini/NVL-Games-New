const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

let ready = false;

async function ensureTable() {
  if (ready) return;
  await db.execute(`CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY,
    data TEXT,
    updated_at INTEGER DEFAULT 0
  )`);
  ready = true;
}

// --- Birleştirme yardımcilari ---------------------------------------------

// Iki listeyi bir "anahtar" (username ya da id) uzerinden birlestirir.
// Ayni anahtarda gelen (incoming) kazanir -> profil/bakiye guncellemeleri uygulanir.
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

// Sohbet haritalari: { tournamentId: [mesaj, ...] } gibi nesneleri birlestirir.
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

// Eski kayitli durum ile yeni geleni birlestir.
function mergeState(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming;

  const merged = Object.assign({}, existing, incoming);

  // Ekleme yapilan listeler: kimse digerinin uzerine yazmasin
  merged.users = mergeByKey(existing.users, incoming.users, byUsername);
  merged.teams = mergeByKey(existing.teams, incoming.teams, byId);
  merged.tournaments = mergeByKey(existing.tournaments, incoming.tournaments, byId);
  merged.announcements = mergeByKey(existing.announcements, incoming.announcements, byId);
  merged.payments = mergeByKey(existing.payments, incoming.payments, byId);
  merged.forumMessages = mergeByKey(existing.forumMessages, incoming.forumMessages, byIdOrJson);
  merged.dmMessages = mergeByKey(existing.dmMessages, incoming.dmMessages, byIdOrJson);

  // Sohbet haritalari
  merged.tournamentChats = mergeChatMap(existing.tournamentChats, incoming.tournamentChats);
  merged.teamChats = mergeChatMap(existing.teamChats, incoming.teamChats);

  return merged;
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
    await ensureTable();

    // Siteyi acan tarayici verileri BURADAN okur
    if (req.method === 'GET') {
      const result = await db.execute('SELECT data FROM app_state WHERE id = 1');
      if (result.rows.length === 0 || !result.rows[0].data) {
        return res.status(200).json({ state: null });
      }
      return res.status(200).json({ state: JSON.parse(result.rows[0].data) });
    }

    // Kayit / degisiklik olunca veriler BURAYA yazilir (eskiyle birlestirilerek)
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const incoming = body.state;

      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'state eksik' });
      }

      // Once mevcut durumu oku
      const current = await db.execute('SELECT data FROM app_state WHERE id = 1');
      let existing = null;
      if (current.rows.length > 0 && current.rows[0].data) {
        try { existing = JSON.parse(current.rows[0].data); } catch (e) { existing = null; }
      }

      // Eskiyle birlestir -> kimse digerinin kaydini silmesin
      const finalState = mergeState(existing, incoming);
      finalState.updatedAt = Date.now();

      await db.execute({
        sql: `INSERT INTO app_state (id, data, updated_at)
              VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at`,
        args: [JSON.stringify(finalState), finalState.updatedAt]
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('API hatasi:', err);
    return res.status(500).json({ error: err.message });
  }
};
