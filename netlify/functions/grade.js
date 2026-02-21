// netlify/functions/grade.js
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

async function markCorrect(sql, username, questionId) {
  await sql`
    INSERT INTO student_progress (username, question_id, completed_at)
    VALUES (${username}, ${questionId}, NOW())
    ON CONFLICT (username, question_id)
    DO UPDATE SET completed_at = NOW()
  `;
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

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

  const canSave = username && questionId !== undefined && questionId !== null;

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY is not configured' }) };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — Ask Groq to grade the answer
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
    const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('Groq API error:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error' }) };
    }

    const aiData = await aiResponse.json();
    const raw = aiData.choices?.[0]?.message?.content?.trim() || '';

    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('Failed to parse AI response:', raw);
      parsed = raw.toLowerCase().includes('correct')
        ? { status: 'Correct' }
        : { status: 'Incorrect', hint: 'Review the concept and try again.' };
    }

  } catch (err) {
    console.error('Groq API fetch error:', err);
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
      console.error('Database error (non-fatal):', dbErr.message);
    } finally {
      if (sql) {
        await sql.end({ timeout: 5 }).catch(() => {});
      }
    }
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
