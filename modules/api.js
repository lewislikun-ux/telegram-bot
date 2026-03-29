const axios = require('axios');
const { SimpleCache } = require('./cache');

const cache = new SimpleCache();

function stripHtml(text = '') {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXml(text = '') {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRssItems(xml, limit = 10) {
  const items = [];
  const matches = [...String(xml || '').matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  for (const match of matches) {
    const itemXml = match[0];
    const title = decodeXml(itemXml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const link = decodeXml(itemXml.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
    const pubDate = decodeXml(itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '').trim();
    const description = stripHtml(decodeXml(itemXml.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || ''));
    if (title && link) items.push({ title, link, pubDate, summary: description });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 TelegramBot/1.0',
      'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
    },
    maxRedirects: 5
  });
  return String(response.data || '');
}

const NEWS_SOURCES = {
  top: [
    'https://www.channelnewsasia.com/rss',
    'https://feeds.bbci.co.uk/news/rss.xml'
  ],
  singapore: [
    'https://www.channelnewsasia.com/rssfeeds/8395986',
    'https://www.channelnewsasia.com/rss'
  ],
  business: [
    'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936',
    'https://feeds.bbci.co.uk/news/business/rss.xml'
  ],
  world: [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.channelnewsasia.com/rss'
  ]
};

async function fetchNews(category = 'top', limit = 8) {
  const key = `news:${category}:${limit}`;
  return cache.getOrSet(key, 10 * 60 * 1000, async () => {
    const urls = NEWS_SOURCES[category] || NEWS_SOURCES.top;
    for (const url of urls) {
      try {
        const xml = await fetchText(url);
        const items = parseRssItems(xml, limit);
        if (items.length) return items;
      } catch (err) {
        console.error('News source failed:', url, err.message);
      }
    }
    return [];
  });
}

async function fetchWeather(areaHint = 'Punggol') {
  return cache.getOrSet(`weather:${areaHint}`, 15 * 60 * 1000, async () => {
    const { data } = await axios.get('https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast', { timeout: 15000 });
    const areas = data?.data?.items?.[0]?.forecasts || data?.items?.[0]?.forecasts || [];
    const wanted = String(areaHint || '').toLowerCase();
    let best = areas.find((x) => String(x.area || '').toLowerCase() === wanted)
      || areas.find((x) => String(x.area || '').toLowerCase().includes(wanted))
      || areas.find((x) => String(x.area || '').toLowerCase().includes('punggol'))
      || areas[0]
      || null;
    return best ? { area: best.area, forecast: best.forecast } : null;
  });
}

async function fetchTaxiAvailability() {
  return cache.getOrSet('taxiAvailability', 5 * 60 * 1000, async () => {
    const { data } = await axios.get('https://api-open.data.gov.sg/v2/real-time/api/taxi-availability', { timeout: 15000 });
    const item = data?.data?.items?.[0] || data?.items?.[0] || null;
    const coordinates = item?.taxi_count ?? item?.features?.length ?? null;
    return { taxiCount: coordinates || 0, timestamp: item?.timestamp || null };
  });
}

async function fetchTrafficImages(limit = 3) {
  return cache.getOrSet(`trafficImages:${limit}`, 10 * 60 * 1000, async () => {
    const { data } = await axios.get('https://api-open.data.gov.sg/v2/real-time/api/traffic-images', { timeout: 15000 });
    const cameras = data?.data?.items?.[0]?.cameras || data?.items?.[0]?.cameras || [];
    return cameras.slice(0, limit).map((x) => ({ image: x.image, cameraId: x.camera_id || x.cameraId, timestamp: x.timestamp }));
  });
}

async function fetchFx(base = 'USD', symbols = ['SGD', 'MYR']) {
  const key = `fx:${base}:${symbols.join(',')}`;
  return cache.getOrSet(key, 60 * 60 * 1000, async () => {
    const url = `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbols.join(','))}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data?.rates || {};
  });
}

async function fetchCrypto(ids = ['bitcoin', 'ethereum']) {
  const key = `crypto:${ids.join(',')}`;
  return cache.getOrSet(key, 5 * 60 * 1000, async () => {
    if (!process.env.COINGECKO_DEMO_API_KEY) return [];
    const { data } = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      timeout: 15000,
      params: {
        vs_currency: 'usd',
        ids: ids.join(','),
        price_change_percentage: '24h'
      },
      headers: { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_API_KEY }
    });
    return (data || []).map((x) => ({
      id: x.id,
      symbol: x.symbol,
      name: x.name,
      current_price: x.current_price,
      change_24h: x.price_change_percentage_24h
    }));
  });
}

module.exports = {
  fetchNews,
  fetchWeather,
  fetchTaxiAvailability,
  fetchTrafficImages,
  fetchFx,
  fetchCrypto,
  parseRssItems,
  stripHtml
};
