const axios = require('axios');

const MODELS_API = 'https://models.github.ai/inference/chat/completions';

function hasAi() {
  return Boolean(process.env.GITHUB_MODELS_TOKEN);
}

async function chat({ system, user, model, temperature = 0.4, max_tokens = 320 }) {
  if (!hasAi()) return null;
  try {
    const response = await axios.post(
      MODELS_API,
      {
        model: model || process.env.GITHUB_MODELS_MODEL || 'openai/gpt-5',
        temperature,
        max_tokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user }
        ]
      },
      {
        timeout: 30000,
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_MODELS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': process.env.GITHUB_MODELS_API_VERSION || '2026-03-10'
        }
      }
    );
    return response?.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('AI chat failed:', err.response?.status, err.response?.data || err.message);
    return null;
  }
}

module.exports = { chat, hasAi };
