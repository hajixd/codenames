// Vercel Serverless Function (Node)
// Proxies requests to Nebius Token Factory (OpenAI-compatible) so the API key
// never ships to the browser.

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const apiKey = process.env.NEBIUS_API_KEY;
    if (!apiKey) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing NEBIUS_API_KEY env var' }));
      return;
    }

    const body = typeof req.body === 'object' ? req.body : safeJsonParse(req.body);
    const model = String(body?.model || '').trim();
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    const response_format = body?.response_format;

    if (!model || !messages) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing required fields: model, messages[]' }));
      return;
    }

    const payload = {
      model,
      messages,
      // Reasonable defaults for gameplay.
      temperature: typeof body?.temperature === 'number' ? body.temperature : 0.4,
      max_tokens: typeof body?.max_tokens === 'number' ? body.max_tokens : 300,
    };
    if (response_format && typeof response_format === 'object') {
      payload.response_format = response_format;
    }

    const r = await fetch(NEBIUS_BASE_URL + 'chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      res.statusCode = r.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Nebius request failed', details: text }));
      return;
    }

    const data = safeJsonParse(text) || {};
    const outText = data?.choices?.[0]?.message?.content ?? '';

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: outText, raw: data }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server error', details: String(err?.message || err) }));
  }
};

function safeJsonParse(v) {
  try {
    if (typeof v !== 'string') return null;
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}
