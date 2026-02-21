// netlify/functions/login.js
const postgres = require('postgres');

function getDb() {
  return postgres(process.env.DATABASE_URL, {
    ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 10,
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { username, passwordHash } = body;
  if (!username || !passwordHash) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  let sql;
  try {
    sql = getDb();

    const rows = await sql`
      SELECT username, first_name, last_name, password_hash
      FROM users WHERE username = ${username}
    `;

    if (rows.length === 0) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Username not found. Check spelling or sign up.' }) };
    }

    const user = rows[0];
    if (user.password_hash !== passwordHash) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Incorrect password.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
      }),
    };
  } catch (err) {
    console.error('Login error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error during login' }) };
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
};
