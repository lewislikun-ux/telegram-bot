const { fetchWeather, fetchTaxiAvailability, fetchTrafficImages } = require('../modules/api');
const { chat, hasAi } = require('../modules/ai');

function deterministicAdvice({ dayType, hourlyNet, weather, taxiCount }) {
  let headline = 'Mixed signal';
  let reason = 'Your recent comparable sessions are average.';
  if (hourlyNet >= 40) {
    headline = 'Worth going';
    reason = 'Your recent comparable net hourly rate is strong.';
  } else if (hourlyNet < 25) {
    headline = 'Low ROI';
    reason = 'Your recent comparable net hourly rate is weak.';
  }
  if (/thunder|rain|showers/i.test(weather || '')) reason += ' Rain may improve demand.';
  if (taxiCount && taxiCount < 2500) reason += ' Taxi supply looks tighter than usual.';
  if (dayType === 'weekend') reason += ' Weekend demand can stay firmer later into the day.';
  return { headline, reason };
}

module.exports = async function driveAgent(ctx, _body = '', editContext = null) {
  const userId = ctx.msg.from.id;
  const today = ctx.todayDateString();
  const dayType = ctx.getDayType(today);
  const logs = await ctx.getPhvRange(userId, ctx.addDays(today, -60), today);
  const comparable = ctx.summarizeComparableSessions(logs, dayType, today);
  const [weather, taxi, trafficImages] = await Promise.all([
    fetchWeather('Punggol').catch(() => null),
    fetchTaxiAvailability().catch(() => ({ taxiCount: 0 })),
    fetchTrafficImages(2).catch(() => [])
  ]);

  const base = deterministicAdvice({
    dayType,
    hourlyNet: comparable.hourlyNet || 0,
    weather: weather?.forecast || '',
    taxiCount: taxi?.taxiCount || 0
  });

  let ai = null;
  if (hasAi()) {
    ai = await chat({
      system: 'You are a practical PHV decision assistant in Singapore. Based on the stats given, give a short verdict and a short next action. Do not mention uncertainty unless there is no data.',
      user: JSON.stringify({
        today,
        dayType,
        hourlyNet: comparable.hourlyNet || 0,
        sessionCount: comparable.count || 0,
        weather: weather?.forecast || null,
        taxiCount: taxi?.taxiCount || 0
      }),
      temperature: 0.2,
      max_tokens: 90
    });
  }

  const lines = ['<b>PHV decision agent</b>'];
  lines.push(`Today type: <b>${ctx.escapeHtml(dayType)}</b>`);
  lines.push(`Comparable sessions: <b>${ctx.escapeHtml(String(comparable.count || 0))}</b>`);
  lines.push(`Recent avg hourly net: <b>${ctx.currency(comparable.hourlyNet)}</b>`);
  if (weather) lines.push(`Weather: <b>${ctx.escapeHtml(weather.forecast)}</b> (${ctx.escapeHtml(weather.area)})`);
  lines.push(`Taxi availability: <b>${ctx.escapeHtml(String(taxi?.taxiCount || '-'))}</b>`);
  lines.push('', `<b>${ctx.escapeHtml(base.headline)}</b>`, `• ${ctx.escapeHtml(base.reason)}`);
  if (ai) lines.push(`• ${ctx.escapeHtml(ai)}`);
  if (trafficImages.length) {
    lines.push('', '<b>Traffic cams</b>');
    trafficImages.forEach((cam, idx) => lines.push(`• <a href="${ctx.escapeHtml(cam.image)}">Camera ${idx + 1}</a>`));
  }
  const opts = { reply_markup: { inline_keyboard: [[{ text: '📰 News', callback_data: 'show:news' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }]] } };
  return editContext
    ? ctx.editOrSend(ctx.msg.chat.id, editContext.messageId, lines.join('\n'), opts)
    : ctx.send(ctx.msg.chat.id, lines.join('\n'), opts);
};
