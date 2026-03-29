const { fetchNews, fetchWeather, fetchTaxiAvailability, fetchFx, fetchCrypto } = require('../modules/api');
const { chat, hasAi } = require('../modules/ai');

function driveSignal({ hourlyNet, weather, taxiCount, dayType }) {
  let score = 0;
  if (hourlyNet >= 40) score += 2;
  else if (hourlyNet >= 30) score += 1;
  if (/thunder|rain|showers/i.test(weather || '')) score += 1;
  if (dayType === 'weekend') score += 1;
  if (taxiCount && taxiCount < 2500) score += 1;
  if (score >= 4) return '🟢 Good';
  if (score >= 2) return '🟡 Mixed';
  return '🔴 Weak';
}

module.exports = async function gmAgent(ctx) {
  const userId = ctx.msg.from.id;
  const today = ctx.todayDateString();
  const dayType = ctx.getDayType(today);
  const logs = await ctx.getPhvRange(userId, ctx.addDays(today, -30), today);
  const comparable = ctx.summarizeComparableSessions(logs, dayType, today);

  const [weather, topNews, fx, taxi, crypto] = await Promise.all([
    fetchWeather('Punggol').catch(() => null),
    fetchNews('top', 4).catch(() => []),
    fetchFx('USD', ['SGD', 'MYR']).catch(() => ({})),
    fetchTaxiAvailability().catch(() => ({ taxiCount: 0 })),
    fetchCrypto(['bitcoin', 'ethereum']).catch(() => [])
  ]);

  const signal = driveSignal({
    hourlyNet: comparable.hourlyNet || 0,
    weather: weather?.forecast,
    taxiCount: taxi?.taxiCount,
    dayType
  });

  let aiWrap = null;
  if (hasAi()) {
    aiWrap = await chat({
      system: 'Write one short good-morning operations note for a Singapore PHV driver. Mention only the most useful next action.',
      user: JSON.stringify({
        dayType,
        weather: weather?.forecast || null,
        hourlyNet: comparable.hourlyNet || 0,
        taxiCount: taxi?.taxiCount || 0,
        topHeadline: topNews[0]?.title || null,
        signal
      }),
      temperature: 0.2,
      max_tokens: 60
    });
  }

  const lines = ['<b>Good morning ☀️</b>'];
  if (aiWrap) lines.push('', ctx.escapeHtml(aiWrap));
  if (weather) {
    lines.push('', `<b>Weather</b>`, `• ${ctx.escapeHtml(weather.area)}: <b>${ctx.escapeHtml(weather.forecast)}</b>`);
  }
  lines.push('', '<b>FX</b>', `• USD/SGD: <b>${ctx.escapeHtml(String(fx.SGD || '-'))}</b>`, `• USD/MYR: <b>${ctx.escapeHtml(String(fx.MYR || '-'))}</b>`);
  if (crypto.length) {
    lines.push('', '<b>Crypto</b>');
    crypto.forEach((coin) => lines.push(`• ${ctx.escapeHtml(coin.symbol.toUpperCase())}: <b>$${Number(coin.current_price).toLocaleString()}</b> (${Number(coin.change_24h || 0).toFixed(2)}%)`));
  }
  lines.push('', '<b>PHV signal</b>', `• Recent ${ctx.escapeHtml(dayType)} avg hourly net: <b>${ctx.currency(comparable.hourlyNet)}</b>`, `• Taxi availability: <b>${ctx.escapeHtml(String(taxi?.taxiCount || '-'))}</b>`, `• Drive call: <b>${signal}</b>`);
  lines.push('', '<b>Top news</b>');
  if (!topNews.length) lines.push('• No live headlines right now.');
  else topNews.forEach((item) => lines.push(`• <a href="${ctx.escapeHtml(item.link)}">${ctx.escapeHtml(item.title)}</a>`));
  return ctx.send(ctx.msg.chat.id, lines.join('\n'), { reply_markup: ctx.MAIN_KEYBOARD });
};
