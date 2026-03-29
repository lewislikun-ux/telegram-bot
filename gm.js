const { fetchFx } = require('../modules/api');

module.exports = async function fxAgent(ctx) {
  const fx = await fetchFx('USD', ['SGD', 'MYR']).catch(() => ({}));
  const lines = ['<b>FX</b>', `• USD/SGD: <b>${ctx.escapeHtml(String(fx.SGD || '-'))}</b>`, `• USD/MYR: <b>${ctx.escapeHtml(String(fx.MYR || '-'))}</b>`];
  return ctx.send(ctx.msg.chat.id, lines.join('\n'), { reply_markup: ctx.MAIN_KEYBOARD });
};
