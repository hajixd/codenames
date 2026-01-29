// Vercel Serverless Function
// Proxies OpenAI-compatible chat completions to Nebius.
// Use this so the browser never sees the API key.

const NEBIUS_CHAT_URL = 'https://api.tokenfactory.nebius.com/v1/chat/completions';


const fs = require('fs');
const path = require('path');

function getApiKey() {
  const envKey = (process.env.NEBIUS_API_KEY || '').trim();
  if (envKey) return envKey;
  // Local-only fallback: API_KEY.txt in project root (do not deploy real keys in a file)
  try {
    const p = path.join(process.cwd(), 'API_KEY.txt');
    const k = fs.readFileSync(p, 'utf8').trim();
    return k;
  } catch (_) {
    return '';
  }
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Nebius can return message.content as either a string or an array of content parts.
function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        if (typeof c === 'object') return String(c.text || c.content || '');
        return '';
      })
      .join('')
      .trim();
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim();
    if (typeof content.content === 'string') return content.content.trim();
  }
  return String(content).trim();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return json(res, 500, { error: 'Missing Nebius API key (set NEBIUS_API_KEY env var or add API_KEY.txt for local dev)' });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    body = {};
  }

  const model = String(body.model || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const response_format = body.response_format || undefined;
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const max_tokens = typeof body.max_tokens === 'number' ? body.max_tokens : 400;

  // Basic validation
  const safeMessages = messages
    .filter(m => m && typeof m === 'object' && typeof m.role === 'string')
    .slice(0, 24)
    .map(m => {
      const c = m.content;
      const content = (typeof c === 'string' || Array.isArray(c)) ? c : String(c || '');
      return { role: String(m.role), content };
    });

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20_000);
    const r = await fetch(NEBIUS_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: safeMessages,
        temperature,
        max_tokens,
        response_format,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || data?.error || data?.message || 'Nebius request failed';
      return json(res, r.status, { error: String(msg), raw: data });
    }

    const content = data?.choices?.[0]?.message?.content ?? '';
    const text = extractTextFromContent(content);
    return json(res, 200, { content, text, raw: data });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
};
