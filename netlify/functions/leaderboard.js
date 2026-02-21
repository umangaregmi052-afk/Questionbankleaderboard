// netlify/functions/leaderboard.js
const postgres = require('postgres');

function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return postgres(process.env.DATABASE_URL, {
    ssl: 'require',
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let sql;
  try {
    sql = getDb();

    // Join users table with student_progress so ALL users appear,
    // even those who haven't answered any questions yet (COUNT = 0)
    const rows = await sql`
      SELECT 
        u.username,
        u.first_name,
        u.last_name,
        COUNT(sp.question_id) AS questions_done
      FROM users u
      LEFT JOIN student_progress sp ON u.username = sp.username
      GROUP BY u.username, u.first_name, u.last_name
      ORDER BY questions_done DESC, u.username ASC
    `;

    const leaderboard = rows.map(row => ({
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      done: Number(row.questions_done),
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(leaderboard),
    };

  } catch (err) {
    console.error('Leaderboard DB error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not load leaderboard' }),
    };
  } finally {
    if (sql) {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }
};
