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

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    await ensureTable();

    // Siteyi açan tarayıcı verileri BURADAN okur
    if (req.method === 'GET') {
      const result = await db.execute('SELECT data FROM app_state WHERE id = 1');
      if (result.rows.length === 0 || !result.rows[0].data) {
        return res.status(200).json({ state: null });
      }
      return res.status(200).json({ state: JSON.parse(result.rows[0].data) });
    }

    // Kayıt / değişiklik olunca veriler BURAYA yazılır
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const state = body.state;

      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'state eksik' });
      }

      await db.execute({
        sql: `INSERT INTO app_state (id, data, updated_at)
              VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                data = excluded.data,
                updated_at = excluded.updated_at`,
        args: [JSON.stringify(state), Number(state.updatedAt || Date.now())]
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('API hatasi:', err);
    return res.status(500).json({ error: err.message });
  }
};
