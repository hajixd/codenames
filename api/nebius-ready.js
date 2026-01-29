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

// Nebius models may return message.content as either a string or a "content parts" array.
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

function extractTextFromChoice(choice) {
  if (!choice) return '';
  // Non-streaming style
  if (choice.message && choice.message.content != null) {
    return extractTextFromContent(choice.message.content);
  }
  // Streaming style (delta)
  if (choice.delta && choice.delta.content != null) {
    return extractTextFromContent(choice.delta.content);
  }
  // Some providers include "text" at the top level
  if (choice.text != null) {
    return extractTextFromContent(choice.text);
  }
  // Fallback: sometimes content is nested oddly
  if (choice.content != null) {
    return extractTextFromContent(choice.content);
  }
  return '';
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
    // Some models/providers are picky about the "content parts" format.
    // For a simple readiness check, use plain string content for maximum compatibility.
    const messages = [
      {
        role: 'user',
        content: 'Reply with exactly the single word Ready. Output only: Ready',
      },
    ];

    const r = await fetch(NEBIUS_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        // Give enough room for the single word response across tokenizers.
        max_tokens: 8,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);

    // Some proxies / edge paths can return an empty body. Read text first for better diagnostics.
    const bodyText = await r.text().catch(() => '');
    let data = {};
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch (_) {
      data = {};
    }
    const choice0 = data?.choices?.[0];
    const text = extractTextFromChoice(choice0);

    if (!r.ok) {
      return json(res, r.status, {
        error: data?.error?.message || data?.error || 'Nebius request failed',
        text,
        raw: data,
        bodyText,
      });
    }

    // Even if the provider returns an "empty" completion, don't hard-fail the endpoint.
    // Return 200 with raw diagnostics so the client can mark yellow/red but still proceed.
    // Include raw so the browser can log what the model returned when it isn't exactly "Ready".
    return json(res, 200, { text, raw: data, bodyText });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
};
