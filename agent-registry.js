const { fetchTaxiAvailability, fetchTrafficImages } = require('../modules/api');

module.exports = async function trafficAgent(ctx) {
  const [taxi, cams] = await Promise.all([
    fetchTaxiAvailability().catch(() => ({ taxiCount: 0 })),
    fetchTrafficImages(3).catch(() => [])
  ]);
  const lines = ['<b>Traffic / taxi snapshot</b>', `Taxi availability: <b>${ctx.escapeHtml(String(taxi?.taxiCount || '-'))}</b>`];
  if (cams.length) {
    lines.push('', '<b>Traffic cameras</b>');
    cams.forEach((cam, idx) => lines.push(`• <a href="${ctx.escapeHtml(cam.image)}">Camera ${idx + 1}</a>`));
  }
  return ctx.send(ctx.msg.chat.id, lines.join('\n'), { reply_markup: ctx.MAIN_KEYBOARD });
};
