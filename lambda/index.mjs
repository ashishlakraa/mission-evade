// Optional AWS Lambda proxy for the LLM learner.
// Keeps the API key on the server, so the public S3 site never contains one.
//
// Setup: Node.js 20+ runtime, environment variable ANTHROPIC_API_KEY,
// enable a Function URL (auth: NONE) and set ALLOWED_ORIGIN to your site's origin.
// In the game: Learner → "Own endpoint (proxy)" → paste the Function URL.

const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const cors = {
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: cors };
  try {
    const { system, prompt } = JSON.parse(event.body || '{}');
    if (typeof prompt !== 'string' || prompt.length > 20000) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'prompt missing or too long' }) };
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 800, temperature: 0.3,
        system: String(system || '').slice(0, 2000),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await res.json();
    if (!res.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: j.error?.message || 'upstream error' }) };
    const text = (j.content || []).map((b) => b.text || '').join('');
    return { statusCode: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ text }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
