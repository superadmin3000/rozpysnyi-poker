/**
 * Реєстрація / вхід гравців (PostgreSQL).
 * Без DATABASE_URL — вимкнено.
 */
const crypto = require('crypto');
const { Pool } = require('pg');

let pool = null;
let ready = false;
let initPromise = null;

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
    pool.on('error', (err) => console.warn('[auth] pool error', err.message));
  }
  return pool;
}

function normalizeUsername(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 20);
}

function usernameKey(name) {
  return normalizeUsername(name).toLowerCase();
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

async function initAuthDb() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPool();
    if (!p) {
      console.log('[auth] DATABASE_URL not set — auth disabled');
      ready = false;
      return false;
    }
    try {
      await p.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL,
          username_key TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id)`);
      ready = true;
      console.log('[auth] users table ready');
      return true;
    } catch (e) {
      console.warn('[auth] init failed:', e.message);
      ready = false;
      return false;
    }
  })();
  return initPromise;
}

async function register(username, password) {
  await initAuthDb();
  if (!ready) return { ok: false, error: 'Реєстрація недоступна (немає БД)' };
  const display = normalizeUsername(username);
  const key = usernameKey(display);
  if (key.length < 2) return { ok: false, error: 'Ім\'я занадто коротке' };
  if (key === 'superadmin') return { ok: false, error: 'Це ім\'я зарезервоване' };
  if (!password || String(password).length < 4) return { ok: false, error: 'Пароль мінімум 4 символи' };
  if (String(password).length > 64) return { ok: false, error: 'Пароль занадто довгий' };

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  try {
    const r = await getPool().query(
      `INSERT INTO users (username, username_key, password_hash, password_salt)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username`,
      [display, key, hash, salt]
    );
    const user = r.rows[0];
    const token = await createSession(user.id);
    return { ok: true, token, user: { id: user.id, name: user.username } };
  } catch (e) {
    if (e.code === '23505') return { ok: false, error: 'Таке ім\'я вже зайняте' };
    console.warn('[auth] register', e.message);
    return { ok: false, error: 'Не вдалося зареєструватись' };
  }
}

async function login(username, password) {
  await initAuthDb();
  if (!ready) return { ok: false, error: 'Вхід недоступний (немає БД)' };
  const key = usernameKey(username);
  if (!key || !password) return { ok: false, error: 'Вкажіть ім\'я і пароль' };
  try {
    const r = await getPool().query(
      `SELECT id, username, password_hash, password_salt FROM users WHERE username_key=$1`,
      [key]
    );
    const row = r.rows[0];
    if (!row) return { ok: false, error: 'Невірне ім\'я або пароль' };
    const hash = await hashPassword(password, row.password_salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(row.password_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: 'Невірне ім\'я або пароль' };
    }
    const token = await createSession(row.id);
    return { ok: true, token, user: { id: row.id, name: row.username } };
  } catch (e) {
    console.warn('[auth] login', e.message);
    return { ok: false, error: 'Помилка входу' };
  }
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 днів
  await getPool().query(
    `INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expires.toISOString()]
  );
  return token;
}

async function getUserByToken(token) {
  await initAuthDb();
  if (!ready || !token) return null;
  try {
    const r = await getPool().query(
      `SELECT u.id, u.username AS name
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [String(token)]
    );
    return r.rows[0] || null;
  } catch (e) {
    return null;
  }
}

async function logout(token) {
  if (!token || !ready) return;
  try {
    await getPool().query(`DELETE FROM user_sessions WHERE token=$1`, [String(token)]);
  } catch (e) {}
}

module.exports = {
  initAuthDb,
  register,
  login,
  getUserByToken,
  logout,
  isAuthEnabled: () => !!process.env.DATABASE_URL
};
