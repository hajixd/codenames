// Vercel Serverless Function (Node)
// Sends a tiny request to confirm the model is reachable.
// Returns { text: "Ready" | <other> }

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

    if (!model) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing required field: model' }));
      return;
    }

    const payload = {
      model,
      temperature: 0,
      max_tokens: 3,
      messages: [
        { role: 'system', content: 'Reply with exactly the single word Ready.' },
        { role: 'user', content: 'Ready?' }
      ]
    };

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
    const outText = String(data?.choices?.[0]?.message?.content ?? '').trim();

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: outText }));
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
