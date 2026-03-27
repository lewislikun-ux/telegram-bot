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

const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '➕ Note', callback_data: 'hint:note' },
      { text: '✅ Task', callback_data: 'hint:task' },
    ],
    [
      { text: '📅 Due', callback_data: 'show:due' },
      { text: '🗓 Weekly', callback_data: 'show:weekly' },
    ],
    [
      { text: '🚗 PHV Today', callback_data: 'show:phvtoday' },
      { text: '🧠 Decide', callback_data: 'hint:decide' },
    ],
    [
      { text: '⛽ PHV Settings', callback_data: 'show:phvsettings' },
    ],
  ],
};

const pendingPhvSettingInputs = new Map();

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nowIso() {
  return new Date().toISOString();
}

function toLocalDate(date = new Date()) {
  const offsetMs = 8 * 60 * 60 * 1000;
  return new Date(date.getTime() + offsetMs);
}

function todayDateString() {
  return toLocalDate().toISOString().slice(0, 10);
}

function startOfLocalDayIso(daysOffset = 0) {
  const d = toLocalDate();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return new Date(d.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function parseDateTimeInput(input) {
  const trimmed = String(input || '').trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?$/);
  if (!match) return null;
  const datePart = match[1];
  const timePart = match[2] || '09:00';
  const iso = new Date(`${datePart}T${timePart}:00+08:00`);
  if (Number.isNaN(iso.getTime())) return null;
  return { date: datePart, time: timePart, iso: iso.toISOString() };
}

function formatDate(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue || '');
  return toLocalDate(d).toISOString().slice(0, 10);
}

function formatDateTime(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue || '');
  const local = toLocalDate(d);
  return `${local.toISOString().slice(0, 10)} ${local.toISOString().slice(11, 16)}`;
}

function dueInDays(dateString) {
  const today = new Date(`${todayDateString()}T00:00:00+08:00`);
  const due = new Date(`${String(dateString).slice(0, 10)}T00:00:00+08:00`);
  return Math.round((due - today) / 86400000);
}

function addMonths(dateString, count) {
  const d = new Date(`${String(dateString).slice(0, 10)}T12:00:00+08:00`);
  d.setMonth(d.getMonth() + count);
  return d.toISOString().slice(0, 10);
}

function addYears(dateString, count) {
  const d = new Date(`${String(dateString).slice(0, 10)}T12:00:00+08:00`);
  d.setFullYear(d.getFullYear() + count);
  return d.toISOString().slice(0, 10);
}

function computeNextDueDate(baseDate, recurrence) {
  let next = String(baseDate).slice(0, 10);
  const today = todayDateString();
  if (!recurrence || recurrence === 'none') return next;

  while (next < today) {
    if (recurrence === 'monthly') next = addMonths(next, 1);
    else if (recurrence === 'yearly') next = addYears(next, 1);
    else break;
  }
  return next;
}

function computeFollowingDueDate(currentDueDate, recurrence) {
  if (recurrence === 'monthly') return addMonths(currentDueDate, 1);
  if (recurrence === 'yearly') return addYears(currentDueDate, 1);
  return currentDueDate;
}

function humanDueLabel(days) {
  if (days < 0) return `${Math.abs(days)} day(s) overdue`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} day(s)`;
}

function parseAdminAdd(text) {
  const parts = String(text || '').split('|').map((s) => s.trim());
  if (parts.length < 3) return null;

  const title = parts[0];
  const dueDate = parts[1];
  const recurrence = (parts[2] || 'none').toLowerCase();
  const leadDaysRaw = parts[3] || '7,1';

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  if (!['none', 'monthly', 'yearly'].includes(recurrence)) return null;

  let leadDays = [];
  if (leadDaysRaw.toLowerCase() !== 'none') {
    leadDays = leadDaysRaw
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .slice(0, 10);
  }

  return {
    title,
    dueDate,
    recurrence,
    leadDays,
  };
}

function parsePhvBody(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  const result = {};

  for (const part of parts) {
    const m = part.match(/^(date|gross|hours|km|petrol|trip|notes?)\s*[:=]?\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    result[key] = value;
  }

  const date = result.date || todayDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const gross = parseFloat(result.gross || '');
  const hours = parseFloat(result.hours || '');
  const km = parseFloat(result.km || '');
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : null;
  const tripCount = result.trip !== undefined ? parseInt(result.trip, 10) : null;
  const notes = result.note || result.notes || null;

  if (!Number.isFinite(gross) || !Number.isFinite(hours)) return null;

  return {
    log_date: date,
    gross_amount: gross,
    hours_worked: hours,
    km_driven: Number.isFinite(km) ? km : null,
    petrol_cost: Number.isFinite(petrol) ? petrol : null,
    trip_count: Number.isInteger(tripCount) ? tripCount : null,
    notes,
  };
}

function currency(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  return `$${Number(n).toFixed(2)}`;
}


async function getOrCreatePhvSettings(msgOrUser) {
  const telegramUserId = msgOrUser.from ? msgOrUser.from.id : msgOrUser.telegram_user_id;
  const chatId = msgOrUser.chat ? msgOrUser.chat.id : msgOrUser.chat_id;

  const { data: existing, error } = await supabase
    .from('phv_settings')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (existing) return existing;

  const defaults = {
    telegram_user_id: telegramUserId,
    chat_id: chatId,
    mode: 'simple',
    fuel_consumption_kmpl: 15.3,
    petrol_price_per_litre: 3.46,
    discount_percent: 27,
    fixed_rebate: 3,
    rebate_threshold: 60,
    cost_per_km_override: 0.16,
    updated_at: nowIso(),
  };

  const { data: created, error: insertErr } = await supabase
    .from('phv_settings')
    .upsert(defaults, { onConflict: 'telegram_user_id' })
    .select('*')
    .single();

  if (insertErr) throw insertErr;
  return created;
}

function calculateEffectivePetrolPrice(settings) {
  const basePrice = Number(settings.petrol_price_per_litre || 0);
  const discountPercent = Number(settings.discount_percent || 0);
  const fixedRebate = Number(settings.fixed_rebate || 0);
  const rebateThreshold = Number(settings.rebate_threshold || 0);
  if (!(basePrice > 0)) return 0;

  const discountedPrice = basePrice * (1 - (discountPercent / 100));
  if (!(fixedRebate > 0) || !(rebateThreshold > 0) || !(basePrice > 0)) return discountedPrice;

  const litresAtThreshold = rebateThreshold / basePrice;
  if (!(litresAtThreshold > 0)) return discountedPrice;
  const discountedTotal = discountedPrice * litresAtThreshold;
  const finalTotal = Math.max(discountedTotal - fixedRebate, 0);
  return finalTotal / litresAtThreshold;
}

function calculateAutoCostPerKm(settings) {
  const kmpl = Number(settings.fuel_consumption_kmpl || 0);
  if (!(kmpl > 0)) return 0;
  const effectivePrice = calculateEffectivePetrolPrice(settings);
  return effectivePrice / kmpl;
}

function calculatePhvPetrolCost(kmDriven, settings) {
  const km = Number(kmDriven || 0);
  if (!(km > 0)) return null;
  const mode = String(settings.mode || 'simple');
  let costPerKm = null;

  if (mode === 'simple') {
    const override = Number(settings.cost_per_km_override || 0);
    costPerKm = override > 0 ? override : calculateAutoCostPerKm(settings);
  } else {
    costPerKm = calculateAutoCostPerKm(settings);
  }

  if (!(costPerKm > 0)) return null;
  return Number((km * costPerKm).toFixed(2));
}

function phvSettingsText(settings) {
  const effectivePrice = calculateEffectivePetrolPrice(settings);
  const autoCostKm = calculateAutoCostPerKm(settings);
  const modeLabel = settings.mode === 'auto' ? 'Auto calculation' : 'Simple fixed cost/km';
  return [
    '<b>PHV settings</b>',
    `Mode: <b>${escapeHtml(modeLabel)}</b>`,
    '',
    `Fuel consumption: <b>${escapeHtml(Number(settings.fuel_consumption_kmpl || 0).toFixed(2))} km/L</b>`,
    `Petrol price: <b>${escapeHtml(currency(settings.petrol_price_per_litre))}/L</b>`,
    `Discount: <b>${escapeHtml(String(Number(settings.discount_percent || 0).toFixed(2)))}%</b>`,
    `Fixed rebate: <b>${escapeHtml(currency(settings.fixed_rebate))}</b> off <b>${escapeHtml(currency(settings.rebate_threshold))}</b>`,
    `Effective petrol price: <b>${escapeHtml(currency(effectivePrice))}/L</b>`,
    `Auto cost/km: <b>${escapeHtml(currency(autoCostKm))}</b>`,
    `Simple cost/km override: <b>${escapeHtml(currency(settings.cost_per_km_override))}</b>`,
    '',
    'When you log PHV without petrol, the bot auto-fills petrol using the current mode.',
  ].join('\n');
}

function phvSettingsButtons(settings) {
  const modeText = settings.mode === 'auto' ? 'Switch to Simple mode' : 'Switch to Auto mode';
  return {
    inline_keyboard: [
      [
        { text: modeText, callback_data: 'phvset:togglemode' },
      ],
      [
        { text: 'Edit Fuel Consumption', callback_data: 'phvset:edit:fuel_consumption_kmpl' },
        { text: 'Edit Petrol Price', callback_data: 'phvset:edit:petrol_price_per_litre' },
      ],
      [
        { text: 'Edit Discount %', callback_data: 'phvset:edit:discount_percent' },
        { text: 'Edit Rebate', callback_data: 'phvset:edit:fixed_rebate' },
      ],
      [
        { text: 'Edit Rebate Threshold', callback_data: 'phvset:edit:rebate_threshold' },
        { text: 'Edit Cost/km Override', callback_data: 'phvset:edit:cost_per_km_override' },
      ],
      [
        { text: '🔄 Refresh', callback_data: 'show:phvsettings' },
        { text: '➕ Menu', callback_data: 'show:menu' },
      ],
    ],
  };
}

function phvSettingPrompt(field) {
  const prompts = {
    fuel_consumption_kmpl: 'Send the new fuel consumption in km/L. Example: <code>15.3</code>',
    petrol_price_per_litre: 'Send the new petrol price per litre. Example: <code>3.46</code>',
    discount_percent: 'Send the new discount percent. Example: <code>27</code>',
    fixed_rebate: 'Send the fixed rebate amount. Example: <code>3</code>',
    rebate_threshold: 'Send the rebate threshold spend amount. Example: <code>60</code>',
    cost_per_km_override: 'Send the simple cost per km override. Example: <code>0.16</code>',
  };
  return prompts[field] || 'Send the new numeric value.';
}


function phvComputed(log) {
  const gross = Number(log.gross_amount || 0);
  const petrol = Number(log.petrol_cost || 0);
  const hours = Number(log.hours_worked || 0);
  const net = gross - petrol;
  const hourlyGross = hours > 0 ? gross / hours : 0;
  const hourlyNet = hours > 0 ? net / hours : 0;
  return { net, hourlyGross, hourlyNet };
}

function buildDecisionAdvice(input) {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  const amountMatches = [...lower.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const amount = amountMatches[0] || null;
  const urgencyWords = ['urgent', 'today', 'asap', 'immediately', 'now'];
  const delayWords = ['wait', 'delay', 'later', 'hold'];
  const repairWords = ['repair', 'service', 'tyre', 'tire', 'insurance', 'renew', 'road tax', 'maintenance'];
  const investWords = ['invest', 'etf', 'vwra', 'ssb', 'stocks', 'buy'];
  const restWords = ['rest', 'sleep', 'fatigue', 'tired'];

  let recommendation = 'Lean toward doing the lower-risk option first.';
  let risk = 'medium';
  const reasons = [];
  const actions = [];

  if (repairWords.some((w) => lower.includes(w))) {
    recommendation = 'If this affects safety, legality, or insurance coverage, do it now instead of delaying.';
    risk = 'medium-high';
    reasons.push('Delaying maintenance or renewals can become more expensive or risky later.');
    actions.push('Check exact due date or service threshold.', 'If cash is tight, prioritize the safety-critical item first.');
  }

  if (investWords.some((w) => lower.includes(w))) {
    recommendation = 'Only proceed if your near-term cash needs and emergency buffer are already covered.';
    risk = 'medium';
    reasons.push('Investing while cash is tight can force you to sell or stop at the wrong time.');
    actions.push('Set a fixed monthly amount you can sustain.', 'Keep enough cash for bills due soon.');
  }

  if (restWords.some((w) => lower.includes(w))) {
    recommendation = 'Protect sleep and recovery first if the choice affects safety or work quality.';
    risk = 'high';
    reasons.push('Fatigue affects driving performance, judgment, and consistency.');
    actions.push('Cut lower-value tasks today.', 'Reassess after proper rest.');
  }

  if (delayWords.some((w) => lower.includes(w)) && !repairWords.some((w) => lower.includes(w))) {
    reasons.push('Waiting can be sensible if the downside of delay is low and cash preservation matters.');
  }

  if (urgencyWords.some((w) => lower.includes(w))) {
    reasons.push('Your wording suggests a time-sensitive decision.');
  }

  if (amount !== null) {
    if (amount >= 1000) {
      reasons.push('This is a meaningful amount, so cashflow impact matters.');
      actions.push('Check whether this amount conflicts with other bills due within 30 days.');
    } else {
      reasons.push('The amount is manageable, so convenience and risk reduction may matter more than perfect optimization.');
    }
  }

  if (!reasons.length) {
    reasons.push('Start with the option that reduces downside and keeps future choices open.');
  }
  if (!actions.length) {
    actions.push('Clarify the downside of waiting 7–30 days.', 'Choose the option you can sustain repeatedly, not just once.');
  }

  return { recommendation, risk, reasons: reasons.slice(0, 3), actions: actions.slice(0, 3) };
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

  if (error) console.error('ensureUser error', error);
}

async function send(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

async function editOrSend(chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options,
    });
  } catch (_err) {
    return send(chatId, text, options);
  }
}

async function answerCallback(callbackQueryId, text) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, text ? { text } : {});
  } catch (error) {
    console.error('answerCallback error', error);
  }
}

async function showHelp(chatId) {
  const helpText = [
    '<b>Personal Ops Bot — Phase 2 browser build</b>',
    '',
    '<b>Main commands</b>',
    '/note your text',
    '/task your task',
    '/done keyword',
    '/remind YYYY-MM-DD HH:MM | message',
    '/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1',
    '/admindone keyword',
    '/due',
    '/search keyword',
    '/weekly',
    '',
    '<b>Phase 2</b>',
    '/phvlog date:2026-03-27 | gross:145 | hours:2.5 | km:68 | petrol:18',
    '/phvtoday',
    '/phvweek',
    '/phvsettings',
    '/decide your question',
    '',
    '<b>Natural language examples</b>',
    'note: check tyre pressure',
    'task: renew road tax',
    'idea: add mileage reminders',
    'done: renew road tax',
    'due',
    'weekly',
    'decide: should I service now or wait 1 month?',
  ].join('\n');

  await send(chatId, helpText, { reply_markup: MAIN_KEYBOARD });
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
  const todayEndIso = startOfLocalDayIso(1);

  const [{ data: reminders, error: rErr }, { data: adminItems, error: aErr }] = await Promise.all([
    supabase
      .from('reminders')
      .select('*')
      .eq('telegram_user_id', userId)
      .eq('status', 'open')
      .lt('remind_at', todayEndIso)
      .order('remind_at', { ascending: true })
      .limit(20),
    supabase
      .from('admin_items')
      .select('*')
      .eq('telegram_user_id', userId)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true })
      .limit(50),
  ]);

  if (rErr) throw rErr;
  if (aErr) throw aErr;

  const dueAdmin = (adminItems || []).filter((item) => {
    const leadDays = item.lead_days || [];
    if (!leadDays.length) return dueInDays(item.next_due_date) <= 0;
    return dueInDays(item.next_due_date) <= Math.max(...leadDays);
  });

  return { reminders: reminders || [], adminItems: dueAdmin, allAdminItems: adminItems || [] };
}

async function saveNote(msg, content, noteType = 'note') {
  const { error } = await supabase.from('notes').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    note_type: noteType,
    content,
    created_at: nowIso(),
  });
  if (error) throw error;
}

async function handleStart(msg) {
  await ensureUser(msg);
  const name = escapeHtml(msg.from.first_name || 'there');
  await send(
    msg.chat.id,
    `Hello ${name}.\n\nThis is your <b>browser-only personal ops bot</b>.\nTap a button or use /help.`,
    { reply_markup: MAIN_KEYBOARD }
  );
}

async function handleNote(msg, body, noteType = 'note') {
  if (!body) return send(msg.chat.id, 'Use: <code>/note your text</code>');
  await ensureUser(msg);
  try {
    await saveNote(msg, body, noteType);
    await send(msg.chat.id, `Saved ${escapeHtml(noteType)}:\n<blockquote>${escapeHtml(body)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
  } catch (error) {
    console.error(error);
    await send(msg.chat.id, `Could not save ${escapeHtml(noteType)}.`);
  }
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

  await send(msg.chat.id, `Saved task:\n<blockquote>${escapeHtml(body)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
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

  await send(msg.chat.id, `Marked done:\n<blockquote>${escapeHtml(task.content)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
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
    `Saved reminder for <b>${escapeHtml(datePart.date)} ${escapeHtml(datePart.time)}</b>:\n<blockquote>${escapeHtml(reminderText)}</blockquote>`,
    { reply_markup: MAIN_KEYBOARD }
  );
}

async function handleAdminAdd(msg, body) {
  const parsed = parseAdminAdd(body);
  if (!parsed) {
    return send(msg.chat.id, 'Use: <code>/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1</code>');
  }
  await ensureUser(msg);

  const nextDue = computeNextDueDate(parsed.dueDate, parsed.recurrence);

  const { error } = await supabase.from('admin_items').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    title: parsed.title,
    base_due_date: parsed.dueDate,
    next_due_date: nextDue,
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

  const leadText = parsed.leadDays.length ? parsed.leadDays.join(', ') : 'none';
  await send(
    msg.chat.id,
    `Saved admin item:\n<b>${escapeHtml(parsed.title)}</b>\nDue: <b>${escapeHtml(nextDue)}</b>\nRecurrence: <b>${escapeHtml(parsed.recurrence)}</b>\nLead days: <b>${escapeHtml(leadText)}</b>`,
    { reply_markup: MAIN_KEYBOARD }
  );
}

async function findAdminItem(userId, keyword) {
  const { data, error } = await supabase
    .from('admin_items')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .ilike('title', `%${keyword}%`)
    .order('next_due_date', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function completeAdminItemByRow(chatId, row) {
  if (!row) return send(chatId, 'Admin item not found.');

  if (row.recurrence === 'none') {
    const { error } = await supabase
      .from('admin_items')
      .update({ is_active: false, updated_at: nowIso() })
      .eq('id', row.id);
    if (error) throw error;
    return send(chatId, `✅ Marked done: <b>${escapeHtml(row.title)}</b>\nNo further reminders for this item.`, { reply_markup: MAIN_KEYBOARD });
  }

  const nextDue = computeFollowingDueDate(row.next_due_date, row.recurrence);
  const { error } = await supabase
    .from('admin_items')
    .update({ base_due_date: nextDue, next_due_date: nextDue, updated_at: nowIso() })
    .eq('id', row.id);
  if (error) throw error;

  return send(chatId, `✅ Marked done: <b>${escapeHtml(row.title)}</b>\nNext due: <b>${escapeHtml(nextDue)}</b>`, { reply_markup: MAIN_KEYBOARD });
}

async function handleAdminDone(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/admindone keyword</code>');
  await ensureUser(msg);
  try {
    const row = await findAdminItem(msg.from.id, keyword);
    if (!row) return send(msg.chat.id, 'No active admin item matched that keyword.');
    return await completeAdminItemByRow(msg.chat.id, row);
  } catch (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not mark admin item done.');
  }
}

function buildDueText(reminders, adminItems) {
  const lines = ['<b>Due overview</b>', ''];

  if (!reminders.length && !adminItems.length) {
    lines.push('✅ Nothing urgent right now.');
    return lines.join('\n');
  }

  if (reminders.length) {
    lines.push('<b>Reminders due</b>');
    reminders.forEach((r) => {
      lines.push(`• ${escapeHtml(formatDateTime(r.remind_at))} — ${escapeHtml(r.content)}`);
    });
    lines.push('');
  }

  if (adminItems.length) {
    const overdue = adminItems.filter((a) => dueInDays(a.next_due_date) < 0);
    const today = adminItems.filter((a) => dueInDays(a.next_due_date) === 0);
    const upcoming = adminItems.filter((a) => dueInDays(a.next_due_date) > 0);

    if (overdue.length) {
      lines.push('<b>Overdue admin items</b>');
      overdue.forEach((a) => lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)} (${escapeHtml(humanDueLabel(dueInDays(a.next_due_date)))})`));
      lines.push('');
    }
    if (today.length) {
      lines.push('<b>Due today</b>');
      today.forEach((a) => lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)}`));
      lines.push('');
    }
    if (upcoming.length) {
      lines.push('<b>Upcoming admin items</b>');
      upcoming.forEach((a) => lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)} (${escapeHtml(humanDueLabel(dueInDays(a.next_due_date)))})`));
    }
  }

  return lines.join('\n').trim();
}

function dueButtons(adminItems) {
  const rows = [];
  adminItems.slice(0, 5).forEach((item) => {
    rows.push([{ text: `✅ Done: ${item.title.slice(0, 20)}`, callback_data: `admindone:${item.id}` }]);
  });
  rows.push([
    { text: '🔄 Refresh due', callback_data: 'show:due' },
    { text: '🗓 Weekly', callback_data: 'show:weekly' },
  ]);
  return { inline_keyboard: rows };
}

async function handleDue(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const { reminders, adminItems } = await getDueItems(msg.from.id);
    const text = buildDueText(reminders, adminItems);
    if (editContext) {
      return editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: dueButtons(adminItems) });
    }
    return send(msg.chat.id, text, { reply_markup: dueButtons(adminItems) });
  } catch (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not load due items.');
  }
}

async function handleSearch(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/search keyword</code>');
  await ensureUser(msg);

  const [notesRes, tasksRes, remindersRes, adminRes, phvRes] = await Promise.all([
    supabase.from('notes').select('*').eq('telegram_user_id', msg.from.id).ilike('content', `%${keyword}%`).order('created_at', { ascending: false }).limit(5),
    supabase.from('tasks').select('*').eq('telegram_user_id', msg.from.id).ilike('content', `%${keyword}%`).order('created_at', { ascending: false }).limit(5),
    supabase.from('reminders').select('*').eq('telegram_user_id', msg.from.id).ilike('content', `%${keyword}%`).order('created_at', { ascending: false }).limit(5),
    supabase.from('admin_items').select('*').eq('telegram_user_id', msg.from.id).ilike('title', `%${keyword}%`).order('created_at', { ascending: false }).limit(5),
    supabase.from('phv_logs').select('*').eq('telegram_user_id', msg.from.id).ilike('notes', `%${keyword}%`).order('log_date', { ascending: false }).limit(5),
  ]);

  const errors = [notesRes.error, tasksRes.error, remindersRes.error, adminRes.error, phvRes.error].filter(Boolean);
  if (errors.length) {
    console.error(errors);
    return send(msg.chat.id, 'Search failed.');
  }

  const lines = [`<b>Search results for:</b> ${escapeHtml(keyword)}`, ''];

  if (notesRes.data?.length) {
    lines.push('<b>Notes</b>');
    notesRes.data.forEach((n) => lines.push(`• [${escapeHtml(n.note_type || 'note')}] ${escapeHtml(n.content)}`));
    lines.push('');
  }
  if (tasksRes.data?.length) {
    lines.push('<b>Tasks</b>');
    tasksRes.data.forEach((t) => lines.push(`• [${escapeHtml(t.status)}] ${escapeHtml(t.content)}`));
    lines.push('');
  }
  if (remindersRes.data?.length) {
    lines.push('<b>Reminders</b>');
    remindersRes.data.forEach((r) => lines.push(`• ${escapeHtml(formatDateTime(r.remind_at))} — ${escapeHtml(r.content)}`));
    lines.push('');
  }
  if (adminRes.data?.length) {
    lines.push('<b>Admin items</b>');
    adminRes.data.forEach((a) => lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)}`));
    lines.push('');
  }
  if (phvRes.data?.length) {
    lines.push('<b>PHV logs</b>');
    phvRes.data.forEach((p) => lines.push(`• ${escapeHtml(p.log_date)} — gross ${escapeHtml(currency(p.gross_amount))}`));
  }

  if (lines.length <= 2) return send(msg.chat.id, 'No matches found.');
  await send(msg.chat.id, lines.join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function getPhvRange(userId, startDate, endDate) {
  const { data, error } = await supabase
    .from('phv_logs')
    .select('*')
    .eq('telegram_user_id', userId)
    .gte('log_date', startDate)
    .lte('log_date', endDate)
    .order('log_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

function summarizePhv(logs) {
  const totals = logs.reduce((acc, log) => {
    const c = phvComputed(log);
    acc.gross += Number(log.gross_amount || 0);
    acc.hours += Number(log.hours_worked || 0);
    acc.petrol += Number(log.petrol_cost || 0);
    acc.km += Number(log.km_driven || 0);
    acc.net += c.net;
    acc.days += 1;
    return acc;
  }, { gross: 0, hours: 0, petrol: 0, km: 0, net: 0, days: 0 });

  totals.hourlyGross = totals.hours > 0 ? totals.gross / totals.hours : 0;
  totals.hourlyNet = totals.hours > 0 ? totals.net / totals.hours : 0;
  return totals;
}


async function handlePhvSettings(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const settings = await getOrCreatePhvSettings(msg);
    const text = phvSettingsText(settings);
    const opts = { reply_markup: phvSettingsButtons(settings) };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, opts) : send(msg.chat.id, text, opts);
  } catch (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not load PHV settings.');
  }
}

async function handlePhvLog(msg, body) {
  const parsed = parsePhvBody(body);
  if (!parsed) {
    return send(msg.chat.id, 'Use: <code>/phvlog date:2026-03-27 | gross:145 | hours:2.5 | km:68 | petrol:18 | notes:airport run</code>');
  }
  await ensureUser(msg);

  let settings = null;
  let autoPetrolUsed = false;
  try {
    settings = await getOrCreatePhvSettings(msg);
  } catch (settingsError) {
    console.error('phv settings load error', settingsError);
  }

  if ((parsed.petrol_cost === null || parsed.petrol_cost === undefined) && parsed.km_driven !== null && settings) {
    const autoPetrol = calculatePhvPetrolCost(parsed.km_driven, settings);
    if (autoPetrol !== null) {
      parsed.petrol_cost = autoPetrol;
      autoPetrolUsed = true;
    }
  }

  const { error } = await supabase.from('phv_logs').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    ...parsed,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  if (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not save PHV log.');
  }

  const c = phvComputed(parsed);
  const lines = [
    '<b>PHV log saved</b>',
    `Date: <b>${escapeHtml(parsed.log_date)}</b>`,
    `Gross: <b>${escapeHtml(currency(parsed.gross_amount))}</b>`,
    `Hours: <b>${escapeHtml(String(parsed.hours_worked))}</b>`,
    `Estimated net: <b>${escapeHtml(currency(c.net))}</b>`,
    `Hourly gross: <b>${escapeHtml(currency(c.hourlyGross))}</b>`,
    `Hourly net: <b>${escapeHtml(currency(c.hourlyNet))}</b>`,
  ];
  if (parsed.km_driven !== null) lines.push(`KM: <b>${escapeHtml(String(parsed.km_driven))}</b>`);
  if (parsed.petrol_cost !== null) lines.push(`Petrol: <b>${escapeHtml(currency(parsed.petrol_cost))}</b>`);
  if (autoPetrolUsed) lines.push(`Petrol source: <b>auto-filled from PHV settings (${escapeHtml(settings.mode || 'simple')} mode)</b>`);

  await send(msg.chat.id, lines.join('\n'), { reply_markup: {
    inline_keyboard: [
      [
        { text: '🚗 PHV Today', callback_data: 'show:phvtoday' },
        { text: '📈 PHV Week', callback_data: 'show:phvweek' },
      ],
    ],
  }});
}

async function handlePhvToday(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const logs = await getPhvRange(msg.from.id, todayDateString(), todayDateString());
    if (!logs.length) {
      const text = 'No PHV logs for today yet.';
      return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
    }
    const s = summarizePhv(logs);
    const lines = [
      '<b>PHV today</b>',
      `Date: <b>${escapeHtml(todayDateString())}</b>`,
      `Trips logged: <b>${logs.length}</b>`,
      `Gross: <b>${escapeHtml(currency(s.gross))}</b>`,
      `Petrol: <b>${escapeHtml(currency(s.petrol))}</b>`,
      `Estimated net: <b>${escapeHtml(currency(s.net))}</b>`,
      `Hours: <b>${escapeHtml(s.hours.toFixed(2))}</b>`,
      `Hourly gross: <b>${escapeHtml(currency(s.hourlyGross))}</b>`,
      `Hourly net: <b>${escapeHtml(currency(s.hourlyNet))}</b>`,
    ];
    const opts = { reply_markup: { inline_keyboard: [[{ text: '📈 PHV Week', callback_data: 'show:phvweek' }, { text: '📅 Due', callback_data: 'show:due' }]] } };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, lines.join('\n'), opts) : send(msg.chat.id, lines.join('\n'), opts);
  } catch (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not load PHV today summary.');
  }
}

async function handlePhvWeek(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const start = todayDateString();
    const sevenAgo = new Date(`${start}T12:00:00+08:00`);
    sevenAgo.setDate(sevenAgo.getDate() - 6);
    const startDate = sevenAgo.toISOString().slice(0, 10);
    const logs = await getPhvRange(msg.from.id, startDate, todayDateString());
    if (!logs.length) {
      const text = 'No PHV logs in the past 7 days yet.';
      return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
    }
    const s = summarizePhv(logs);
    const bestDayMap = new Map();
    logs.forEach((log) => {
      const existing = bestDayMap.get(log.log_date) || { gross: 0, hours: 0, petrol: 0 };
      existing.gross += Number(log.gross_amount || 0);
      existing.hours += Number(log.hours_worked || 0);
      existing.petrol += Number(log.petrol_cost || 0);
      bestDayMap.set(log.log_date, existing);
    });
    let best = null;
    for (const [date, data] of bestDayMap.entries()) {
      const hourly = data.hours > 0 ? (data.gross - data.petrol) / data.hours : 0;
      if (!best || hourly > best.hourly) best = { date, hourly };
    }
    const lines = [
      '<b>PHV past 7 days</b>',
      `Range: <b>${escapeHtml(startDate)}</b> to <b>${escapeHtml(todayDateString())}</b>`,
      `Entries: <b>${logs.length}</b>`,
      `Gross: <b>${escapeHtml(currency(s.gross))}</b>`,
      `Petrol: <b>${escapeHtml(currency(s.petrol))}</b>`,
      `Estimated net: <b>${escapeHtml(currency(s.net))}</b>`,
      `Hours: <b>${escapeHtml(s.hours.toFixed(2))}</b>`,
      `Avg hourly gross: <b>${escapeHtml(currency(s.hourlyGross))}</b>`,
      `Avg hourly net: <b>${escapeHtml(currency(s.hourlyNet))}</b>`,
    ];
    if (best) lines.push(`Best day by hourly net: <b>${escapeHtml(best.date)}</b> (${escapeHtml(currency(best.hourly))}/hr)`);
    const opts = { reply_markup: { inline_keyboard: [[{ text: '🚗 PHV Today', callback_data: 'show:phvtoday' }, { text: '🗓 Weekly', callback_data: 'show:weekly' }]] } };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, lines.join('\n'), opts) : send(msg.chat.id, lines.join('\n'), opts);
  } catch (error) {
    console.error(error);
    return send(msg.chat.id, 'Could not load PHV week summary.');
  }
}

async function handleDecide(msg, body) {
  if (!body) return send(msg.chat.id, 'Use: <code>/decide your situation or question</code>');
  await ensureUser(msg);
  const advice = buildDecisionAdvice(body);

  const { error } = await supabase.from('decision_logs').insert({
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    prompt: body,
    recommendation: advice.recommendation,
    risk_level: advice.risk,
    created_at: nowIso(),
  });
  if (error) console.error('decision log save error', error);

  const lines = [
    '<b>Decision assistant</b>',
    `<b>Your question</b>\n<blockquote>${escapeHtml(body)}</blockquote>`,
    '',
    `<b>Recommendation</b>\n• ${escapeHtml(advice.recommendation)}`,
    '',
    `<b>Risk level</b>\n• ${escapeHtml(advice.risk)}`,
    '',
    '<b>Why</b>',
    ...advice.reasons.map((r) => `• ${escapeHtml(r)}`),
    '',
    '<b>Suggested next step</b>',
    ...advice.actions.map((a) => `• ${escapeHtml(a)}`),
  ];

  await send(msg.chat.id, lines.join('\n'), { reply_markup: {
    inline_keyboard: [
      [
        { text: '📅 Due', callback_data: 'show:due' },
        { text: '🗓 Weekly', callback_data: 'show:weekly' },
      ],
    ],
  }});
}

async function handleWeekly(msg, editContext = null) {
  await ensureUser(msg);
  const userId = msg.from.id;
  const today = todayDateString();
  const sevenDaysAgo = new Date(`${today}T12:00:00+08:00`);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenIso = sevenDaysAgo.toISOString();
  const startDate = sevenDaysAgo.toISOString().slice(0, 10);

  const [notesRes, tasksRes, dueData, openTasks, phvLogs] = await Promise.all([
    supabase.from('notes').select('id', { count: 'exact', head: true }).eq('telegram_user_id', userId).gte('created_at', sevenIso),
    supabase.from('tasks').select('*').eq('telegram_user_id', userId).gte('created_at', sevenIso),
    getDueItems(userId),
    getOpenTasks(userId),
    getPhvRange(userId, startDate, today),
  ]);

  if (notesRes.error || tasksRes.error) {
    console.error(notesRes.error || tasksRes.error);
    return send(msg.chat.id, 'Could not create weekly summary.');
  }

  const tasks = tasksRes.data || [];
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const openCount = tasks.filter((t) => t.status === 'open').length;
  const phv = summarizePhv(phvLogs);

  const lines = [
    '<b>Weekly summary</b>',
    `Date: <b>${escapeHtml(today)}</b>`,
    '',
    '<b>Capture</b>',
    `• Notes / ideas saved: ${notesRes.count || 0}`,
    `• Tasks created: ${tasks.length}`,
    `• Tasks completed: ${doneCount}`,
    `• Tasks still open from this week: ${openCount}`,
    '',
    '<b>Due / admin</b>',
    `• Reminders due now: ${dueData.reminders.length}`,
    `• Admin items due / upcoming: ${dueData.adminItems.length}`,
    '',
    '<b>PHV</b>',
    `• Gross past 7 days: ${escapeHtml(currency(phv.gross))}`,
    `• Estimated net past 7 days: ${escapeHtml(currency(phv.net))}`,
    `• Avg hourly net: ${escapeHtml(currency(phv.hourlyNet))}`,
    '',
    '<b>Top open tasks</b>',
  ];

  if (openTasks.length) openTasks.slice(0, 5).forEach((t) => lines.push(`• ${escapeHtml(t.content)}`));
  else lines.push('• None');

  lines.push('', '<b>Suggested next action</b>');
  if (dueData.reminders.length || dueData.adminItems.length) lines.push('• Clear or review due items first with /due.');
  else if (openTasks.length) lines.push('• Finish one open task today.');
  else if (phvLogs.length) lines.push('• Review whether your best PHV hours are worth repeating next week.');
  else lines.push('• Capture new ideas with note: or /note.');

  const opts = { reply_markup: { inline_keyboard: [[{ text: '📅 Due', callback_data: 'show:due' }, { text: '🚗 PHV Week', callback_data: 'show:phvweek' }], [{ text: '➕ Menu', callback_data: 'show:menu' }]] } };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, lines.join('\n'), opts) : send(msg.chat.id, lines.join('\n'), opts);
}

function parseNaturalLanguage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  let m;
  if ((m = trimmed.match(/^note\s*:\s*(.+)$/i))) return { type: 'note', body: m[1].trim(), noteType: 'note' };
  if ((m = trimmed.match(/^idea\s*:\s*(.+)$/i))) return { type: 'note', body: m[1].trim(), noteType: 'idea' };
  if ((m = trimmed.match(/^task\s*:\s*(.+)$/i))) return { type: 'task', body: m[1].trim() };
  if ((m = trimmed.match(/^done\s*:\s*(.+)$/i))) return { type: 'done', body: m[1].trim() };
  if ((m = trimmed.match(/^search\s*:\s*(.+)$/i))) return { type: 'search', body: m[1].trim() };
  if ((m = trimmed.match(/^decide\s*:\s*(.+)$/i))) return { type: 'decide', body: m[1].trim() };
  if ((m = trimmed.match(/^admin\s*:\s*(.+)$/i))) return { type: 'adminadd', body: m[1].trim() };
  if ((m = trimmed.match(/^admin done\s*:\s*(.+)$/i))) return { type: 'admindone', body: m[1].trim() };
  if ((m = trimmed.match(/^phv\s*:\s*(.+)$/i))) return { type: 'phvlog', body: m[1].trim() };
  if (/^due$/i.test(trimmed)) return { type: 'due' };
  if (/^weekly$/i.test(trimmed)) return { type: 'weekly' };
  if (/^phv today$/i.test(trimmed)) return { type: 'phvtoday' };
  if (/^phv week$/i.test(trimmed)) return { type: 'phvweek' };
  if (/^phv settings$/i.test(trimmed)) return { type: 'phvsettings' };
  return null;
}

async function handleNaturalLanguage(msg, parsed) {
  switch (parsed.type) {
    case 'note':
      return handleNote(msg, parsed.body, parsed.noteType || 'note');
    case 'task':
      return handleTask(msg, parsed.body);
    case 'done':
      return handleDone(msg, parsed.body);
    case 'search':
      return handleSearch(msg, parsed.body);
    case 'decide':
      return handleDecide(msg, parsed.body);
    case 'adminadd':
      return handleAdminAdd(msg, parsed.body);
    case 'admindone':
      return handleAdminDone(msg, parsed.body);
    case 'due':
      return handleDue(msg);
    case 'weekly':
      return handleWeekly(msg);
    case 'phvlog':
      return handlePhvLog(msg, parsed.body);
    case 'phvtoday':
      return handlePhvToday(msg);
    case 'phvweek':
      return handlePhvWeek(msg);
    case 'phvsettings':
      return handlePhvSettings(msg);
    default:
      return send(msg.chat.id, 'Unknown input. Use /help');
  }
}

async function routeMessage(msg) {
  if (!msg.text) return;
  const text = msg.text.trim();

  const pending = pendingPhvSettingInputs.get(msg.from.id);
  if (pending && !text.startsWith('/')) {
    const value = Number(text.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(value)) {
      return send(msg.chat.id, 'Please send a number only. Example: <code>3.46</code>');
    }

    const updates = { updated_at: nowIso() };
    updates[pending.field] = value;

    const { error } = await supabase
      .from('phv_settings')
      .update(updates)
      .eq('telegram_user_id', msg.from.id);

    pendingPhvSettingInputs.delete(msg.from.id);

    if (error) {
      console.error(error);
      return send(msg.chat.id, 'Could not update that PHV setting.');
    }

    await send(msg.chat.id, `Updated <b>${escapeHtml(pending.field)}</b> to <b>${escapeHtml(String(value))}</b>.`);
    return handlePhvSettings(msg);
  }

  const natural = parseNaturalLanguage(text);
  if (!text.startsWith('/') && natural) return handleNaturalLanguage(msg, natural);

  const [command, ...rest] = text.split(' ');
  const body = rest.join(' ').trim();

  switch (command.toLowerCase()) {
    case '/start':
      return handleStart(msg);
    case '/help':
    case '/menu':
      return showHelp(msg.chat.id);
    case '/note':
      return handleNote(msg, body, 'note');
    case '/idea':
      return handleNote(msg, body, 'idea');
    case '/task':
      return handleTask(msg, body);
    case '/done':
      return handleDone(msg, body);
    case '/remind':
      return handleRemind(msg, body);
    case '/adminadd':
      return handleAdminAdd(msg, body);
    case '/admindone':
      return handleAdminDone(msg, body);
    case '/due':
      return handleDue(msg);
    case '/search':
      return handleSearch(msg, body);
    case '/weekly':
      return handleWeekly(msg);
    case '/phvlog':
      return handlePhvLog(msg, body);
    case '/phvtoday':
      return handlePhvToday(msg);
    case '/phvweek':
      return handlePhvWeek(msg);
    case '/phvsettings':
      return handlePhvSettings(msg);
    case '/decide':
      return handleDecide(msg, body);
    default:
      return send(msg.chat.id, 'Unknown command. Use /help', { reply_markup: MAIN_KEYBOARD });
  }
}

async function routeCallback(query) {
  const data = query.data || '';
  const msg = query.message;
  if (!msg) return answerCallback(query.id);

  const fauxMsg = { chat: msg.chat, from: query.from, text: '', message_id: msg.message_id };

  try {
    if (data === 'show:menu') {
      await answerCallback(query.id);
      return editOrSend(msg.chat.id, msg.message_id, 'Choose an action.', { reply_markup: MAIN_KEYBOARD });
    }
    if (data === 'show:due') {
      await answerCallback(query.id);
      return handleDue(fauxMsg, { messageId: msg.message_id });
    }
    if (data === 'show:weekly') {
      await answerCallback(query.id);
      return handleWeekly(fauxMsg, { messageId: msg.message_id });
    }
    if (data === 'show:phvtoday') {
      await answerCallback(query.id);
      return handlePhvToday(fauxMsg, { messageId: msg.message_id });
    }
    if (data === 'show:phvweek') {
      await answerCallback(query.id);
      return handlePhvWeek(fauxMsg, { messageId: msg.message_id });
    }
    if (data === 'show:phvsettings') {
      await answerCallback(query.id);
      return handlePhvSettings(fauxMsg, { messageId: msg.message_id });
    }
    if (data.startsWith('phvset:togglemode')) {
      await answerCallback(query.id, 'Switching mode...');
      const settings = await getOrCreatePhvSettings(fauxMsg);
      const nextMode = settings.mode === 'auto' ? 'simple' : 'auto';
      const { error } = await supabase.from('phv_settings').update({ mode: nextMode, updated_at: nowIso() }).eq('telegram_user_id', query.from.id);
      if (error) throw error;
      return handlePhvSettings(fauxMsg, { messageId: msg.message_id });
    }
    if (data.startsWith('phvset:edit:')) {
      const field = data.split(':')[2];
      pendingPhvSettingInputs.set(query.from.id, { field });
      await answerCallback(query.id, 'Waiting for your value...');
      return send(msg.chat.id, phvSettingPrompt(field), { reply_markup: phvSettingsButtons(await getOrCreatePhvSettings(fauxMsg)) });
    }
    if (data.startsWith('hint:')) {
      const hint = data.split(':')[1];
      await answerCallback(query.id);
      const hints = {
        note: 'Send: <code>note: your note here</code> or <code>/note your note here</code>',
        task: 'Send: <code>task: your task here</code> or <code>/task your task here</code>',
        decide: 'Send: <code>decide: should I service now or wait?</code> or <code>/decide ...</code>',
      };
      return send(msg.chat.id, hints[hint] || 'Use /help', { reply_markup: MAIN_KEYBOARD });
    }
    if (data.startsWith('admindone:')) {
      const id = data.split(':')[1];
      await answerCallback(query.id, 'Marking as done...');
      const { data: row, error } = await supabase.from('admin_items').select('*').eq('id', id).limit(1).maybeSingle();
      if (error) throw error;
      await completeAdminItemByRow(msg.chat.id, row);
      return handleDue(fauxMsg, { messageId: msg.message_id });
    }
    await answerCallback(query.id);
  } catch (error) {
    console.error('Callback handler error', error);
    await answerCallback(query.id, 'Something went wrong.');
    return send(msg.chat.id, 'Something went wrong while handling that button.');
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

bot.on('callback_query', async (query) => {
  await routeCallback(query);
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
