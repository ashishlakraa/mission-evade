// LLM client used by the learner after each run.
//
// Providers:
//   anthropic — calls the Claude Messages API straight from the browser with the user's own key
//   openai    — calls the OpenAI Chat Completions API with the user's own key
//   proxy     — POSTs {system, prompt} to your own endpoint (for example an AWS Lambda
//               that holds the key server-side). Expects {"text": "..."} back.
//
// Keys entered in the page stay in this browser's localStorage only.
// For a public deployment use the proxy so no key is ever shipped to visitors.

export const PROVIDERS = {
  local:     { label: 'Local learner (no LLM)', needsKey: false },
  anthropic: { label: 'Claude (Anthropic API)', needsKey: true, defaultModel: 'claude-haiku-5-5' },
  openai:    { label: 'OpenAI API', needsKey: true, defaultModel: 'gpt-4o-mini' },
  proxy:     { label: 'Own endpoint (proxy)', needsKey: false, needsEndpoint: true },
};

export function isConfigured(s) {
  const p = PROVIDERS[s.provider];
  if (!p || s.provider === 'local') return false;
  if (p.needsKey && !s.apiKey) return false;
  if (p.needsEndpoint && !s.endpoint) return false;
  return true;
}

export async function callLLM(settings, system, prompt, { timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  const model = settings.model || PROVIDERS[settings.provider]?.defaultModel || '';
  try {
    let text;
    if (settings.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model, max_tokens: 800, temperature: 0.3, system,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Claude API returned ${res.status}: ${await shortBody(res)}`);
      const j = await res.json();
      text = (j.content || []).map((b) => b.text || '').join('');
    } else if (settings.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model, temperature: 0.3, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API returned ${res.status}: ${await shortBody(res)}`);
      const j = await res.json();
      text = j.choices?.[0]?.message?.content || '';
    } else if (settings.provider === 'proxy') {
      const res = await fetch(settings.endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system, prompt, model: settings.model || undefined }),
      });
      if (!res.ok) throw new Error(`Endpoint returned ${res.status}: ${await shortBody(res)}`);
      const j = await res.json();
      text = typeof j.text === 'string' ? j.text : JSON.stringify(j);
    } else {
      throw new Error('No LLM provider selected');
    }
    return { text, ms: Math.round(performance.now() - t0), model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`No reply within ${timeoutMs / 1000} s`);
    if (e instanceof TypeError) throw new Error('Network request blocked or failed (check the key, the endpoint, or CORS)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function shortBody(res) {
  try { return (await res.text()).slice(0, 160); } catch { return ''; }
}

// Pull the first JSON object out of a model reply (handles ```json fences and stray prose).
export function extractJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Reply contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}
