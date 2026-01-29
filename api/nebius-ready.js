// Vercel Serverless Function
// Verifies that Nebius LLM access works by asking the model to reply exactly "Ready".

const NEBIUS_BASE = 'https://api.tokenfactory.nebius.com/v1/chat/completions';


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

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12_000);
    const r = await fetch(NEBIUS_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: 'system', content: 'You are a health check.' },
          { role: 'user', content: 'Reply with exactly the single word: Ready' },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);

    const data = await r.json().catch(() => ({}));
    const text = String(data?.choices?.[0]?.message?.content || '').trim();

    if (!r.ok) {
      return json(res, r.status, { error: data?.error?.message || data?.error || 'Nebius request failed', text });
    }

    return json(res, 200, { text });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
};
