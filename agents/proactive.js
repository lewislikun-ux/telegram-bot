function currentSgParts() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { date, time: `${hh}:${mm}`, day: now.getDay() };
}

function makeSyntheticMsg(user) {
  return {
    chat: { id: user.chat_id },
    from: {
      id: user.telegram_user_id,
      first_name: user.first_name || 'there',
      username: user.username || null
    }
  };
}

function start({ supabase, makeContext, registry }) {
  if (String(process.env.ENABLE_PROACTIVE_AGENTS || 'true').toLowerCase() === 'false') return;
  const gmTime = process.env.GM_SEND_TIME_SGT || '07:30';
  const phvTime = process.env.PHV_ALERT_TIME_SGT || '17:30';
  const sent = new Set();

  setInterval(async () => {
    const { date, time } = currentSgParts();
    if (![gmTime, phvTime].includes(time)) return;
    const key = `${date}:${time}`;
    if (sent.has(key)) return;
    sent.add(key);
    try {
      const { data: users, error } = await supabase.from('users').select('telegram_user_id, chat_id, first_name, username');
      if (error) throw error;
      for (const user of users || []) {
        const msg = makeSyntheticMsg(user);
        const ctx = makeContext(msg);
        if (time === gmTime) await registry.invoke('gm', ctx, '');
        if (time === phvTime) await registry.invoke('drive', ctx, '');
      }
    } catch (err) {
      console.error('Proactive agent tick failed:', err.message);
    }
  }, 60 * 1000);
}

module.exports = { start };
