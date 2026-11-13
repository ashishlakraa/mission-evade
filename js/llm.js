// LLM client used by the learner after each run. Open-weight models only.
//
// Providers:
//   huggingface — calls the Hugging Face router (OpenAI-compatible chat completions),
//                 served by Featherless AI, with the admin's own HF access token
//
// The token entered at /admin stays in that browser's localStorage only.

export const HF_ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';
export const DEFAULT_OPEN_MODEL = 'Qwen/Qwen2.5-7B-Instruct:featherless-ai';

export const PROVIDERS = {
  local:       { label: 'Local learner (no LLM)', needsKey: false },
  huggingface: { label: 'Open model (Hugging Face / Featherless)', needsKey: true, defaultModel: DEFAULT_OPEN_MODEL },
};

export function isConfigured(s) {
  const p = PROVIDERS[s.provider];
  if (!p || s.provider === 'local') return false;
  if (p.needsKey && !s.apiKey) return false;
  return true;
}

export async function callLLM(settings, system, prompt, { timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  const model = settings.model || PROVIDERS[settings.provider]?.defaultModel || '';
  try {
    let text;
    if (settings.provider === 'huggingface') {
      const res = await fetch(HF_ROUTER_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model, max_tokens: 800, temperature: 0.3,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Hugging Face returned ${res.status}: ${await shortBody(res)}`);
      const j = await res.json();
      text = j.choices?.[0]?.message?.content || '';
    } else {
      throw new Error('No LLM provider selected');
    }
    return { text, ms: Math.round(performance.now() - t0), model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`No reply within ${timeoutMs / 1000} s`);
    if (e instanceof TypeError) throw new Error('Network request blocked or failed (check the token or the connection)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function shortBody(res) {
  try { return (await res.text()).slice(0, 160); } catch { return ''; }
}

// Pull the first JSON object out of a model reply (handles ```json fences and stray prose).
// Reasoning models (Qwen3 and others) may wrap their thoughts in <think>…</think> first.
export function extractJson(text) {
  text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Reply contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}
