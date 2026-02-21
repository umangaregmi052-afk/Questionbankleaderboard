// netlify/functions/leaderboard.js
// Place this file at: your-project/netlify/functions/leaderboard.js
//
// Required env vars in Netlify:
//   DATABASE_URL — your Neon PostgreSQL connection string

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
  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let sql;
  try {
    sql = getDb();

    // Get count of completed questions per user, sorted by most done
    const rows = await sql`
      SELECT 
        username,
        COUNT(*) AS questions_done
      FROM student_progress
      GROUP BY username
      ORDER BY questions_done DESC
    `;

    const leaderboard = rows.map(row => ({
      username: row.username,
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
