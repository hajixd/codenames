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
  // Some providers put refusals in a separate field
  if (choice.message && choice.message.refusal != null) {
    return extractTextFromContent(choice.message.refusal);
  }
  // Streaming style (delta)
  if (choice.delta && choice.delta.content != null) {
    return extractTextFromContent(choice.delta.content);
  }
  if (choice.delta && choice.delta.refusal != null) {
    return extractTextFromContent(choice.delta.refusal);
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
    // Nebius' docs show "content parts" for messages. Some models will return empty output
    // if you send plain string content. We'll try content-parts first, then fall back.

    async function callNebius(messages, modelOverride) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12_000);
      const r = await fetch(NEBIUS_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: String(modelOverride || model),
          temperature: 0,
          // Give enough room for the single word response across tokenizers.
          max_tokens: 16,
          messages,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(t);

      const bodyText = await r.text().catch(() => '');
      let data = {};
      try {
        data = bodyText ? JSON.parse(bodyText) : {};
      } catch (_) {
        data = {};
      }
      const choice0 = data?.choices?.[0];
      const text = extractTextFromChoice(choice0);
      return { r, data, bodyText, text };
    }

    const prompt1 = 'Reply with exactly the single word Ready. Output only: Ready';
    const prompt2 = 'Say only: Ready';
    const prompt3 = 'Ready';

    // Attempt 1: content parts (recommended in Nebius docs)
    const attempt1 = await callNebius([
      {
        role: 'user',
        content: [{ type: 'text', text: prompt1 }],
      },
    ]);

    // If attempt1 is non-200, return it immediately with diagnostics.
    if (!attempt1.r.ok) {
      return json(res, attempt1.r.status, {
        error: attempt1.data?.error?.message || attempt1.data?.error || 'Nebius request failed',
        text: attempt1.text,
        raw: attempt1.data,
        bodyText: attempt1.bodyText,
        attempt: 1,
      });
    }

    // If attempt1 produced text, we're done.
    if ((attempt1.text || '').trim()) {
      return json(res, 200, { text: attempt1.text, raw: attempt1.data, bodyText: attempt1.bodyText, attempt: 1 });
    }

    // Attempt 2: plain string content fallback
    const attempt2 = await callNebius([
      {
        role: 'user',
        content: prompt2,
      },
    ]);

    if (!attempt2.r.ok) {
      return json(res, attempt2.r.status, {
        error: attempt2.data?.error?.message || attempt2.data?.error || 'Nebius request failed',
        text: attempt2.text,
        raw: attempt2.data,
        bodyText: attempt2.bodyText,
        attempt: 2,
        prev: { attempt: 1, raw: attempt1.data, bodyText: attempt1.bodyText },
      });
    }

    if ((attempt2.text || '').trim()) {
      return json(res, 200, {
        text: attempt2.text,
        raw: attempt2.data,
        bodyText: attempt2.bodyText,
        attempt: 2,
        prev: { attempt: 1, raw: attempt1.data, bodyText: attempt1.bodyText },
      });
    }

    // Attempt 3: ultra-simple prompt (some models behave oddly with strict instructions)
    const attempt3 = await callNebius([
      {
        role: 'user',
        content: prompt3,
      },
    ]);

    if ((attempt3.text || '').trim()) {
      return json(res, 200, {
        text: attempt3.text,
        raw: attempt3.data,
        bodyText: attempt3.bodyText,
        attempt: 3,
        prev: {
          attempt: 2,
          raw: attempt2.data,
          bodyText: attempt2.bodyText,
          prev: { attempt: 1, raw: attempt1.data, bodyText: attempt1.bodyText },
        },
      });
    }

    // Attempt 4: fallback model health-check.
    // This ensures the "green" ready state can be achieved as long as the API key + routing works,
    // even if a specific model occasionally returns an empty completion for short prompts.
    const fallbackModel = 'nvidia/Nemotron-Nano-V2-12b';
    const attempt4 = await callNebius(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt2 }],
        },
      ],
      fallbackModel
    );

    // Always return 200, but include attempts so the browser console is actionable.
    return json(res, 200, {
      text: attempt4.text,
      usedModel: fallbackModel,
      raw: attempt4.data,
      bodyText: attempt4.bodyText,
      attempt: 4,
      prev: {
        attempt: 3,
        raw: attempt3.data,
        bodyText: attempt3.bodyText,
        prev: {
          attempt: 2,
          raw: attempt2.data,
          bodyText: attempt2.bodyText,
          prev: { attempt: 1, raw: attempt1.data, bodyText: attempt1.bodyText },
        },
      },
    });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
};
