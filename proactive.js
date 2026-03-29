const { fetchNews } = require('../modules/api');
const { chat, hasAi } = require('../modules/ai');

function fallbackSummary(text = '', maxLen = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

async function summarizeItem(item) {
  if (!hasAi() || !item?.summary) return fallbackSummary(item?.summary || '');
  const result = await chat({
    system: 'Summarize the article preview in one short plain-English sentence for a Singapore Telegram bot. No hype. No bullets.',
    user: `Title: ${item.title}\nPreview: ${item.summary}`,
    temperature: 0.2,
    max_tokens: 60
  });
  return result || fallbackSummary(item.summary);
}

module.exports = async function newsAgent(ctx, body = '', editContext = null) {
  const category = ['top', 'world', 'business', 'singapore'].includes((body || '').toLowerCase()) ? body.toLowerCase() : 'top';
  const headerMap = {
    top: '📰 Top News',
    world: '🌍 World News',
    business: '💼 Business News',
    singapore: '🇸🇬 Singapore News'
  };
  const items = await fetchNews(category, 8);
  const lines = [`<b>${ctx.escapeHtml(headerMap[category])}</b>`];
  if (!items.length) {
    lines.push('No live news items are available right now.');
  } else {
    const summaries = await Promise.all(items.slice(0, 6).map((item) => summarizeItem(item)));
    items.slice(0, 6).forEach((item, idx) => {
      lines.push('');
      lines.push(`${idx + 1}. <a href="${ctx.escapeHtml(item.link)}">${ctx.escapeHtml(item.title)}</a>`);
      if (summaries[idx]) lines.push(ctx.escapeHtml(summaries[idx]));
    });
  }
  const buttons = {
    inline_keyboard: [[
      { text: 'Top', callback_data: 'show:news:top' },
      { text: 'Singapore', callback_data: 'show:news:singapore' },
      { text: 'Business', callback_data: 'show:news:business' },
      { text: 'World', callback_data: 'show:news:world' }
    ]]
  };
  return editContext
    ? ctx.editOrSend(ctx.msg.chat.id, editContext.messageId, lines.join('\n'), { reply_markup: buttons })
    : ctx.send(ctx.msg.chat.id, lines.join('\n'), { reply_markup: buttons });
};
