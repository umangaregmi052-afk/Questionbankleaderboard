// netlify/functions/signup.js
const postgres = require('postgres');

function getDb() {
  return postgres(process.env.DATABASE_URL, {
    ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 10,
  });
}

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      first_name    TEXT NOT NULL,
      last_name     TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { username, firstName, lastName, passwordHash } = body;
  if (!username || !firstName || !lastName || !passwordHash) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  let sql;
  try {
    sql = getDb();
    await ensureTable(sql);

    // Check if username taken
    const existing = await sql`SELECT id FROM users WHERE username = ${username}`;
    if (existing.length > 0) {
      return { statusCode: 409, body: JSON.stringify({ error: `Username "${username}" is already taken.` }) };
    }

    await sql`
      INSERT INTO users (username, first_name, last_name, password_hash)
      VALUES (${username}, ${firstName}, ${lastName}, ${passwordHash})
    `;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, username, firstName, lastName }),
    };
  } catch (err) {
    console.error('Signup error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error during signup' }) };
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
};
