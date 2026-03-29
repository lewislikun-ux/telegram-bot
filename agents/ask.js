const { chat } = require('../modules/ai');

module.exports = async function askAgent(ctx, body) {
  if (!body) {
    return ctx.send(ctx.msg.chat.id, 'Use: <code>/ask your question</code>');
  }
  const answer = await chat({
    system: 'You are a practical assistant inside a Telegram bot. Be concise, useful, and specific. Use simple language.',
    user: body,
    temperature: 0.4,
    max_tokens: 500
  });
  return ctx.send(ctx.msg.chat.id, answer || 'AI is not configured right now. Add <code>GITHUB_MODELS_TOKEN</code> in Render env vars.', { reply_markup: ctx.MAIN_KEYBOARD });
};
