import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL tanımlı değil.' });
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nvl_state (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO nvl_state (id, payload)
      VALUES ('main', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);

    if (req.method === 'GET') {
      const result = await pool.query('SELECT payload, updated_at FROM nvl_state WHERE id = $1', ['main']);
      const row = result.rows[0] || { payload: {}, updated_at: new Date().toISOString() };
      return res.status(200).json({ state: row.payload, updatedAt: row.updated_at });
    }

    if (req.method === 'POST') {
      const incoming = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const nextState = incoming?.state ?? incoming ?? {};

      const updated = await pool.query(
        `UPDATE nvl_state
         SET payload = $1::jsonb, updated_at = NOW()
         WHERE id = 'main'
         RETURNING payload, updated_at`,
        [JSON.stringify(nextState)]
      );

      return res.status(200).json({
        ok: true,
        state: updated.rows[0].payload,
        updatedAt: updated.rows[0].updated_at
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Neon state error:', err);
    return res.status(500).json({ error: 'Veritabanı işlemi başarısız.' });
  }
}