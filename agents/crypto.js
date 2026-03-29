const { fetchCrypto } = require('../modules/api');

module.exports = async function cryptoAgent(ctx) {
  const coins = await fetchCrypto(['bitcoin', 'ethereum']).catch(() => []);
  const lines = ['<b>Crypto</b>'];
  if (!process.env.COINGECKO_DEMO_API_KEY) {
    lines.push('Add <code>COINGECKO_DEMO_API_KEY</code> to enable free crypto quotes.');
  } else if (!coins.length) {
    lines.push('Crypto data is unavailable right now.');
  } else {
    coins.forEach((coin) => lines.push(`• ${ctx.escapeHtml(coin.name)} (${ctx.escapeHtml(coin.symbol.toUpperCase())}): <b>$${Number(coin.current_price).toLocaleString()}</b> (${Number(coin.change_24h || 0).toFixed(2)}%)`));
  }
  return ctx.send(ctx.msg.chat.id, lines.join('\n'), { reply_markup: ctx.MAIN_KEYBOARD });
};
