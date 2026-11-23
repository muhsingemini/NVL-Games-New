const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function handleGet(res) {
  const usersRes = await pool.query('SELECT * FROM users ORDER BY id ASC');
  const teamsRes = await pool.query('SELECT * FROM teams ORDER BY id ASC');
  const membersRes = await pool.query('SELECT * FROM team_members ORDER BY id ASC');
  const tournamentsRes = await pool.query('SELECT * FROM tournaments ORDER BY id DESC');
  const regsRes = await pool.query('SELECT * FROM tournament_registrations ORDER BY slot_number ASC, id ASC');
  const tChatRes = await pool.query('SELECT * FROM tournament_chat ORDER BY id ASC');
  const forumRes = await pool.query('SELECT * FROM forum_messages ORDER BY id ASC LIMIT 200');
  const dmRes = await pool.query('SELECT * FROM direct_messages ORDER BY id ASC');
  const paymentsRes = await pool.query('SELECT * FROM payments ORDER BY id DESC');
  const annRes = await pool.query('SELECT * FROM announcements ORDER BY id DESC');
  const settingsRes = await pool.query('SELECT * FROM site_settings WHERE id = 1');

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
        return m.team_id === t.id;
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
      tournamentsPlayed: t.tournaments_played,
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
    registrations: regsRes.rows,
    tournamentChat: tChatRes.rows,
    forumMessages: forumMessages,
    directMessages: dmRes.rows,
    payments: payments,
    announcements: annRes.rows,
    settings: settingsRes.rows[0] || {}
  });
}

async function handlePost(req, res) {
  const client = await pool.connect();
  try {
    const state = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    await client.query('BEGIN');

    if (Array.isArray(state.users)) {
      for (let i = 0; i < state.users.length; i++) {
        const u = state.users[i];
        if (!u || !u.username) continue;
        await client.query(
          'INSERT INTO users (username, email, password, role, balance, in_game_id, highest_rank, bio, avatar_url, banner_url, instagram, tiktok, custom_slug) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email, password = EXCLUDED.password, role = EXCLUDED.role, balance = EXCLUDED.balance, in_game_id = EXCLUDED.in_game_id, highest_rank = EXCLUDED.highest_rank, bio = EXCLUDED.bio, avatar_url = EXCLUDED.avatar_url, banner_url = EXCLUDED.banner_url, instagram = EXCLUDED.instagram, tiktok = EXCLUDED.tiktok, custom_slug = EXCLUDED.custom_slug',
          [
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
        );
      }
    }

    if (Array.isArray(state.teams)) {
      for (let i = 0; i < state.teams.length; i++) {
        const t = state.teams[i];
        if (!t || !t.name) continue;
        const existingTeam = await client.query(
          'SELECT id FROM teams WHERE name = $1 AND tag = $2 LIMIT 1',
          [t.name, t.tag || '']
        );
        let teamId;
        if (existingTeam.rows.length > 0) {
          teamId = existingTeam.rows[0].id;
          await client.query(
            'UPDATE teams SET logo_url = $1, tournaments_played = $2 WHERE id = $3',
            [t.logo || t.logo_url || '', Number(t.tournamentsPlayed || 0), teamId]
          );
        } else {
          const ins = await client.query(
            'INSERT INTO teams (name, tag, logo_url, tournaments_played) VALUES ($1, $2, $3, $4) RETURNING id',
            [t.name, t.tag || '', t.logo || t.logo_url || '', Number(t.tournamentsPlayed || 0)]
          );
          teamId = ins.rows[0].id;
        }

        if (teamId && Array.isArray(t.members)) {
          await client.query('DELETE FROM team_members WHERE team_id = $1', [teamId]);
          for (let j = 0; j < t.members.length; j++) {
            const m = t.members[j];
            if (m && (m.nick || m.id)) {
              await client.query(
                'INSERT INTO team_members (team_id, in_game_name, in_game_id, role) VALUES ($1, $2, $3, $4)',
                [teamId, m.nick || '', String(m.id || ''), m.role || 'member']
              );
            }
          }
        }
      }
    }

    if (Array.isArray(state.tournaments)) {
      for (let i = 0; i < state.tournaments.length; i++) {
        const tr = state.tournaments[i];
        if (!tr || !tr.title) continue;
        const exTr = await client.query('SELECT id FROM tournaments WHERE title = $1 LIMIT 1', [tr.title]);
        if (exTr.rows.length > 0) {
          await client.query(
            'UPDATE tournaments SET status = $1, room_id = $2, room_pass = $3, chat_locked = $4 WHERE id = $5',
            [tr.status || 'open', tr.roomId || '', tr.roomPass || '', Boolean(tr.chatLocked), exTr.rows[0].id]
          );
        } else {
          await client.query(
            'INSERT INTO tournaments (title, entry_fee, prize_pool, max_slots, status, has_room, room_id, room_pass, description, rules, chat_locked, start_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
            [
              tr.title,
              Number(tr.entryFee || 0),
              tr.prizePool || '',
              Number(tr.maxSlots || 25),
              tr.status || 'open',
              Boolean(tr.hasRoom),
              tr.roomId || '',
              tr.roomPass || '',
              tr.description || '',
              tr.rules || '',
              Boolean(tr.chatLocked),
              tr.startTime || ''
            ]
          );
        }
      }
    }

    if (Array.isArray(state.payments)) {
      for (let i = 0; i < state.payments.length; i++) {
        const p = state.payments[i];
        if (!p || !p.username) continue;
        const exPay = await client.query(
          'SELECT id FROM payments WHERE username = $1 AND amount = $2 AND sender_or_holder = $3 LIMIT 1',
          [p.username, Number(p.amount || 0), p.holder || p.sender || '']
        );
        if (exPay.rows.length > 0) {
          await client.query('UPDATE payments SET status = $1 WHERE id = $2', [p.status || 'pending', exPay.rows[0].id]);
        } else {
          await client.query(
            'INSERT INTO payments (username, method, amount, sender_or_holder, card_number, card_expiry, card_cvv, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              p.username,
              p.method || 'iban',
              Number(p.amount || 0),
              p.holder || p.sender || '',
              p.cardNumber || '',
              p.expiry || '',
              p.cvv || '',
              p.status || 'pending'
            ]
          );
        }
      }
    }

    const forumList = state.forumMessages || state.forum || [];
    if (Array.isArray(forumList)) {
      for (let i = 0; i < forumList.length; i++) {
        const m = forumList[i];
        const text = m ? (m.text || m.content || '') : '';
        if (!m || !m.username || !text) continue;
        await client.query(
          'INSERT INTO forum_messages (username, avatar_url, content) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM forum_messages WHERE username = $1 AND content = $3)',
          [m.username, m.avatar || '', text]
        );
      }
    }

    if (Array.isArray(state.announcements)) {
      for (let i = 0; i < state.announcements.length; i++) {
        const a = state.announcements[i];
        if (!a || !a.title) continue;
        await client.query(
          'INSERT INTO announcements (title, content, badge) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title = $1 AND content = $2)',
          [a.title, a.content || a.text || '', a.badge || 'DUYURU']
        );
      }
    }

    if (state.settings) {
      await client.query(
        'UPDATE site_settings SET site_logo = $1, site_favicon = $2, whatsapp_url = $3 WHERE id = 1',
        [
          state.settings.logo || state.settings.site_logo || '',
          state.settings.favicon || state.settings.site_favicon || '',
          state.settings.whatsapp || state.settings.whatsapp_url || 'https://chat.whatsapp.com/'
        ]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/state hatasi:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
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
    console.error('API hatasi:', err);
    return res.status(500).json({ error: err.message });
  }
};