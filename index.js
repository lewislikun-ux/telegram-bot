require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PORT = 10000,
} = process.env;

const missing = [
  'TELEGRAM_BOT_TOKEN',
  'WEBHOOK_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
].filter((k) => !process.env[k]);

if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nowIso() {
  return new Date().toISOString();
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateTimeInput(input) {
  const trimmed = String(input || '').trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?$/);
  if (!match) return null;
  const datePart = match[1];
  const timePart = match[2] || '09:00';
  const iso = new Date(`${datePart}T${timePart}:00`);
  if (Number.isNaN(iso.getTime())) return null;
  return { date: datePart, time: timePart, iso: iso.toISOString() };
}

function addMonths(date, count) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + count);
  return d;
}

function addYears(date, count) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + count);
  return d;
}

function computeNextDueDate(baseDate, recurrence) {
  const d = new Date(baseDate);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!recurrence || recurrence === 'none') return d;

  while (d < today) {
    if (recurrence === 'monthly') {
      d.setMonth(d.getMonth() + 1);
    } else if (recurrence === 'yearly') {
      d.setFullYear(d.getFullYear() + 1);
    } else {
      break;
    }
  }
  return d;
}

function formatDate(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue || '');
  return d.toISOString().slice(0, 10);
}

function parseAdminAdd(text) {
  const parts = text.split('|').map((s) => s.trim());
  if (parts.length < 3) return null;

  const title = parts[0];
  const dueDate = parts[1];
  const recurrence = (parts[2] || 'none').toLowerCase();
  const leadDaysRaw = parts[3] || '7,1';

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  if (!['none', 'monthly', 'yearly'].includes(recurrence)) return null;

  const leadDays = leadDaysRaw
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, 10);

  return {
    title,
    dueDate,
    recurrence,
    leadDays: leadDays.length ? leadDays : [7, 1],
  };
}

function dueInDays(dateString) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateString);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

async function ensureUser(msg) {
  const user = msg.from || {};
  const chatId = msg.chat.id;
  const payload = {
    telegram_user_id: user.id,
    chat_id: chatId,
    username: user.username || null,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    updated_at: nowIso(),
  };

  const { error } = await supabase
    .from('users')
    .upsert(payload, { onConflict: 'telegram_user_id' });

  if (error) {
    console.error('ensureUser error', error);
  }
}

async function send(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

async function showHelp(chatId) {
  const helpText = [
    '<b>Phase 1 Bot Commands</b>',
    '',
    '<b>Notes / tasks</b>',
    '/note your text',
    '/task your task',
    '/done keyword',
    '',
    '<b>Reminders</b>',
    '/remind YYYY-MM-DD HH:MM | message',
    'Example: /remind 2026-04-02 09:00 | renew road tax',
    '',
    '<b>Admin items</b>',
    '/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1',
    'Example: /adminadd car insurance | 2026-07-10 | yearly | 30,7,1',
    '/due',
    '',
    '<b>Search / summary</b>',
    '/search keyword',
    '/weekly',
    '/menu',
  ].join('\n');

  await send(chatId, helpText);
}

async function getOpenTasks(userId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) throw error;
  return data || [];
}

async function getDueItems(userId) {
  const today = todayDateString();

  const [{ data: reminders, error: rErr }, { data: adminItems, error: aErr }] = await Promise.all([
    supabase
      .from('reminders')
      .select('*')
      .eq('telegram_user_id', userId)
      .eq('status', 'open')
      .lte('remind_at', `${today}T23:59:59.999Z`)
      .order('remind_at', { ascending: true })
      .limit(20),
    supabase
      .from('admin_items')
      .select('*')
      .eq('telegram_user_id', userId)
      .order('next_due_date', { ascending: true })
      .limit(20),
  ]);

  if (rErr) throw rErr;
  if (aErr) throw aErr;

  const dueAdmin = (adminItems || []).filter((item) => dueInDays(item.next_due_date) <= Math.max(...(item.lead_days || [7])));

  return { reminders: reminders || [], adminItems: dueAdmin };
}

async function handleStart(msg) {
  await ensureUser(msg);
  const name = escapeHtml(msg.from.first_name || 'there');
  await send(
    msg.chat.id,
    `Hello ${name}.\n\nThis is your <b>Phase 1 personal ops bot</b>.\nUse /help to see commands.`
  );
}

async function handleNote(msg, body) {
  if (!body) return send(msg.chat.id, 'Use: <code>/note your text</code>');
  await ensureUser(msg);

  const { error } = await supabase.from('notes').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    note_type: 'note',
    content: body,
    created_at: nowIso(),
  });

  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not save note.');
  }

  await send(msg.chat.id, `Saved note:\n<blockquote>${escapeHtml(body)}</blockquote>`);
}

async function handleTask(msg, body) {
  if (!body) return send(msg.chat.id, 'Use: <code>/task your task</code>');
  await ensureUser(msg);

  const { error } = await supabase.from('tasks').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    content: body,
    status: 'open',
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not save task.');
  }

  await send(msg.chat.id, `Saved task:\n<blockquote>${escapeHtml(body)}</blockquote>`);
}

async function handleDone(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/done keyword</code>');
  await ensureUser(msg);

  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('telegram_user_id', msg.from.id)
    .eq('status', 'open')
    .ilike('content', `%${keyword}%`)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not search tasks.');
  }

  const task = data?.[0];
  if (!task) return send(msg.chat.id, 'No open task matched that keyword.');

  const { error: updateErr } = await supabase
    .from('tasks')
    .update({ status: 'done', updated_at: nowIso(), completed_at: nowIso() })
    .eq('id', task.id);

  if (updateErr) {
    console.error(updateErr);
    return send(msg.chat.id, 'Could not mark task done.');
  }

  await send(msg.chat.id, `Marked done:\n<blockquote>${escapeHtml(task.content)}</blockquote>`);
}

async function handleRemind(msg, body) {
  if (!body || !body.includes('|')) {
    return send(msg.chat.id, 'Use: <code>/remind YYYY-MM-DD HH:MM | message</code>');
  }
  await ensureUser(msg);

  const [left, ...rest] = body.split('|');
  const datePart = parseDateTimeInput(left.trim());
  const reminderText = rest.join('|').trim();

  if (!datePart || !reminderText) {
    return send(msg.chat.id, 'Could not read that reminder. Example: <code>/remind 2026-04-02 09:00 | renew road tax</code>');
  }

  const { error } = await supabase.from('reminders').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    content: reminderText,
    remind_at: datePart.iso,
    status: 'open',
    created_at: nowIso(),
  });

  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not save reminder.');
  }

  await send(
    msg.chat.id,
    `Saved reminder for <b>${escapeHtml(datePart.date)} ${escapeHtml(datePart.time)}</b>:\n<blockquote>${escapeHtml(reminderText)}</blockquote>\n\nUse <code>/due</code> to check due items.`
  );
}

async function handleAdminAdd(msg, body) {
  const parsed = parseAdminAdd(body);
  if (!parsed) {
    return send(msg.chat.id, 'Use: <code>/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1</code>');
  }
  await ensureUser(msg);

  const nextDue = computeNextDueDate(parsed.dueDate, parsed.recurrence);
  if (!nextDue) return send(msg.chat.id, 'Could not compute the due date.');

  const { error } = await supabase.from('admin_items').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    title: parsed.title,
    base_due_date: parsed.dueDate,
    next_due_date: formatDate(nextDue),
    recurrence: parsed.recurrence,
    lead_days: parsed.leadDays,
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not save admin item.');
  }

  await send(
    msg.chat.id,
    `Saved admin item:\n<b>${escapeHtml(parsed.title)}</b>\nDue: <b>${escapeHtml(formatDate(nextDue))}</b>\nRecurrence: <b>${escapeHtml(parsed.recurrence)}</b>\nLead days: <b>${escapeHtml(parsed.leadDays.join(', '))}</b>`
  );
}

async function handleDue(msg) {
  await ensureUser(msg);
  try {
    const { reminders, adminItems } = await getDueItems(msg.from.id);

    if (!reminders.length && !adminItems.length) {
      return send(msg.chat.id, 'Nothing due right now.');
    }

    const lines = ['<b>Due items</b>', ''];

    if (reminders.length) {
      lines.push('<b>Reminders</b>');
      reminders.forEach((r) => {
        lines.push(`• ${escapeHtml(formatDate(r.remind_at))} — ${escapeHtml(r.content)}`);
      });
      lines.push('');
    }

    if (adminItems.length) {
      lines.push('<b>Admin items</b>');
      adminItems.forEach((a) => {
        const days = dueInDays(a.next_due_date);
        const label = days < 0 ? `${Math.abs(days)} day(s) overdue` : days === 0 ? 'due today' : `due in ${days} day(s)`;
        lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)} (${escapeHtml(label)})`);
      });
    }

    await send(msg.chat.id, lines.join('\n'));
  } catch (error) {
    console.error(error);
    await send(msg.chat.id, 'Could not load due items.');
  }
}

async function handleSearch(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/search keyword</code>');
  await ensureUser(msg);

  const [notesRes, tasksRes, remindersRes, adminRes] = await Promise.all([
    supabase
      .from('notes')
      .select('*')
      .eq('telegram_user_id', msg.from.id)
      .ilike('content', `%${keyword}%`)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('tasks')
      .select('*')
      .eq('telegram_user_id', msg.from.id)
      .ilike('content', `%${keyword}%`)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('reminders')
      .select('*')
      .eq('telegram_user_id', msg.from.id)
      .ilike('content', `%${keyword}%`)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('admin_items')
      .select('*')
      .eq('telegram_user_id', msg.from.id)
      .ilike('title', `%${keyword}%`)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const errors = [notesRes.error, tasksRes.error, remindersRes.error, adminRes.error].filter(Boolean);
  if (errors.length) {
    console.error(errors);
    return send(msg.chat.id, 'Search failed.');
  }

  const lines = [`<b>Search results for:</b> ${escapeHtml(keyword)}`, ''];

  if (notesRes.data?.length) {
    lines.push('<b>Notes</b>');
    notesRes.data.forEach((n) => lines.push(`• ${escapeHtml(n.content)}`));
    lines.push('');
  }
  if (tasksRes.data?.length) {
    lines.push('<b>Tasks</b>');
    tasksRes.data.forEach((t) => lines.push(`• [${escapeHtml(t.status)}] ${escapeHtml(t.content)}`));
    lines.push('');
  }
  if (remindersRes.data?.length) {
    lines.push('<b>Reminders</b>');
    remindersRes.data.forEach((r) => lines.push(`• ${escapeHtml(formatDate(r.remind_at))} — ${escapeHtml(r.content)}`));
    lines.push('');
  }
  if (adminRes.data?.length) {
    lines.push('<b>Admin items</b>');
    adminRes.data.forEach((a) => lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)}`));
  }

  if (lines.length <= 2) {
    return send(msg.chat.id, 'No matches found.');
  }

  await send(msg.chat.id, lines.join('\n'));
}

async function handleWeekly(msg) {
  await ensureUser(msg);
  const userId = msg.from.id;
  const today = todayDateString();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenIso = sevenDaysAgo.toISOString();

  const [notesRes, tasksRes, dueData, openTasks] = await Promise.all([
    supabase
      .from('notes')
      .select('id', { count: 'exact', head: true })
      .eq('telegram_user_id', userId)
      .gte('created_at', sevenIso),
    supabase
      .from('tasks')
      .select('*')
      .eq('telegram_user_id', userId)
      .gte('created_at', sevenIso),
    getDueItems(userId),
    getOpenTasks(userId),
  ]);

  if (notesRes.error || tasksRes.error) {
    console.error(notesRes.error || tasksRes.error);
    return send(msg.chat.id, 'Could not create weekly summary.');
  }

  const tasks = tasksRes.data || [];
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const openCount = tasks.filter((t) => t.status === 'open').length;

  const lines = [
    '<b>Weekly summary</b>',
    `Date: <b>${escapeHtml(today)}</b>`,
    '',
    `<b>Captured this week</b>`,
    `• Notes: ${notesRes.count || 0}`,
    `• Tasks created: ${tasks.length}`,
    `• Tasks completed: ${doneCount}`,
    `• Tasks still open from this week: ${openCount}`,
    '',
    `<b>Due now</b>`,
    `• Reminders due: ${dueData.reminders.length}`,
    `• Admin items due / upcoming: ${dueData.adminItems.length}`,
    '',
    '<b>Top open tasks</b>',
  ];

  if (openTasks.length) {
    openTasks.slice(0, 5).forEach((t) => lines.push(`• ${escapeHtml(t.content)}`));
  } else {
    lines.push('• None');
  }

  lines.push('', '<b>Suggested next action</b>');
  if (dueData.reminders.length || dueData.adminItems.length) {
    lines.push('• Run through your due items first. Use /due');
  } else if (openTasks.length) {
    lines.push('• Clear one open task today.');
  } else {
    lines.push('• Capture anything new with /note or /task');
  }

  await send(msg.chat.id, lines.join('\n'));
}

async function routeMessage(msg) {
  if (!msg.text) return;
  const text = msg.text.trim();
  const [command, ...rest] = text.split(' ');
  const body = rest.join(' ').trim();

  switch (command.toLowerCase()) {
    case '/start':
      return handleStart(msg);
    case '/help':
    case '/menu':
      return showHelp(msg.chat.id);
    case '/note':
      return handleNote(msg, body);
    case '/task':
      return handleTask(msg, body);
    case '/done':
      return handleDone(msg, body);
    case '/remind':
      return handleRemind(msg, body);
    case '/adminadd':
      return handleAdminAdd(msg, body);
    case '/due':
      return handleDue(msg);
    case '/search':
      return handleSearch(msg, body);
    case '/weekly':
      return handleWeekly(msg);
    default:
      return send(msg.chat.id, 'Unknown command. Use /help');
  }
}

app.get('/', (_req, res) => {
  res.status(200).send('Bot is running.');
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook route error', error);
    res.sendStatus(500);
  }
});

bot.on('message', async (msg) => {
  try {
    await routeMessage(msg);
  } catch (error) {
    console.error('Message handler error', error);
    try {
      await send(msg.chat.id, 'Something went wrong.');
    } catch (inner) {
      console.error('Fallback send error', inner);
    }
  }
});

async function start() {
  await bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('Startup error', error);
  process.exit(1);
});
