const { Pool } = require('pg');

let pool = null;
let ready = false;
let initPromise = null;

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32);
}

/** Поточний місяць UTC: YYYY-MM */
function currentMonthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(key) {
  const [y, m] = String(key).split('-');
  const names = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
  const mi = parseInt(m, 10) - 1;
  return `${names[mi] || m} ${y}`;
}

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', (err) => console.warn('[rating] pool error', err.message));
  }
  return pool;
}

async function initRatingDb() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPool();
    if (!p) {
      console.log('[rating] DATABASE_URL not set — rating disabled');
      ready = false;
      return false;
    }
    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS player_ratings (
          name_key TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          user_id INTEGER,
          rating INTEGER NOT NULL DEFAULT 1000,
          games INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          total_score INTEGER NOT NULL DEFAULT 0,
          jokers INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      try {
        await p.query(`ALTER TABLE player_ratings ADD COLUMN IF NOT EXISTS user_id INTEGER`);
      } catch (e) {}
      try {
        await p.query(`ALTER TABLE player_ratings ADD COLUMN IF NOT EXISTS jokers INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {}
      try {
        await p.query(`ALTER TABLE player_ratings_monthly ADD COLUMN IF NOT EXISTS jokers INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {}
      await p.query(`
        CREATE TABLE IF NOT EXISTS player_ratings_monthly (
          name_key TEXT NOT NULL,
          month_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          user_id INTEGER,
          rating INTEGER NOT NULL DEFAULT 1000,
          games INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          total_score INTEGER NOT NULL DEFAULT 0,
          jokers INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (name_key, month_key)
        )
      `);
      await p.query(`
        CREATE INDEX IF NOT EXISTS idx_ratings_monthly_month
        ON player_ratings_monthly (month_key, rating DESC)
      `);
      ready = true;
      console.log('[rating] PostgreSQL ready (all-time + monthly)');
      return true;
    } catch (e) {
      console.warn('[rating] init failed:', e.message);
      ready = false;
      return false;
    }
  })();
  return initPromise;
}

function computeDeltas(humans) {
  const sorted = [...humans].sort((a, b) => (b.score || 0) - (a.score || 0));
  const ranks = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avgPlace = (i + j) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avgPlace;
    i = j + 1;
  }
  const deltas = ranks.map((place) => {
    if (place <= 0.01) return 40;
    if (place <= 1.01) return 20;
    if (place <= 2.01) return 5;
    return -15;
  });
  if (sorted.length === 1) deltas[0] = 10;
  return { sorted, ranks, deltas };
}

async function upsertRow(client, table, key, display, delta, isWin, score, jokersAdd, monthKey, userId) {
  const jAdd = Math.max(0, parseInt(jokersAdd, 10) || 0);
  if (table === 'player_ratings') {
    const r = await client.query(
      `INSERT INTO player_ratings (name_key, display_name, user_id, rating, games, wins, total_score, jokers, updated_at)
       VALUES ($1, $2, $6, 1000 + $3, 1, $4, $5, $7, NOW())
       ON CONFLICT (name_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         user_id = COALESCE(EXCLUDED.user_id, player_ratings.user_id),
         rating = player_ratings.rating + $3,
         games = player_ratings.games + 1,
         wins = player_ratings.wins + $4,
         total_score = player_ratings.total_score + $5,
         jokers = COALESCE(player_ratings.jokers, 0) + $7,
         updated_at = NOW()
       RETURNING display_name, rating, games, wins, total_score, jokers`,
      [key, display, delta, isWin, score, userId, jAdd]
    );
    return r.rows[0];
  }
  const r = await client.query(
    `INSERT INTO player_ratings_monthly
       (name_key, month_key, display_name, user_id, rating, games, wins, total_score, jokers, updated_at)
     VALUES ($1, $2, $3, $7, 1000 + $4, 1, $5, $6, $8, NOW())
     ON CONFLICT (name_key, month_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       user_id = COALESCE(EXCLUDED.user_id, player_ratings_monthly.user_id),
       rating = player_ratings_monthly.rating + $4,
       games = player_ratings_monthly.games + 1,
       wins = player_ratings_monthly.wins + $5,
       total_score = player_ratings_monthly.total_score + $6,
       jokers = COALESCE(player_ratings_monthly.jokers, 0) + $8,
       updated_at = NOW()
     RETURNING display_name, rating, games, wins, total_score, jokers`,
    [key, monthKey, display, delta, isWin, score, userId, jAdd]
  );
  return r.rows[0];
}

async function recordGameResults(players) {
  await initRatingDb();
  if (!ready) return null;
  const humans = (players || []).filter((p) => p && !p.bot && p.name && (p.userId || p.registered));
  if (humans.length < 1) return null;

  const { sorted, ranks, deltas } = computeDeltas(humans);
  const monthKey = currentMonthKey();
  const client = await getPool().connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < sorted.length; idx++) {
      const pl = sorted[idx];
      const key = normalizeName(pl.name);
      if (!key || key === 'superadmin') continue;
      const delta = deltas[idx];
      const isWin = ranks[idx] <= 0.01 ? 1 : 0;
      const score = pl.score || 0;
      const display = String(pl.name).trim().slice(0, 32);
      const uid = pl.userId || null;
      const jokers = pl.jokers || 0;

      const all = await upsertRow(client, 'player_ratings', key, display, delta, isWin, score, jokers, null, uid);
      const mon = await upsertRow(client, 'player_ratings_monthly', key, display, delta, isWin, score, jokers, monthKey, uid);

      if (all) {
        applied.push({
          name: all.display_name,
          rating: all.rating,
          monthRating: mon ? mon.rating : null,
          games: all.games,
          wins: all.wins,
          jokers: all.jokers,
          delta,
          month: monthKey
        });
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.warn('[rating] record failed:', e.message);
    return null;
  } finally {
    client.release();
  }
  return applied;
}

async function getLeaderboard(limit = 20, period = 'all', monthKey = null) {
  await initRatingDb();
  if (!ready) return { ok: false, disabled: true, rows: [], period: 'all' };

  const lim = Math.min(50, Math.max(1, limit | 0));
  try {
    if (period === 'month') {
      const mk = monthKey || currentMonthKey();
      const r = await getPool().query(
        `SELECT display_name AS name, rating, games, wins, total_score, COALESCE(jokers,0) AS jokers, month_key
         FROM player_ratings_monthly
         WHERE month_key = $1 AND games > 0
         ORDER BY rating DESC, wins DESC, total_score DESC
         LIMIT $2`,
        [mk, lim]
      );
      return {
        ok: true,
        period: 'month',
        month: mk,
        monthLabel: monthLabel(mk),
        rows: r.rows
      };
    }

    const r = await getPool().query(
      `SELECT display_name AS name, rating, games, wins, total_score, COALESCE(jokers,0) AS jokers
       FROM player_ratings WHERE games > 0
       ORDER BY rating DESC, wins DESC, total_score DESC
       LIMIT $1`,
      [lim]
    );
    return { ok: true, period: 'all', rows: r.rows };
  } catch (e) {
    console.warn('[rating] leaderboard:', e.message);
    return { ok: false, error: e.message, rows: [], period };
  }
}

async function getPlayerRating(name) {
  await initRatingDb();
  if (!ready) return null;
  const key = normalizeName(name);
  if (!key) return null;
  const mk = currentMonthKey();
  try {
    const all = await getPool().query(
      `SELECT display_name AS name, rating, games, wins, total_score, COALESCE(jokers,0) AS jokers
       FROM player_ratings WHERE name_key=$1`,
      [key]
    );
    const mon = await getPool().query(
      `SELECT rating, games, wins, total_score, month_key
       FROM player_ratings_monthly WHERE name_key=$1 AND month_key=$2`,
      [key, mk]
    );
    if (!all.rows[0]) return null;
    return {
      ...all.rows[0],
      month: mk,
      monthLabel: monthLabel(mk),
      monthRating: mon.rows[0] || null
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  initRatingDb,
  recordGameResults,
  getLeaderboard,
  getPlayerRating,
  currentMonthKey
};
