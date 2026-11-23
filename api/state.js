const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;

  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'player',
      balance REAL DEFAULT 0,
      in_game_id TEXT,
      highest_rank TEXT,
      bio TEXT,
      avatar_url TEXT,
      banner_url TEXT,
      instagram TEXT,
      tiktok TEXT,
      custom_slug TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tag TEXT NOT NULL,
      captain_id INTEGER,
      logo_url TEXT,
      tournaments_played INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER,
      user_id INTEGER,
      in_game_name TEXT,
      in_game_id TEXT,
      role TEXT DEFAULT 'member'
    )`,
    `CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      organizer_id INTEGER,
      entry_fee REAL DEFAULT 0,
      prize_pool TEXT,
      max_slots INTEGER DEFAULT 25,
      status TEXT DEFAULT 'open',
      has_room INTEGER DEFAULT 0,
      room_id TEXT,
      room_pass TEXT,
      description TEXT,
      rules TEXT,
      chat_locked INTEGER DEFAULT 0,
      start_time TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS forum_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      avatar_url TEXT,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      sender_or_holder TEXT,
      card_number TEXT,
      card_expiry TEXT,
      card_cvv TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      badge TEXT DEFAULT 'DUYURU',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      site_logo TEXT,
      site_favicon TEXT,
      whatsapp_url TEXT DEFAULT 'https://chat.whatsapp.com/'
    )`
  ];

  for (let i = 0; i < ddl.length; i++) {
    await db.execute(ddl[i]);
  }

  await db.execute({
    sql: 'INSERT OR IGNORE INTO site_settings (id, whatsapp_url) VALUES (?, ?)',
    args: [1, 'https://chat.whatsapp.com/']
  });

  await db.execute({
    sql: 'INSERT OR IGNORE INTO users (username, email, password, role, balance) VALUES (?, ?, ?, ?, ?)',
    args: ['admin', 'admin@nvlgames.com.tr', 'admin123', 'admin', 0]
  });

  tablesReady = true;
}

async function handleGet(res) {
  await ensureTables();

  const [
    usersRes,
    teamsRes,
    membersRes,
    tournamentsRes,
    forumRes,
    paymentsRes,
    annRes,
    settingsRes
  ] = await Promise.all([
    db.execute('SELECT * FROM users ORDER BY id ASC'),
    db.execute('SELECT * FROM teams ORDER BY id ASC'),
    db.execute('SELECT * FROM team_members ORDER BY id ASC'),
    db.execute('SELECT * FROM tournaments ORDER BY id DESC'),
    db.execute('SELECT * FROM forum_messages ORDER BY id ASC LIMIT 200'),
    db.execute('SELECT * FROM payments ORDER BY id DESC'),
    db.execute('SELECT * FROM announcements ORDER BY id DESC'),
    db.execute('SELECT * FROM site_settings WHERE id = 1')
  ]);

  const users = usersRes.rows.map(function (u) {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      password: u.password,
      role: u.role,
      balance: Number(u.balance || 0),
      inGameId: u.in_game_id,
      highestRank: u.highest_rank,
      bio: u.bio,
      avatar: u.avatar_url,
      banner: u.banner_url,
      instagram: u.instagram,
      tiktok: u.tiktok,
      customSlug: u.custom_slug
    };
  });

  const teams = teamsRes.rows.map(function (t) {
    const teamMembers = membersRes.rows
      .filter(function (m) {
        return Number(m.team_id) === Number(t.id);
      })
      .map(function (m) {
        return {
          nick: m.in_game_name,
          id: m.in_game_id,
          role: m.role
        };
      });

    return {
      id: t.id,
      name: t.name,
      tag: t.tag,
      captainId: t.captain_id,
      logo: t.logo_url,
      tournamentsPlayed: Number(t.tournaments_played || 0),
      members: teamMembers
    };
  });

  const forumMessages = forumRes.rows.map(function (f) {
    return {
      id: f.id,
      username: f.username,
      avatar: f.avatar_url,
      text: f.content,
      time: f.created_at
    };
  });

  const payments = paymentsRes.rows.map(function (p) {
    return {
      id: p.id,
      username: p.username,
      method: p.method,
      amount: Number(p.amount || 0),
      holder: p.sender_or_holder,
      cardNumber: p.card_number,
      expiry: p.card_expiry,
      cvv: p.card_cvv,
      status: p.status,
      createdAt: p.created_at
    };
  });

  return res.status(200).json({
    users: users,
    teams: teams,
    tournaments: tournamentsRes.rows,
    forumMessages: forumMessages,
    payments: payments,
    announcements: annRes.rows,
    settings: settingsRes.rows[0] || {}
  });
}

async function handlePost(req, res) {
  await ensureTables();

  const state = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const statements = [];

  if (Array.isArray(state.users)) {
    for (let i = 0; i < state.users.length; i++) {
      const u = state.users[i];
      if (!u || !u.username) continue;
      statements.push({
        sql: `INSERT INTO users (username, email, password, role, balance, in_game_id, highest_rank, bio, avatar_url, banner_url, instagram, tiktok, custom_slug)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(username) DO UPDATE SET
                email = excluded.email,
                password = excluded.password,
                role = excluded.role,
                balance = excluded.balance,
                in_game_id = excluded.in_game_id,
                highest_rank = excluded.highest_rank,
                bio = excluded.bio,
                avatar_url = excluded.avatar_url,
                banner_url = excluded.banner_url,
                instagram = excluded.instagram,
                tiktok = excluded.tiktok,
                custom_slug = excluded.custom_slug`,
        args: [
          u.username,
          u.email || '',
          u.password || '',
          u.role || 'player',
          Number(u.balance || 0),
          u.inGameId || u.in_game_id || '',
          u.highestRank || u.highest_rank || '',
          u.bio || '',
          u.avatar || u.avatar_url || '',
          u.banner || u.banner_url || '',
          u.instagram || '',
          u.tiktok || '',
          u.customSlug || u.custom_slug || ''
        ]
      });
    }
  }

  if (Array.isArray(state.teams)) {
    for (let i = 0; i < state.teams.length; i++) {
      const t = state.teams[i];
      if (!t || !t.name) continue;
      const existing = await db.execute({
        sql: 'SELECT id FROM teams WHERE name = ? AND tag = ? LIMIT 1',
        args: [t.name, t.tag || '']
      });

      let teamId;
      if (existing.rows.length > 0) {
        teamId = existing.rows[0].id;
        statements.push({
          sql: 'UPDATE teams SET logo_url = ?, tournaments_played = ? WHERE id = ?',
          args: [t.logo || t.logo_url || '', Number(t.tournamentsPlayed || 0), teamId]
        });
      } else {
        const ins = await db.execute({
          sql: 'INSERT INTO teams (name, tag, logo_url, tournaments_played) VALUES (?, ?, ?, ?)',
          args: [t.name, t.tag || '', t.logo || t.logo_url || '', Number(t.tournamentsPlayed || 0)]
        });
        teamId = ins.lastInsertRowid;
      }

      if (teamId && Array.isArray(t.members)) {
        statements.push({
          sql: 'DELETE FROM team_members WHERE team_id = ?',
          args: [teamId]
        });
        for (let j = 0; j < t.members.length; j++) {
          const m = t.members[j];
          if (m && (m.nick || m.id)) {
            statements.push({
              sql: 'INSERT INTO team_members (team_id, in_game_name, in_game_id, role) VALUES (?, ?, ?, ?)',
              args: [teamId, m.nick || '', String(m.id || ''), m.role || 'member']
            });
          }
        }
      }
    }
  }

  if (Array.isArray(state.payments)) {
    for (let i = 0; i < state.payments.length; i++) {
      const p = state.payments[i];
      if (!p || !p.username) continue;
      const exPay = await db.execute({
        sql: 'SELECT id FROM payments WHERE username = ? AND amount = ? AND sender_or_holder = ? LIMIT 1',
        args: [p.username, Number(p.amount || 0), p.holder || p.sender || '']
      });
      if (exPay.rows.length > 0) {
        statements.push({
          sql: 'UPDATE payments SET status = ? WHERE id = ?',
          args: [p.status || 'pending', exPay.rows[0].id]
        });
      } else {
        statements.push({
          sql: 'INSERT INTO payments (username, method, amount, sender_or_holder, card_number, card_expiry, card_cvv, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          args: [
            p.username,
            p.method || 'iban',
            Number(p.amount || 0),
            p.holder || p.sender || '',
            p.cardNumber || '',
            p.expiry || '',
            p.cvv || '',
            p.status || 'pending'
          ]
        });
      }
    }
  }

  const forumList = state.forumMessages || state.forum || [];
  if (Array.isArray(forumList)) {
    for (let i = 0; i < forumList.length; i++) {
      const m = forumList[i];
      const text = m ? (m.text || m.content || '') : '';
      if (!m || !m.username || !text) continue;
      statements.push({
        sql: 'INSERT INTO forum_messages (username, avatar_url, content) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM forum_messages WHERE username = ? AND content = ?)',
        args: [m.username, m.avatar || '', text, m.username, text]
      });
    }
  }

  if (Array.isArray(state.announcements)) {
    for (let i = 0; i < state.announcements.length; i++) {
      const a = state.announcements[i];
      if (!a || !a.title) continue;
      statements.push({
        sql: 'INSERT INTO announcements (title, content, badge) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title = ? AND content = ?)',
        args: [a.title, a.content || a.text || '', a.badge || 'DUYURU', a.title, a.content || a.text || '']
      });
    }
  }

  if (state.settings) {
    statements.push({
      sql: 'UPDATE site_settings SET site_logo = ?, site_favicon = ?, whatsapp_url = ? WHERE id = 1',
      args: [
        state.settings.logo || state.settings.site_logo || '',
        state.settings.favicon || state.settings.site_favicon || '',
        state.settings.whatsapp || state.settings.whatsapp_url || 'https://chat.whatsapp.com/'
      ]
    });
  }

  if (statements.length > 0) {
    await db.batch(statements, 'write');
  }

  return res.status(200).json({ ok: true });
}

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      return await handleGet(res);
    }
    if (req.method === 'POST') {
      return await handlePost(req, res);
    }
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Turso API hatasi:', err);
    return res.status(500).json({ error: err.message });
  }
};