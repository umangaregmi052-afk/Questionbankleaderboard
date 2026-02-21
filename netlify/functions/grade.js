// netlify/functions/grade.js
// Deployed automatically by Netlify — place this file at:
// your-project/netlify/functions/grade.js
//
// Required env vars in Netlify:
//   GEMINI_API_KEY  — your Google Gemini API key
//   DATABASE_URL    — your Neon PostgreSQL connection string
//
// Required npm package — add to your package.json:
//   "postgres": "^3.4.4"

const postgres = require('postgres');

// ---------------------------------------------------------------------------
// DB helper — creates a short-lived connection per invocation.
// Neon's "serverless" tier works best with ssl: 'require'.
// ---------------------------------------------------------------------------
function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return postgres(process.env.DATABASE_URL, {
    ssl: 'require',
    max: 1,              // one connection is enough for a serverless function
    idle_timeout: 20,    // release quickly after use
    connect_timeout: 10,
  });
}

// ---------------------------------------------------------------------------
// Ensure the table exists so first deploy just works.
// Safe to run on every cold start — CREATE TABLE IF NOT EXISTS is idempotent.
// ---------------------------------------------------------------------------
async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS student_progress (
      id            SERIAL PRIMARY KEY,
      username      TEXT        NOT NULL,
      question_id   INTEGER     NOT NULL,
      completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (username, question_id)
    )
  `;
}

// ---------------------------------------------------------------------------
// Upsert a completed question for the given user.
// ON CONFLICT does nothing if the row already exists (idempotent).
// ---------------------------------------------------------------------------
async function markCorrect(sql, username, questionId) {
  await sql`
    INSERT INTO student_progress (username, question_id, completed_at)
    VALUES (${username}, ${questionId}, NOW())
    ON CONFLICT (username, question_id)
    DO UPDATE SET completed_at = NOW()
  `;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
exports.handler = async function(event, context) {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { question, answer, username, questionId } = body;

  if (!question || !answer) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing question or answer' }) };
  }

  // username and questionId are needed only when saving — warn but don't block grading
  const canSave = username && questionId !== undefined && questionId !== null;

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY is not configured' }) };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — Ask Claude to grade the answer
  // ---------------------------------------------------------------------------
  const prompt = `You are a strict but fair computer programming examiner grading a student's answer.

Question: ${question}

Student's Answer: ${answer}

Grade this answer. Respond ONLY with a valid JSON object in exactly this format:
- If the answer is correct or substantially correct: {"status": "Correct"}
- If the answer is wrong or incomplete: {"status": "Incorrect", "hint": "One short, helpful hint to guide the student (max 20 words)"}

Be strict: vague or incomplete answers should be marked Incorrect. But do not penalise for minor grammar or formatting issues — focus on conceptual correctness.
Respond with JSON only. No extra text.`;

  let parsed;
  try {
    const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          maxOutputTokens: 150,
        },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('Gemini API error:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error' }) };
    }

    const aiData = await aiResponse.json();
    const raw = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('Failed to parse AI response:', raw);
      // Graceful fallback
      parsed = raw.toLowerCase().includes('"correct"')
        ? { status: 'Correct' }
        : { status: 'Incorrect', hint: 'Review the concept and try again.' };
    }

  } catch (err) {
    console.error('Gemini API fetch error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error during grading' }) };
  }

  // ---------------------------------------------------------------------------
  // Step 2 — If correct, persist to Neon PostgreSQL
  // ---------------------------------------------------------------------------
  if (parsed.status === 'Correct' && canSave) {
    let sql;
    try {
      sql = getDb();
      await ensureTable(sql);
      await markCorrect(sql, username, Number(questionId));
      console.log(`Saved: username="${username}" question_id=${questionId}`);
    } catch (dbErr) {
      // DB failure should NOT block the student from seeing "Correct".
      // Log it and continue — the frontend's window.storage still saves locally.
      console.error('Database error (non-fatal):', dbErr.message);
    } finally {
      if (sql) {
        // End the connection pool so the Lambda doesn't hang
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }
  } else if (parsed.status === 'Correct' && !canSave) {
    console.warn('Answer is Correct but username/questionId missing — skipping DB write');
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Return the grading result to the frontend
  // ---------------------------------------------------------------------------
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed),
  };
};
