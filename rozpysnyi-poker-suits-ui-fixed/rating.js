const { Pool } = require('pg');

let pool = null;
let ready = false;
let initPromise = null;

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32);
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
          rating INTEGER NOT NULL DEFAULT 1000,
          games INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          total_score INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      ready = true;
      console.log('[rating] PostgreSQL ready');
      return true;
    } catch (e) {
      console.warn('[rating] init failed:', e.message);
      ready = false;
      return false;
    }
  })();
  return initPromise;
}

async function recordGameResults(players) {
  await initRatingDb();
  if (!ready) return null;
  const humans = (players || []).filter((p) => p && !p.bot && p.name);
  if (humans.length < 1) return null;

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
      const r = await client.query(
        `INSERT INTO player_ratings (name_key, display_name, rating, games, wins, total_score, updated_at)
         VALUES ($1, $2, 1000 + $3, 1, $4, $5, NOW())
         ON CONFLICT (name_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           rating = player_ratings.rating + $3,
           games = player_ratings.games + 1,
           wins = player_ratings.wins + $4,
           total_score = player_ratings.total_score + $5,
           updated_at = NOW()
         RETURNING display_name, rating, games, wins, total_score`,
        [key, display, delta, isWin, score]
      );
      if (r.rows[0]) {
        applied.push({
          name: r.rows[0].display_name,
          rating: r.rows[0].rating,
          games: r.rows[0].games,
          wins: r.rows[0].wins,
          delta
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

async function getLeaderboard(limit = 20) {
  await initRatingDb();
  if (!ready) return { ok: false, disabled: true, rows: [] };
  try {
    const r = await getPool().query(
      `SELECT display_name AS name, rating, games, wins, total_score
       FROM player_ratings WHERE games > 0
       ORDER BY rating DESC, wins DESC, total_score DESC
       LIMIT $1`,
      [Math.min(50, Math.max(1, limit | 0))]
    );
    return { ok: true, rows: r.rows };
  } catch (e) {
    console.warn('[rating] leaderboard:', e.message);
    return { ok: false, error: e.message, rows: [] };
  }
}

async function getPlayerRating(name) {
  await initRatingDb();
  if (!ready) return null;
  const key = normalizeName(name);
  if (!key) return null;
  try {
    const r = await getPool().query(
      `SELECT display_name AS name, rating, games, wins, total_score
       FROM player_ratings WHERE name_key=$1`,
      [key]
    );
    return r.rows[0] || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  initRatingDb,
  recordGameResults,
  getLeaderboard,
  getPlayerRating
};
