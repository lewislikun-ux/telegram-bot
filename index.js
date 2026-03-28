require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const Tesseract = require('tesseract.js');

const {
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PORT = 10000,
} = process.env;

const required = ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '20mb' }));
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const pendingInputs = new Map();
const pendingReceiptActions = new Map();


process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function nowIso() { return new Date().toISOString(); }
function sgNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' })); }
function todayDateString() {
  const d = sgNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function currency(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '-';
  return `$${x.toFixed(2)}`;
}
function num(x, dp = 2) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(dp) : '-';
}
function addDays(dateString, days) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateString, count) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  d.setMonth(d.getMonth() + count);
  return d.toISOString().slice(0, 10);
}
function addYears(dateString, count) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  d.setFullYear(d.getFullYear() + count);
  return d.toISOString().slice(0, 10);
}
function dueInDays(dateString) {
  const today = new Date(`${todayDateString()}T00:00:00+08:00`);
  const due = new Date(`${String(dateString).slice(0, 10)}T00:00:00+08:00`);
  return Math.round((due - today) / 86400000);
}
function humanDueLabel(days) {
  if (days < 0) return `${Math.abs(days)} day(s) overdue`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} day(s)`;
}
function getDayType(dateString) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  const day = d.getDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}
function scoreSession(hourlyNet) {
  const x = Number(hourlyNet || 0);
  if (x >= 50) return { label: 'Excellent', emoji: '🟢' };
  if (x >= 35) return { label: 'Average', emoji: '🟡' };
  return { label: 'Poor', emoji: '🔴' };
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
function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  const sg = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  return `${sg.getFullYear()}-${String(sg.getMonth() + 1).padStart(2, '0')}-${String(sg.getDate()).padStart(2, '0')} ${String(sg.getHours()).padStart(2, '0')}:${String(sg.getMinutes()).padStart(2, '0')}`;
}

function telegramMessageIso(msg) {
  const unix = Number(msg?.date || 0);
  if (!unix) return nowIso();
  return new Date(unix * 1000).toISOString();
}
function durationHoursBetween(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const hours = (end - start) / 3600000;
  return hours > 0 ? hours : null;
}
function formatDurationHours(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '-';
  const totalMinutes = Math.round(h * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (wholeHours <= 0) return `${mins}m`;
  if (mins === 0) return `${wholeHours}h`;
  return `${wholeHours}h ${mins}m`;
}
function buildMaintenanceWatchList(items, odometer, thresholdKm = 1000) {
  const currentOdo = Number(odometer);
  if (!Number.isFinite(currentOdo)) return [];
  return (items || [])
    .map((item) => ({ ...item, remaining: Number(item.next_due_mileage) - currentOdo }))
    .filter((x) => Number.isFinite(x.remaining) && x.remaining <= thresholdKm)
    .sort((a, b) => a.remaining - b.remaining);
}
function maintenanceWatchLines(items, odometer, thresholdKm = 1000, maxItems = 3) {
  const watch = buildMaintenanceWatchList(items, odometer, thresholdKm).slice(0, maxItems);
  if (!watch.length) return [];
  const lines = ['', '<b>Maintenance watch</b>'];
  watch.forEach((item) => {
    const rem = Number(item.remaining);
    const text = rem < 0 ? `${Math.abs(rem)} km overdue` : `${Math.round(rem)} km remaining`;
    lines.push(`• ${escapeHtml(item.item_name)} — due at <b>${escapeHtml(String(item.next_due_mileage))}</b> (${escapeHtml(text)})`);
  });
  return lines;
}

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
      { text: '🚗 Start Session', callback_data: 'show:phvstart' },
      { text: '🏁 End Session', callback_data: 'show:phvend' },
    ],
    [
      { text: '📈 PHV Week', callback_data: 'show:phvweek' },
      { text: '❓ Drive?', callback_data: 'show:shoulddrive' },
    ],
    [
      { text: '⛽ PHV Settings', callback_data: 'show:phvsettings' },
      { text: '🛠 Maintenance', callback_data: 'show:maintstatus' },
    ],
    [
      { text: '📰 News', callback_data: 'show:news' },
      { text: '🔄 Refresh News', callback_data: 'show:news' },
    ],
  ],
};

async function send(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}
async function editOrSend(chatId, messageId, text, extra = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    return send(chatId, text, extra);
  }
}

async function ensureUser(msg) {
  const row = {
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    username: msg.from.username || null,
    first_name: msg.from.first_name || null,
    last_name: msg.from.last_name || null,
    updated_at: nowIso(),
  };
  const { error } = await supabase.from('users').upsert(row, { onConflict: 'telegram_user_id' });
  if (error) throw error;
}

async function getOrCreatePhvSettings(msgOrUser) {
  const telegramUserId = msgOrUser.from ? msgOrUser.from.id : msgOrUser.telegram_user_id;
  const chatId = msgOrUser.chat ? msgOrUser.chat.id : msgOrUser.chat_id;
  const { data: existing, error } = await supabase
    .from('phv_settings')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
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
  const { data: created, error: createErr } = await supabase.from('phv_settings').upsert(defaults, { onConflict: 'telegram_user_id' }).select('*').single();
  if (createErr) throw createErr;
  return created;
}
function calculateEffectivePetrolPrice(settings) {
  const basePrice = Number(settings.petrol_price_per_litre || 0);
  const discountPercent = Number(settings.discount_percent || 0);
  const fixedRebate = Number(settings.fixed_rebate || 0);
  const rebateThreshold = Number(settings.rebate_threshold || 0);
  if (!(basePrice > 0)) return 0;
  const discountedPrice = basePrice * (1 - discountPercent / 100);
  if (!(fixedRebate > 0) || !(rebateThreshold > 0)) return discountedPrice;
  const litresAtThreshold = rebateThreshold / basePrice;
  if (!(litresAtThreshold > 0)) return discountedPrice;
  const discountedTotal = discountedPrice * litresAtThreshold;
  return Math.max(discountedTotal - fixedRebate, 0) / litresAtThreshold;
}
function calculateAutoCostPerKm(settings) {
  const kmpl = Number(settings.fuel_consumption_kmpl || 0);
  if (!(kmpl > 0)) return 0;
  return calculateEffectivePetrolPrice(settings) / kmpl;
}
function calculatePhvPetrolCost(kmDriven, settings) {
  const km = Number(kmDriven || 0);
  if (!(km > 0)) return null;
  let costPerKm = 0;
  if ((settings.mode || 'simple') === 'simple') {
    costPerKm = Number(settings.cost_per_km_override || 0) || calculateAutoCostPerKm(settings);
  } else {
    costPerKm = calculateAutoCostPerKm(settings);
  }
  if (!(costPerKm > 0)) return null;
  return Number((km * costPerKm).toFixed(2));
}
function phvComputed(log) {
  const gross = Number(log.gross_amount || 0);
  const petrol = Number(log.petrol_cost || 0);
  const hours = Number(log.hours_worked || 0);
  const net = gross - petrol;
  return {
    gross, petrol, hours, net,
    hourlyGross: hours > 0 ? gross / hours : 0,
    hourlyNet: hours > 0 ? net / hours : 0,
  };
}
function summarizePhv(logs) {
  const total = logs.reduce((acc, row) => {
    const c = phvComputed(row);
    acc.count += 1;
    acc.gross += c.gross;
    acc.petrol += c.petrol;
    acc.hours += c.hours;
    acc.net += c.net;
    acc.km += Number(row.km_driven || 0);
    return acc;
  }, { count: 0, gross: 0, petrol: 0, hours: 0, net: 0, km: 0 });
  total.hourlyGross = total.hours > 0 ? total.gross / total.hours : 0;
  total.hourlyNet = total.hours > 0 ? total.net / total.hours : 0;
  return total;
}
function summarizeComparableSessions(logs, dayType, excludeDate = null) {
  const filtered = logs.filter((row) => getDayType(row.log_date) === dayType && row.log_date !== excludeDate);
  return summarizePhv(filtered);
}
function buildShouldDriveAdvice(dayType, comparable) {
  const hourly = Number(comparable.hourlyNet || 0);
  if (!comparable.count) return { headline: 'Not enough data yet', recommendation: 'Log 3 to 5 sessions first so the bot can give a grounded signal.', confidence: 'Low' };
  if (hourly >= 45) return { headline: 'Yes, worth going', recommendation: `${dayType} sessions have been strong lately.`, confidence: comparable.count >= 5 ? 'High' : 'Medium' };
  if (hourly >= 30) return { headline: 'Can go, but be selective', recommendation: `${dayType} sessions are okay lately. Stop early if the session turns weak.`, confidence: comparable.count >= 5 ? 'Medium' : 'Low' };
  return { headline: 'Low ROI lately', recommendation: `${dayType} sessions have been weak lately. Only go if you expect special demand or need the cashflow.`, confidence: comparable.count >= 5 ? 'High' : 'Medium' };
}
function buildStopRecommendation(session, comparable) {
  const c = phvComputed(session);
  if (c.hours < 1.5) return 'Too early to judge. Keep going unless demand is clearly dead.';
  if (!comparable.count) return c.hourlyNet >= 35 ? 'Net hourly still looks decent. Continue if demand feels alive.' : 'Hourly is weak. Consider stopping if the next 30 mins stay poor.';
  if (c.hourlyNet >= comparable.hourlyNet + 5) return 'You are above your recent comparable average. Continue if you still feel fresh.';
  if (c.hourlyNet >= comparable.hourlyNet - 5) return 'You are around your usual level. Continue only if jobs keep coming.';
  return 'You are below your recent comparable average. Consider stopping soon if the next stretch stays weak.';
}

function parseAdminAdd(body) {
  const parts = String(body || '').split('|').map((s) => s.trim());
  if (parts.length < 3) return null;
  const title = parts[0];
  const dueDate = parts[1];
  const recurrence = String(parts[2] || 'none').toLowerCase();
  const leadDaysRaw = parts[3] || '7,1';
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  if (!['none', 'monthly', 'yearly'].includes(recurrence)) return null;
  let leadDays = [];
  if (leadDaysRaw.toLowerCase() !== 'none') {
    leadDays = leadDaysRaw.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0);
  }
  return { title, dueDate, recurrence, leadDays };
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

function parsePhvBody(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  const result = {};
  for (const part of parts) {
    const m = part.match(/^(date|gross|hours|km|petrol|trip|trips|notes?)\s*[:=]?\s*(.+)$/i);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  const date = result.date || todayDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const gross = parseFloat(result.gross || '');
  const hours = parseFloat(result.hours || '');
  const km = parseFloat(result.km || '');
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : null;
  const tripCount = result.trip !== undefined ? parseInt(result.trip, 10) : (result.trips !== undefined ? parseInt(result.trips, 10) : null);
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
function parsePhvNowBody(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  const result = {};
  for (const part of parts) {
    const m = part.match(/^(gross|hours|current|mileage|petrol)\s*[:=]?\s*(.+)$/i);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  const gross = parseFloat(result.gross || '');
  const hours = result.hours !== undefined ? parseFloat(result.hours || '') : null;
  const currentMileage = parseFloat(result.current || result.mileage || '');
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : null;
  if (!Number.isFinite(gross) || !Number.isFinite(currentMileage)) return null;
  return { gross_amount: gross, hours_worked: Number.isFinite(hours) ? hours : null, current_mileage: currentMileage, petrol_cost: Number.isFinite(petrol) ? petrol : null };
}
function parsePhvEnd(body) {
  const parts = String(body || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0].match(/^\d+(?:\.\d+)?$/) ? parseFloat(parts[0]) : null;
  const result = {};
  for (const part of parts) {
    const m = part.match(/^(end|gross|hours|petrol|date|notes?)\s*[:=]?\s*(.+)$/i);
    if (m) result[m[1].toLowerCase()] = m[2].trim();
  }
  const endMileage = first ?? parseFloat(result.end || '');
  const gross = parseFloat(result.gross || '');
  const hours = result.hours !== undefined ? parseFloat(result.hours || '') : null;
  const petrol = result.petrol !== undefined ? parseFloat(result.petrol) : null;
  const date = result.date || todayDateString();
  const notes = result.note || result.notes || null;
  if (!Number.isFinite(endMileage) || !Number.isFinite(gross)) return null;
  return { end_mileage: endMileage, gross_amount: gross, hours_worked: Number.isFinite(hours) ? hours : null, petrol_cost: Number.isFinite(petrol) ? petrol : null, log_date: date, notes };
}
function parseMaintenanceAdd(body) {
  const parts = String(body || '').split('|').map((s) => s.trim());
  if (parts.length < 3) return null;
  const itemName = parts[0];
  const intervalKm = parseFloat(parts[1]);
  const lastDoneMileage = parseFloat(parts[2]);
  const notes = parts[3] || null;
  if (!itemName || !Number.isFinite(intervalKm) || !Number.isFinite(lastDoneMileage)) return null;
  return { item_name: itemName, interval_km: intervalKm, last_done_mileage: lastDoneMileage, notes };
}
function parseMaintDone(body) {
  const parts = String(body || '').split('|').map((s) => s.trim());
  if (parts.length < 2) return null;
  const itemName = parts[0];
  const mileage = parseFloat(parts[1]);
  const cost = parts[2] ? parseFloat(parts[2]) : null;
  const notes = parts[3] || null;
  if (!itemName || !Number.isFinite(mileage)) return null;
  return { item_name: itemName, mileage, cost: Number.isFinite(cost) ? cost : null, notes };
}

async function getCurrentOdometer(userId) {
  const { data, error } = await supabase
    .from('phv_logs')
    .select('end_mileage')
    .eq('telegram_user_id', userId)
    .not('end_mileage', 'is', null)
    .order('log_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.end_mileage ?? null;
}
async function getActiveSession(userId) {
  const { data, error } = await supabase.from('phv_active_session').select('*').eq('telegram_user_id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}
async function getDueItems(userId) {
  const tomorrowPlus30 = addDays(todayDateString(), 30);
  const remindersRes = await supabase
    .from('reminders')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('status', 'open')
    .lte('remind_at', `${tomorrowPlus30}T23:59:59+08:00`)
    .order('remind_at', { ascending: true })
    .limit(20);
  const adminRes = await supabase
    .from('admin_items')
    .select('*')
    .eq('telegram_user_id', userId)
    .eq('is_active', true)
    .lte('next_due_date', tomorrowPlus30)
    .order('next_due_date', { ascending: true })
    .limit(20);
  if (remindersRes.error) throw remindersRes.error;
  if (adminRes.error) throw adminRes.error;
  return { reminders: remindersRes.data || [], adminItems: adminRes.data || [] };
}
async function getOpenTasks(userId) {
  const { data, error } = await supabase.from('tasks').select('*').eq('telegram_user_id', userId).eq('status', 'open').order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  return data || [];
}
async function getPhvRange(userId, startDate, endDate) {
  const { data, error } = await supabase
    .from('phv_logs')
    .select('*')
    .eq('telegram_user_id', userId)
    .gte('log_date', startDate)
    .lte('log_date', endDate)
    .order('log_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
async function getMaintenanceItems(userId) {
  const { data, error } = await supabase.from('maintenance_items').select('*').eq('telegram_user_id', userId).eq('is_active', true).order('item_name');
  if (error) throw error;
  return data || [];
}

function buildDueText(reminders, adminItems) {
  const lines = ['<b>Due overview</b>', ''];
  if (!reminders.length && !adminItems.length) {
    lines.push('✅ Nothing urgent right now.');
    return lines.join('\n');
  }
  if (reminders.length) {
    lines.push('<b>Reminders</b>');
    reminders.forEach((r) => lines.push(`• ${escapeHtml(formatDateTime(r.remind_at))} — ${escapeHtml(r.content)}`));
    lines.push('');
  }
  if (adminItems.length) {
    lines.push('<b>Admin items</b>');
    adminItems.forEach((a) => lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)} (${escapeHtml(humanDueLabel(dueInDays(a.next_due_date)))})`));
  }
  return lines.join('\n');
}
function dueButtons(items) {
  const rows = items.slice(0, 5).map((item) => [{ text: `✅ Done: ${item.title.slice(0, 20)}`, callback_data: `admindoneid:${item.id}` }]);
  rows.push([{ text: '🔄 Refresh Due', callback_data: 'show:due' }, { text: '🗓 Weekly', callback_data: 'show:weekly' }]);
  return { inline_keyboard: rows };
}
function phvSettingsButtons(settings) {
  return {
    inline_keyboard: [
      [{ text: settings.mode === 'auto' ? 'Switch to Simple mode' : 'Switch to Auto mode', callback_data: 'phvset:togglemode' }],
      [{ text: 'Edit Fuel km/L', callback_data: 'phvset:fuel_consumption_kmpl' }, { text: 'Edit Petrol Price', callback_data: 'phvset:petrol_price_per_litre' }],
      [{ text: 'Edit Discount %', callback_data: 'phvset:discount_percent' }, { text: 'Edit Fixed Rebate', callback_data: 'phvset:fixed_rebate' }],
      [{ text: 'Edit Rebate Threshold', callback_data: 'phvset:rebate_threshold' }, { text: 'Edit Cost/km', callback_data: 'phvset:cost_per_km_override' }],
      [{ text: '🚗 PHV Today', callback_data: 'show:phvtoday' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }],
    ],
  };
}
function phvSettingsText(settings) {
  const effectivePrice = calculateEffectivePetrolPrice(settings);
  const autoCost = calculateAutoCostPerKm(settings);
  return [
    '<b>PHV settings</b>',
    `Mode: <b>${escapeHtml(settings.mode === 'auto' ? 'Auto calculation' : 'Simple fixed cost/km')}</b>`,
    '',
    `Fuel consumption: <b>${num(settings.fuel_consumption_kmpl)} km/L</b>`,
    `Petrol price: <b>${currency(settings.petrol_price_per_litre)}/L</b>`,
    `Discount: <b>${num(settings.discount_percent)}%</b>`,
    `Fixed rebate: <b>${currency(settings.fixed_rebate)}</b> off <b>${currency(settings.rebate_threshold)}</b>`,
    `Effective petrol price: <b>${currency(effectivePrice)}/L</b>`,
    `Auto cost/km: <b>${currency(autoCost)}</b>`,
    `Simple cost/km override: <b>${currency(settings.cost_per_km_override)}</b>`,
  ].join('\n');
}

async function handleStart(msg) {
  await ensureUser(msg);
  return send(msg.chat.id, [
    `<b>Hi ${escapeHtml(msg.from.first_name || 'there')}</b>`,
    '',
    'This Phase 3 build includes:',
    '• notes / tasks / reminders',
    '• admin due tracking',
    '• PHV settings + PHV logging',
    '• PHV start / now / end mileage flow',
    '• mileage-based maintenance tracker',
    '• screenshot / receipt OCR reader (best effort)',
    '',
    'Try:',
    '<code>/phvstart 112280</code>',
    '<code>/phvnow gross:62 | current:112314</code>',
    '<code>/phvend 112348 | gross:145</code>',
    '<code>/addmaintenance engine servicing | 8000 | 112000</code>',
    '<code>/phvsettings</code>',
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}
async function showHelp(chatId) {
  return send(chatId, [
    '<b>Commands</b>',
    '',
    '<b>Capture</b>',
    '<code>/note text</code>',
    '<code>/idea text</code>',
    '<code>/task text</code>',
    '<code>/done keyword</code>',
    '<code>/search keyword</code>',
    '',
    '<b>Reminders / admin</b>',
    '<code>/remind YYYY-MM-DD HH:MM | message</code>',
    '<code>/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1</code>',
    '<code>/admindone keyword</code>',
    '<code>/due</code>',
    '',
    '<b>PHV</b>',
    '<code>/phvlog date:2026-03-27 | gross:145 | hours:2.5 | km:68</code>',
    '<code>/phvstart 112280</code>',
    '<code>/phvnow gross:62 | current:112314</code>',
    '<code>/phvend 112348 | gross:145</code>',
    '<code>/phvtoday</code>',
    '<code>/phvweek</code>',
    '<code>/shoulddrive</code>',
    '<code>/phvsettings</code>',
    '',
    '<b>Maintenance</b>',
    '<code>/addmaintenance item | interval_km | last_done_mileage</code>',
    '<code>/maintenance</code>',
    '<code>/maintdone item | mileage | optional_cost | optional_note</code>',
    '',
    '<b>OCR</b>',
    'Send a receipt screenshot/photo with a caption like <code>fuel</code>, <code>maintenance</code>, or <code>insurance</code>. The bot will OCR it and suggest what to save.',
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handleNote(msg, body, noteType = 'note') {
  if (!body) return send(msg.chat.id, `Use: <code>/${noteType} your text</code>`);
  await ensureUser(msg);
  const { error } = await supabase.from('notes').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, note_type: noteType, content: body, created_at: nowIso() });
  if (error) { console.error(error); return send(msg.chat.id, 'Could not save note.'); }
  return send(msg.chat.id, `Saved ${escapeHtml(noteType)}:\n<blockquote>${escapeHtml(body)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
}
async function handleTask(msg, body) {
  if (!body) return send(msg.chat.id, 'Use: <code>/task your task</code>');
  await ensureUser(msg);
  const { error } = await supabase.from('tasks').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, content: body, status: 'open', created_at: nowIso(), updated_at: nowIso() });
  if (error) { console.error(error); return send(msg.chat.id, 'Could not save task.'); }
  return send(msg.chat.id, `Saved task:\n<blockquote>${escapeHtml(body)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
}
async function handleDone(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/done keyword</code>');
  await ensureUser(msg);
  const { data, error } = await supabase.from('tasks').select('*').eq('telegram_user_id', msg.from.id).eq('status', 'open').ilike('content', `%${keyword}%`).order('created_at', { ascending: false }).limit(1);
  if (error) { console.error(error); return send(msg.chat.id, 'Could not search tasks.'); }
  const task = data?.[0];
  if (!task) return send(msg.chat.id, 'No open task matched that keyword.');
  const { error: upd } = await supabase.from('tasks').update({ status: 'done', updated_at: nowIso(), completed_at: nowIso() }).eq('id', task.id);
  if (upd) { console.error(upd); return send(msg.chat.id, 'Could not mark task done.'); }
  return send(msg.chat.id, `Marked done:\n<blockquote>${escapeHtml(task.content)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
}
async function handleSearch(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/search keyword</code>');
  await ensureUser(msg);
  const [notesRes, tasksRes, adminRes, phvRes, maintRes] = await Promise.all([
    supabase.from('notes').select('*').eq('telegram_user_id', msg.from.id).ilike('content', `%${keyword}%`).limit(5),
    supabase.from('tasks').select('*').eq('telegram_user_id', msg.from.id).ilike('content', `%${keyword}%`).limit(5),
    supabase.from('admin_items').select('*').eq('telegram_user_id', msg.from.id).ilike('title', `%${keyword}%`).limit(5),
    supabase.from('phv_logs').select('*').eq('telegram_user_id', msg.from.id).ilike('notes', `%${keyword}%`).limit(5),
    supabase.from('maintenance_items').select('*').eq('telegram_user_id', msg.from.id).ilike('item_name', `%${keyword}%`).limit(5),
  ]);
  const errors = [notesRes.error, tasksRes.error, adminRes.error, phvRes.error, maintRes.error].filter(Boolean);
  if (errors.length) { console.error(errors); return send(msg.chat.id, 'Search failed.'); }
  const lines = [`<b>Search results for:</b> ${escapeHtml(keyword)}`, ''];
  if (notesRes.data?.length) { lines.push('<b>Notes</b>'); notesRes.data.forEach((x) => lines.push(`• [${escapeHtml(x.note_type)}] ${escapeHtml(x.content)}`)); lines.push(''); }
  if (tasksRes.data?.length) { lines.push('<b>Tasks</b>'); tasksRes.data.forEach((x) => lines.push(`• [${escapeHtml(x.status)}] ${escapeHtml(x.content)}`)); lines.push(''); }
  if (adminRes.data?.length) { lines.push('<b>Admin items</b>'); adminRes.data.forEach((x) => lines.push(`• ${escapeHtml(x.title)} — ${escapeHtml(x.next_due_date)}`)); lines.push(''); }
  if (maintRes.data?.length) { lines.push('<b>Maintenance</b>'); maintRes.data.forEach((x) => lines.push(`• ${escapeHtml(x.item_name)} — next due ${escapeHtml(String(x.next_due_mileage))}`)); lines.push(''); }
  if (phvRes.data?.length) { lines.push('<b>PHV logs</b>'); phvRes.data.forEach((x) => lines.push(`• ${escapeHtml(x.log_date)} — gross ${escapeHtml(currency(x.gross_amount))}`)); }
  if (lines.length <= 2) return send(msg.chat.id, 'No matches found.');
  return send(msg.chat.id, lines.join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handleRemind(msg, body) {
  if (!body || !body.includes('|')) return send(msg.chat.id, 'Use: <code>/remind YYYY-MM-DD HH:MM | message</code>');
  await ensureUser(msg);
  const [left, ...rest] = body.split('|');
  const dt = parseDateTimeInput(left.trim());
  const content = rest.join('|').trim();
  if (!dt || !content) return send(msg.chat.id, 'Could not read that reminder.');
  const { error } = await supabase.from('reminders').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, content, remind_at: dt.iso, status: 'open', created_at: nowIso() });
  if (error) { console.error(error); return send(msg.chat.id, 'Could not save reminder.'); }
  return send(msg.chat.id, `Saved reminder for <b>${escapeHtml(dt.date)} ${escapeHtml(dt.time)}</b>:\n<blockquote>${escapeHtml(content)}</blockquote>`, { reply_markup: MAIN_KEYBOARD });
}
async function handleAdminAdd(msg, body) {
  const parsed = parseAdminAdd(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1</code>');
  await ensureUser(msg);
  const nextDue = computeNextDueDate(parsed.dueDate, parsed.recurrence);
  const { error } = await supabase.from('admin_items').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, title: parsed.title, base_due_date: parsed.dueDate, next_due_date: nextDue, recurrence: parsed.recurrence, lead_days: parsed.leadDays, is_active: true, created_at: nowIso(), updated_at: nowIso() });
  if (error) { console.error(error); return send(msg.chat.id, 'Could not save admin item.'); }
  return send(msg.chat.id, `Saved admin item:\n<b>${escapeHtml(parsed.title)}</b>\nDue: <b>${escapeHtml(nextDue)}</b>\nRecurrence: <b>${escapeHtml(parsed.recurrence)}</b>`, { reply_markup: MAIN_KEYBOARD });
}
async function findAdminItem(userId, keyword) {
  const { data, error } = await supabase.from('admin_items').select('*').eq('telegram_user_id', userId).eq('is_active', true).ilike('title', `%${keyword}%`).order('next_due_date', { ascending: true }).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}
async function completeAdminItem(chatId, row) {
  if (!row) return send(chatId, 'Admin item not found.');
  if (row.recurrence === 'none') {
    const { error } = await supabase.from('admin_items').update({ is_active: false, updated_at: nowIso() }).eq('id', row.id);
    if (error) throw error;
    return send(chatId, `✅ Marked done: <b>${escapeHtml(row.title)}</b>\nNo further reminders for this item.`, { reply_markup: MAIN_KEYBOARD });
  }
  const nextDue = computeFollowingDueDate(row.next_due_date, row.recurrence);
  const { error } = await supabase.from('admin_items').update({ base_due_date: nextDue, next_due_date: nextDue, updated_at: nowIso() }).eq('id', row.id);
  if (error) throw error;
  return send(chatId, `✅ Marked done: <b>${escapeHtml(row.title)}</b>\nNext due: <b>${escapeHtml(nextDue)}</b>`, { reply_markup: MAIN_KEYBOARD });
}
async function handleAdminDone(msg, keyword) {
  if (!keyword) return send(msg.chat.id, 'Use: <code>/admindone keyword</code>');
  await ensureUser(msg);
  try {
    const row = await findAdminItem(msg.from.id, keyword);
    if (!row) return send(msg.chat.id, 'No active admin item matched that keyword.');
    return completeAdminItem(msg.chat.id, row);
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not mark admin item done.');
  }
}
async function handleDue(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const { reminders, adminItems } = await getDueItems(msg.from.id);
    const text = buildDueText(reminders, adminItems);
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: dueButtons(adminItems) }) : send(msg.chat.id, text, { reply_markup: dueButtons(adminItems) });
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not load due items.');
  }
}

async function handlePhvSettings(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const settings = await getOrCreatePhvSettings(msg);
    const text = phvSettingsText(settings);
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: phvSettingsButtons(settings) }) : send(msg.chat.id, text, { reply_markup: phvSettingsButtons(settings) });
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not load PHV settings.');
  }
}
async function handlePhvLog(msg, body) {
  const parsed = parsePhvBody(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/phvlog date:2026-03-27 | gross:145 | hours:2.5 | km:68 | petrol:18</code>');
  await ensureUser(msg);
  let settings = null;
  let autoPetrolUsed = false;
  try { settings = await getOrCreatePhvSettings(msg); } catch (e) { console.error(e); }
  if ((parsed.petrol_cost === null || parsed.petrol_cost === undefined) && parsed.km_driven !== null && settings) {
    const autoPetrol = calculatePhvPetrolCost(parsed.km_driven, settings);
    if (autoPetrol !== null) { parsed.petrol_cost = autoPetrol; autoPetrolUsed = true; }
  }
  const payload = { telegram_user_id: msg.from.id, chat_id: msg.chat.id, ...parsed, created_at: nowIso(), updated_at: nowIso() };
  const { error } = await supabase.from('phv_logs').insert(payload);
  if (error) { console.error(error); return send(msg.chat.id, 'Could not save PHV log.'); }
  const c = phvComputed(payload);
  const allLogs = await getPhvRange(msg.from.id, addYears(todayDateString(), -1), todayDateString());
  const comparable = summarizeComparableSessions(allLogs, getDayType(parsed.log_date), parsed.log_date);
  const score = scoreSession(c.hourlyNet);
  const lines = [
    '<b>PHV log saved</b>',
    `Date: <b>${escapeHtml(parsed.log_date)}</b>`,
    `Gross: <b>${currency(c.gross)}</b>`,
    `Petrol: <b>${currency(c.petrol)}</b>`,
    `Net: <b>${currency(c.net)}</b>`,
    `Hours: <b>${num(c.hours)}</b>`,
    `Hourly net: <b>${currency(c.hourlyNet)}</b>`,
    `Score: <b>${score.emoji} ${escapeHtml(score.label)}</b>`,
  ];
  if (parsed.km_driven !== null) lines.push(`KM: <b>${num(parsed.km_driven)}</b>`);
  if (autoPetrolUsed) lines.push(`Petrol source: <b>auto-filled from PHV settings</b>`);
  lines.push(`Signal: <b>${escapeHtml(buildStopRecommendation(payload, comparable))}</b>`);
  return send(msg.chat.id, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: '🚗 PHV Today', callback_data: 'show:phvtoday' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }]] } });
}
async function handlePhvStart(msg, body = '') {
  await ensureUser(msg);
  const existing = await getActiveSession(msg.from.id);
  if (existing) return send(msg.chat.id, `You already have an active PHV session.\nStart mileage: <b>${num(existing.start_mileage, 0)}</b>\nStarted: <b>${escapeHtml(formatDateTime(existing.started_at))}</b>`);
  const mileage = parseFloat(String(body || '').trim());
  if (!Number.isFinite(mileage)) return send(msg.chat.id, 'Use: <code>/phvstart 112280</code>');
  const startedAt = telegramMessageIso(msg);
  const { error } = await supabase.from('phv_active_session').upsert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, start_mileage: mileage, started_at: startedAt, updated_at: nowIso() }, { onConflict: 'telegram_user_id' });
  if (error) { console.error(error); return send(msg.chat.id, 'Could not start PHV session.'); }
  const maintenanceItems = await getMaintenanceItems(msg.from.id);
  const lines = [
    '🚗 <b>PHV session started</b>',
    `Start time: <b>${escapeHtml(formatDateTime(startedAt))}</b>`,
    `Start mileage: <b>${num(mileage, 0)}</b>`,
  ];
  lines.push(...maintenanceWatchLines(maintenanceItems, mileage));
  return send(msg.chat.id, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: '📍 Mid Session', callback_data: 'show:phvnow' }, { text: '🏁 End Session', callback_data: 'show:phvend' }]] } });
}
async function handlePhvNow(msg, body) {
  await ensureUser(msg);
  const active = await getActiveSession(msg.from.id);
  if (!active) return send(msg.chat.id, 'No active PHV session found. Use <code>/phvstart starting_mileage</code> first.');
  const parsed = parsePhvNowBody(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/phvnow gross:62 | current:112314</code> or <code>/phvnow gross:62 | current:112314</code>');
  const km = parsed.current_mileage - Number(active.start_mileage || 0);
  if (!(km >= 0)) return send(msg.chat.id, 'Current mileage cannot be lower than start mileage.');
  const currentAt = telegramMessageIso(msg);
  const autoHours = durationHoursBetween(active.started_at, currentAt);
  const effectiveHours = Number.isFinite(parsed.hours_worked) ? parsed.hours_worked : autoHours;
  if (!Number.isFinite(effectiveHours) || effectiveHours <= 0) return send(msg.chat.id, 'Could not determine hours worked yet. Try again in a few minutes or add <code>hours:x.x</code>.');
  let petrol = parsed.petrol_cost;
  if (petrol === null || petrol === undefined) {
    const settings = await getOrCreatePhvSettings(msg);
    petrol = calculatePhvPetrolCost(km, settings) ?? 0;
  }
  const pseudo = { log_date: todayDateString(), gross_amount: parsed.gross_amount, hours_worked: effectiveHours, petrol_cost: petrol };
  const c = phvComputed(pseudo);
  const allLogs = await getPhvRange(msg.from.id, addYears(todayDateString(), -1), todayDateString());
  const comparable = summarizeComparableSessions(allLogs, getDayType(todayDateString()), null);
  const score = scoreSession(c.hourlyNet);
  const maintenanceItems = await getMaintenanceItems(msg.from.id);
  const lines = [
    '<b>PHV mid-session</b>',
    `Started: <b>${escapeHtml(formatDateTime(active.started_at))}</b>`,
    `Checked at: <b>${escapeHtml(formatDateTime(currentAt))}</b>`,
    `KM so far: <b>${num(km)}</b>`,
    `Gross so far: <b>${currency(parsed.gross_amount)}</b>`,
    `Petrol est.: <b>${currency(petrol)}</b>`,
    `Net so far: <b>${currency(c.net)}</b>`,
    `Hours so far: <b>${num(effectiveHours)}</b> (${escapeHtml(formatDurationHours(effectiveHours))})`,
    `Hourly net so far: <b>${currency(c.hourlyNet)}</b>`,
    `Score: <b>${score.emoji} ${escapeHtml(score.label)}</b>`,
    `Signal: <b>${escapeHtml(buildStopRecommendation(pseudo, comparable))}</b>`,
  ];
  if (parsed.hours_worked === null) lines.push('Hours source: <b>auto from Telegram timestamps</b>');
  lines.push(...maintenanceWatchLines(maintenanceItems, parsed.current_mileage));
  return send(msg.chat.id, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: '🏁 End Session', callback_data: 'show:phvend' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }]] } });
}
async function handlePhvEnd(msg, body) {
  await ensureUser(msg);
  const active = await getActiveSession(msg.from.id);
  if (!active) return send(msg.chat.id, 'No active PHV session found. Use <code>/phvstart starting_mileage</code> first.');
  const parsed = parsePhvEnd(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/phvend 112348 | gross:145</code> or <code>/phvend 112348 | gross:145</code>');
  const km = parsed.end_mileage - Number(active.start_mileage || 0);
  if (!(km >= 0)) return send(msg.chat.id, 'End mileage cannot be lower than start mileage.');
  const endedAt = telegramMessageIso(msg);
  const autoHours = durationHoursBetween(active.started_at, endedAt);
  const effectiveHours = Number.isFinite(parsed.hours_worked) ? parsed.hours_worked : autoHours;
  if (!Number.isFinite(effectiveHours) || effectiveHours <= 0) return send(msg.chat.id, 'Could not determine hours worked yet. Try again in a few minutes or add <code>hours:x.x</code>.');
  let petrol = parsed.petrol_cost;
  let autoPetrol = false;
  if (petrol === null || petrol === undefined) {
    const settings = await getOrCreatePhvSettings(msg);
    petrol = calculatePhvPetrolCost(km, settings) ?? 0;
    autoPetrol = true;
  }
  const payload = {
    telegram_user_id: msg.from.id,
    chat_id: msg.chat.id,
    log_date: parsed.log_date,
    gross_amount: parsed.gross_amount,
    hours_worked: effectiveHours,
    km_driven: km,
    petrol_cost: petrol,
    start_mileage: Number(active.start_mileage),
    end_mileage: parsed.end_mileage,
    notes: parsed.notes,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { error: insertErr } = await supabase.from('phv_logs').insert(payload);
  if (insertErr) { console.error(insertErr); return send(msg.chat.id, 'Could not save PHV session end log.'); }
  const { error: delErr } = await supabase.from('phv_active_session').delete().eq('telegram_user_id', msg.from.id);
  if (delErr) console.error(delErr);
  const maintenanceItems = await getMaintenanceItems(msg.from.id);
  const c = phvComputed(payload);
  const allLogs = await getPhvRange(msg.from.id, addYears(todayDateString(), -1), todayDateString());
  const comparable = summarizeComparableSessions(allLogs, getDayType(payload.log_date), payload.log_date);
  const score = scoreSession(c.hourlyNet);
  const lines = [
    '<b>PHV session ended</b>',
    `Start time: <b>${escapeHtml(formatDateTime(active.started_at))}</b>`,
    `End time: <b>${escapeHtml(formatDateTime(endedAt))}</b>`,
    `Duration: <b>${escapeHtml(formatDurationHours(effectiveHours))}</b>`,
    `Start mileage: <b>${num(active.start_mileage, 0)}</b>`,
    `End mileage: <b>${num(parsed.end_mileage, 0)}</b>`,
    `Session KM: <b>${num(km)}</b>`,
    `Gross: <b>${currency(payload.gross_amount)}</b>`,
    `Petrol: <b>${currency(petrol)}</b>`,
    `Net: <b>${currency(c.net)}</b>`,
    `Hours: <b>${num(payload.hours_worked)}</b>`,
    `Hourly net: <b>${currency(c.hourlyNet)}</b>`,
    `Score: <b>${score.emoji} ${escapeHtml(score.label)}</b>`,
    `Signal: <b>${escapeHtml(buildStopRecommendation(payload, comparable))}</b>`,
  ];
  if (parsed.hours_worked === null) lines.push('Hours source: <b>auto from Telegram timestamps</b>');
  if (autoPetrol) lines.push('Petrol source: <b>auto-filled from PHV settings</b>');
  lines.push(...maintenanceWatchLines(maintenanceItems, parsed.end_mileage));
  return send(msg.chat.id, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: '🛠 Maintenance', callback_data: 'show:maintstatus' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }]] } });
}
async function handlePhvToday(msg, editContext = null) {
  await ensureUser(msg);
  const logs = await getPhvRange(msg.from.id, todayDateString(), todayDateString());
  if (!logs.length) return editContext ? editOrSend(msg.chat.id, editContext.messageId, 'No PHV logs for today yet.', { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, 'No PHV logs for today yet.', { reply_markup: MAIN_KEYBOARD });
  const s = summarizePhv(logs);
  const score = scoreSession(s.hourlyNet);
  const comparable = summarizeComparableSessions(await getPhvRange(msg.from.id, addYears(todayDateString(), -1), todayDateString()), getDayType(todayDateString()), todayDateString());
  const text = [
    '<b>PHV today</b>',
    `Entries: <b>${s.count}</b>`,
    `Gross: <b>${currency(s.gross)}</b>`,
    `Petrol: <b>${currency(s.petrol)}</b>`,
    `Net: <b>${currency(s.net)}</b>`,
    `Hours: <b>${num(s.hours)}</b>`,
    `Hourly net: <b>${currency(s.hourlyNet)}</b>`,
    `Score: <b>${score.emoji} ${escapeHtml(score.label)}</b>`,
    `Signal: <b>${escapeHtml(buildStopRecommendation({ log_date: todayDateString(), gross_amount: s.gross, petrol_cost: s.petrol, hours_worked: s.hours }, comparable))}</b>`,
  ].join('\n');
  const opts = { reply_markup: { inline_keyboard: [[{ text: '📈 PHV Week', callback_data: 'show:phvweek' }, { text: '❓ Should I Drive', callback_data: 'show:shoulddrive' }]] } };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, opts) : send(msg.chat.id, text, opts);
}
async function handlePhvWeek(msg, editContext = null) {
  await ensureUser(msg);
  const end = todayDateString();
  const start = addDays(end, -6);
  const logs = await getPhvRange(msg.from.id, start, end);
  if (!logs.length) return editContext ? editOrSend(msg.chat.id, editContext.messageId, 'No PHV logs in the past 7 days yet.', { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, 'No PHV logs in the past 7 days yet.', { reply_markup: MAIN_KEYBOARD });
  const s = summarizePhv(logs);
  const score = scoreSession(s.hourlyNet);
  const weekday = summarizePhv(logs.filter((x) => getDayType(x.log_date) === 'weekday'));
  const weekend = summarizePhv(logs.filter((x) => getDayType(x.log_date) === 'weekend'));
  const text = [
    '<b>PHV past 7 days</b>',
    `Range: <b>${escapeHtml(start)}</b> to <b>${escapeHtml(end)}</b>`,
    `Entries: <b>${s.count}</b>`,
    `Gross: <b>${currency(s.gross)}</b>`,
    `Petrol: <b>${currency(s.petrol)}</b>`,
    `Net: <b>${currency(s.net)}</b>`,
    `Hours: <b>${num(s.hours)}</b>`,
    `Avg hourly net: <b>${currency(s.hourlyNet)}</b>`,
    `Overall score: <b>${score.emoji} ${escapeHtml(score.label)}</b>`,
    '',
    '<b>Weekday vs weekend</b>',
    `• Weekday avg hourly net: <b>${currency(weekday.hourlyNet)}</b> from <b>${weekday.count}</b> log(s)`,
    `• Weekend avg hourly net: <b>${currency(weekend.hourlyNet)}</b> from <b>${weekend.count}</b> log(s)`,
  ].join('\n');
  const opts = { reply_markup: { inline_keyboard: [[{ text: '🚗 PHV Today', callback_data: 'show:phvtoday' }, { text: '❓ Should I Drive', callback_data: 'show:shoulddrive' }], [{ text: '🛠 Maintenance', callback_data: 'show:maintstatus' }]] } };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, opts) : send(msg.chat.id, text, opts);
}
async function handleShouldDrive(msg, editContext = null) {
  await ensureUser(msg);
  const logs = await getPhvRange(msg.from.id, addYears(todayDateString(), -1), todayDateString());
  const dayType = getDayType(todayDateString());
  const comparable = summarizeComparableSessions(logs, dayType, todayDateString());
  const advice = buildShouldDriveAdvice(dayType, comparable);
  const text = [
    '<b>Should I drive today?</b>',
    `Today type: <b>${escapeHtml(dayType)}</b>`,
    `Comparable sessions used: <b>${comparable.count}</b>`,
    `Recent avg hourly net: <b>${currency(comparable.hourlyNet)}</b>`,
    '',
    `<b>${escapeHtml(advice.headline)}</b>`,
    `• ${escapeHtml(advice.recommendation)}`,
    `• Confidence: <b>${escapeHtml(advice.confidence)}</b>`,
  ].join('\n');
  const opts = { reply_markup: { inline_keyboard: [[{ text: '🚗 PHV Today', callback_data: 'show:phvtoday' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }], [{ text: '➕ Menu', callback_data: 'show:menu' }]] } };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, opts) : send(msg.chat.id, text, opts);
}

function buildDecisionAdvice(prompt) {
  const text = String(prompt || '').toLowerCase();
  const isDelay = /(wait|later|delay|postpone)/.test(text);
  const isRepair = /(repair|service|servicing|fix)/.test(text);
  const isBuy = /(buy|purchase|spend)/.test(text);
  let recommendation = 'Take the lower-regret option that protects cashflow and avoids avoidable risk.';
  let risk = 'Medium';
  const reasons = ['Check urgency, cash impact, and downside if you wait.', 'Prefer reversible decisions when the facts are unclear.'];
  const actions = ['List the cost now vs cost later.', 'Set a clear review date if you delay.'];
  if (isRepair && isDelay) {
    recommendation = 'Delay only if the issue is non-safety-critical and the downside of waiting is small.';
    risk = 'Medium';
  } else if (isRepair) {
    recommendation = 'Do the repair/service now if it protects safety, reliability, or prevents larger future cost.';
    risk = 'Low to medium';
  } else if (isBuy) {
    recommendation = 'Buy only if it solves a real recurring problem or clearly saves time/money.';
    risk = 'Medium';
  }
  return { recommendation, risk, reasons, actions };
}
async function handleDecide(msg, body) {
  if (!body) return send(msg.chat.id, 'Use: <code>/decide your question</code>');
  await ensureUser(msg);
  const advice = buildDecisionAdvice(body);
  await supabase.from('decision_logs').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, prompt: body, recommendation: advice.recommendation, risk_level: advice.risk, created_at: nowIso() });
  return send(msg.chat.id, [
    '<b>Decision assistant</b>',
    `<b>Your question</b>\n<blockquote>${escapeHtml(body)}</blockquote>`,
    '',
    `<b>Recommendation</b>\n• ${escapeHtml(advice.recommendation)}`,
    '',
    `<b>Risk level</b>\n• ${escapeHtml(advice.risk)}`,
  ].join('\n'), { reply_markup: MAIN_KEYBOARD });
}

async function handleWeekly(msg, editContext = null) {
  await ensureUser(msg);
  const userId = msg.from.id;
  const today = todayDateString();
  const start = addDays(today, -7);
  const [notesRes, tasksRes, dueData, openTasks, phvLogs, maintenanceItems] = await Promise.all([
    supabase.from('notes').select('id', { count: 'exact', head: true }).eq('telegram_user_id', userId).gte('created_at', `${start}T00:00:00+08:00`),
    supabase.from('tasks').select('*').eq('telegram_user_id', userId).gte('created_at', `${start}T00:00:00+08:00`),
    getDueItems(userId),
    getOpenTasks(userId),
    getPhvRange(userId, start, today),
    getMaintenanceItems(userId),
  ]);
  if (notesRes.error || tasksRes.error) return send(msg.chat.id, 'Could not create weekly summary.');
  const tasks = tasksRes.data || [];
  const doneCount = tasks.filter((x) => x.status === 'done').length;
  const openCount = tasks.filter((x) => x.status === 'open').length;
  const phv = summarizePhv(phvLogs);
  const currentOdo = await getCurrentOdometer(userId);
  const dueSoonMaint = currentOdo === null ? [] : maintenanceItems.map((x) => ({ ...x, remaining: Number(x.next_due_mileage) - Number(currentOdo) })).filter((x) => x.remaining <= 1000).slice(0, 3);
  const text = [
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
    `• Net past 7 days: ${currency(phv.net)}`,
    `• Avg hourly net: ${currency(phv.hourlyNet)}`,
    `• KM logged: ${num(phv.km)}`,
    '',
    '<b>Maintenance</b>',
    currentOdo === null ? '• Current odometer not known yet. End one PHV session with mileage first.' : `• Latest odometer: ${num(currentOdo, 0)} km`,
  ];
  dueSoonMaint.forEach((x) => text.push(`• ${escapeHtml(x.item_name)}: ${x.remaining < 0 ? `${Math.abs(x.remaining)} km overdue` : `${Math.round(x.remaining)} km remaining`}`));
  text.push('', '<b>Top open tasks</b>');
  if (openTasks.length) openTasks.slice(0, 5).forEach((t) => text.push(`• ${escapeHtml(t.content)}`)); else text.push('• None');
  const opts = { reply_markup: { inline_keyboard: [[{ text: '📅 Due', callback_data: 'show:due' }, { text: '📈 PHV Week', callback_data: 'show:phvweek' }], [{ text: '🛠 Maintenance', callback_data: 'show:maintstatus' }]] } };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text.join('\n'), opts) : send(msg.chat.id, text.join('\n'), opts);
}

async function handleAddMaintenance(msg, body) {
  const parsed = parseMaintenanceAdd(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/addmaintenance item | interval_km | last_done_mileage</code>');
  await ensureUser(msg);
  const nextDue = Number(parsed.last_done_mileage) + Number(parsed.interval_km);
  const row = { telegram_user_id: msg.from.id, chat_id: msg.chat.id, item_name: parsed.item_name, interval_km: parsed.interval_km, last_done_mileage: parsed.last_done_mileage, next_due_mileage: nextDue, notes: parsed.notes, is_active: true, updated_at: nowIso(), created_at: nowIso() };
  const { error } = await supabase.from('maintenance_items').upsert(row, { onConflict: 'telegram_user_id,item_name' });
  if (error) { console.error(error); return send(msg.chat.id, 'Could not save maintenance item.'); }
  return send(msg.chat.id, `Saved maintenance item:\n<b>${escapeHtml(parsed.item_name)}</b>\nInterval: <b>${num(parsed.interval_km, 0)} km</b>\nLast done: <b>${num(parsed.last_done_mileage, 0)} km</b>\nNext due: <b>${num(nextDue, 0)} km</b>`, { reply_markup: { inline_keyboard: [[{ text: '🛠 View Maintenance', callback_data: 'show:maintstatus' }]] } });
}
async function handleMaintenance(msg, editContext = null) {
  await ensureUser(msg);
  const items = await getMaintenanceItems(msg.from.id);
  if (!items.length) {
    const text = 'No maintenance items yet. Add one with <code>/addmaintenance engine servicing | 8000 | 112000</code>';
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
  }
  const currentOdo = await getCurrentOdometer(msg.from.id);
  const lines = ['<b>Maintenance status</b>'];
  if (currentOdo !== null) lines.push(`Current odometer: <b>${num(currentOdo, 0)} km</b>`, ''); else lines.push('Current odometer: <b>not known yet</b>', '');
  items.forEach((item) => {
    const remaining = currentOdo === null ? null : Number(item.next_due_mileage) - Number(currentOdo);
    const status = remaining === null ? `Due at ${num(item.next_due_mileage, 0)} km` : (remaining < 0 ? `${Math.abs(Math.round(remaining))} km overdue` : `${Math.round(remaining)} km remaining`);
    lines.push(`• <b>${escapeHtml(item.item_name)}</b>`);
    lines.push(`  Last done: ${num(item.last_done_mileage, 0)} km`);
    lines.push(`  Next due: ${num(item.next_due_mileage, 0)} km`);
    lines.push(`  Status: ${escapeHtml(status)}`);
    lines.push('');
  });
  const buttons = { inline_keyboard: items.slice(0, 5).map((x) => [{ text: `✅ Done: ${x.item_name.slice(0, 20)}`, callback_data: `maintdonehint:${x.id}` }]).concat([[{ text: '🔄 Refresh', callback_data: 'show:maintstatus' }, { text: '🚗 Start Session', callback_data: 'show:phvstart' }]]) };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, lines.join('\n').trim(), { reply_markup: buttons }) : send(msg.chat.id, lines.join('\n').trim(), { reply_markup: buttons });
}
async function handleMaintDone(msg, body) {
  const parsed = parseMaintDone(body);
  if (!parsed) return send(msg.chat.id, 'Use: <code>/maintdone item | mileage | optional_cost | optional_note</code>');
  await ensureUser(msg);
  const { data, error } = await supabase.from('maintenance_items').select('*').eq('telegram_user_id', msg.from.id).ilike('item_name', `%${parsed.item_name}%`).eq('is_active', true).limit(1);
  if (error) { console.error(error); return send(msg.chat.id, 'Could not find maintenance item.'); }
  const item = data?.[0];
  if (!item) return send(msg.chat.id, 'No maintenance item matched that keyword.');
  const nextDue = Number(parsed.mileage) + Number(item.interval_km);
  const { error: upErr } = await supabase.from('maintenance_items').update({ last_done_mileage: parsed.mileage, next_due_mileage: nextDue, updated_at: nowIso() }).eq('id', item.id);
  if (upErr) { console.error(upErr); return send(msg.chat.id, 'Could not update maintenance item.'); }
  await supabase.from('maintenance_history').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, maintenance_item_id: item.id, item_name: item.item_name, mileage: parsed.mileage, cost: parsed.cost, notes: parsed.notes, created_at: nowIso() });
  return send(msg.chat.id, `✅ Maintenance marked done\nItem: <b>${escapeHtml(item.item_name)}</b>\nDone at: <b>${num(parsed.mileage, 0)} km</b>\nNext due: <b>${num(nextDue, 0)} km</b>`, { reply_markup: { inline_keyboard: [[{ text: '🛠 View Maintenance', callback_data: 'show:maintstatus' }]] } });
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
  if ((m = trimmed.match(/^phv start\s*:\s*(.+)$/i))) return { type: 'phvstart', body: m[1].trim() };
  if ((m = trimmed.match(/^phv now\s*:\s*(.+)$/i))) return { type: 'phvnow', body: m[1].trim() };
  if ((m = trimmed.match(/^phv end\s*:\s*(.+)$/i))) return { type: 'phvend', body: m[1].trim() };
  if ((m = trimmed.match(/^maintenance\s*:\s*(.+)$/i))) return { type: 'addmaintenance', body: m[1].trim() };
  if ((m = trimmed.match(/^maintenance done\s*:\s*(.+)$/i))) return { type: 'maintdone', body: m[1].trim() };
  if (/^due$/i.test(trimmed)) return { type: 'due' };
  if (/^weekly$/i.test(trimmed)) return { type: 'weekly' };
  if (/^phv today$/i.test(trimmed)) return { type: 'phvtoday' };
  if (/^phv week$/i.test(trimmed)) return { type: 'phvweek' };
  if (/^maintenance$/i.test(trimmed)) return { type: 'maintenance' };
  if (/^phv settings$/i.test(trimmed)) return { type: 'phvsettings' };
  if (/^(should i drive|drive today\??)$/i.test(trimmed)) return { type: 'shoulddrive' };
  if (/^(good morning|gm)$/i.test(trimmed)) return { type: 'gm' };
  if ((m = trimmed.match(/^news(?:\s+(world|business|singapore|top))?$/i))) return { type: 'news', body: (m[1] || 'top').trim() };
  if (/^(grants|grant directory)$/i.test(trimmed)) return { type: 'grants' };
  if (/^(latest grants|grant updates)$/i.test(trimmed)) return { type: 'latestgrants' };
  if (/^(support|supportable programmes)$/i.test(trimmed)) return { type: 'support' };
  if (/^(link hub|linkhub)$/i.test(trimmed)) return { type: 'linkhub' };
  return null;
}
async function handleNaturalLanguage(msg, parsed) {
  switch (parsed.type) {
    case 'note': return handleNote(msg, parsed.body, parsed.noteType || 'note');
    case 'task': return handleTask(msg, parsed.body);
    case 'done': return handleDone(msg, parsed.body);
    case 'search': return handleSearch(msg, parsed.body);
    case 'decide': return handleDecide(msg, parsed.body);
    case 'adminadd': return handleAdminAdd(msg, parsed.body);
    case 'admindone': return handleAdminDone(msg, parsed.body);
    case 'due': return handleDue(msg);
    case 'weekly': return handleWeekly(msg);
    case 'phvlog': return handlePhvLog(msg, parsed.body);
    case 'phvstart': return handlePhvStart(msg, parsed.body);
    case 'phvnow': return handlePhvNow(msg, parsed.body);
    case 'phvend': return handlePhvEnd(msg, parsed.body);
    case 'phvtoday': return handlePhvToday(msg);
    case 'phvweek': return handlePhvWeek(msg);
    case 'phvsettings': return handlePhvSettings(msg);
    case 'shoulddrive': return handleShouldDrive(msg);
    case 'gm': return handleGrantDigest(msg);
    case 'news': return handleNews(msg, parsed.body);
    case 'grants': return handleGrants(msg);
    case 'latestgrants': return handleLatestGrants(msg);
    case 'support': return handleSupport(msg);
    case 'linkhub': return handleLinkHub(msg);
    case 'maintenance': return handleMaintenance(msg);
    case 'addmaintenance': return handleAddMaintenance(msg, parsed.body);
    case 'maintdone': return handleMaintDone(msg, parsed.body);
    default: return send(msg.chat.id, 'Unknown input. Use /help');
  }
}



function normalizeGrantText(value = '') {
  return String(value || '').trim().toLowerCase();
}

function detectIndustryAlias(text = '') {
  const lower = normalizeGrantText(text);
  if (/(f&b|fnb|food|beverage|restaurant|cafe|hawker)/.test(lower)) return 'f&b';
  if (/(retail|shop|store|merchant)/.test(lower)) return 'retail';
  if (/(manufacturing|factory|maker|production)/.test(lower)) return 'manufacturing';
  if (/(service|services|agency|consultancy)/.test(lower)) return 'services';
  if (/(startup|founder|new business)/.test(lower)) return 'startup';
  return null;
}

async function getActiveSupports(limit = 80) {
  const { data, error } = await supabase
    .from('grants_master')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true })
    .limit(limit);
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

async function getLatestGrantUpdates(limit = 8) {
  const { data, error } = await supabase
    .from('grant_updates')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

function formatSupportDirectory(items, title = 'Grants & Support') {
  if (!items.length) return 'No grants or support programmes found yet.';
  const grouped = {};
  for (const item of items) {
    const key = item.category || 'Other Support';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }
  const lines = [`<b>${escapeHtml(title)}</b>`, ''];
  Object.keys(grouped).sort().forEach((group) => {
    lines.push(`<b>${escapeHtml(group)}</b>`);
    grouped[group].forEach((item) => {
      lines.push(`• <b>${escapeHtml(item.name)}</b> (${escapeHtml(item.support_type || 'Support')})`);
      if (item.description) lines.push(`  ${escapeHtml(item.description)}`);
      if (item.webpage) lines.push(`  ${escapeHtml(item.webpage)}`);
    });
    lines.push('');
  });
  return lines.join('\n').trim();
}

function formatLinkHub(items) {
  if (!items.length) return 'No support links found yet.';
  const lines = ['<b>One-Stop Support Link Hub</b>', ''];
  items.slice(0, 18).forEach((item) => {
    lines.push(`• <b>${escapeHtml(item.name)}</b>`);
    if (item.webpage) lines.push(`  ${escapeHtml(item.webpage)}`);
  });
  return lines.join('\n');
}

function isMeaningfulGrantUpdate(item) {
  const title = normalizeGrantText(item?.title || '');
  const summary = normalizeGrantText(item?.summary || '');
  if (!title && !summary) return false;
  const placeholderTerms = [
    'track new sme grant',
    'use this table',
    'support directory now includes',
    'use /industrygrant',
    'matchgrant now returns',
    'grants intelligence layer'
  ];
  return !placeholderTerms.some((term) => title.includes(term) || summary.includes(term));
}

function formatGrantUpdatesText(items) {
  const meaningful = (items || []).filter(isMeaningfulGrantUpdate);
  if (!meaningful.length) {
    return [
      '<b>Latest Grants & Programme Updates</b>',
      '',
      'No useful grant updates saved yet.',
      'Add real updates into <b>grant_updates</b> for this section to become useful.'
    ].join('\n');
  }
  const lines = ['<b>Latest Grants & Programme Updates</b>', ''];
  meaningful.forEach((item) => {
    lines.push(`• <b>${escapeHtml(item.title)}</b>`);
    if (item.summary) lines.push(`  ${escapeHtml(item.summary)}`);
    if (item.client_angle) lines.push(`  Useful for clients: ${escapeHtml(item.client_angle)}`);
    if (item.webpage) lines.push(`  ${escapeHtml(item.webpage)}`);
  });
  return lines.join('\n');
}


function scoreSupportMatch(item, queryText, industry) {
  const q = normalizeGrantText(queryText);
  let score = Number(item.priority || 0);
  const haystacks = [];
  if (item.name) haystacks.push(normalizeGrantText(item.name));
  if (item.description) haystacks.push(normalizeGrantText(item.description));
  for (const k of item.keywords || []) haystacks.push(normalizeGrantText(k));
  for (const k of item.problem_solved || []) haystacks.push(normalizeGrantText(k));
  for (const k of item.industries || []) haystacks.push(normalizeGrantText(k));
  for (const h of haystacks) {
    if (h && q.includes(h)) score += 15;
    if (h && h.includes(q) && q.length >= 4) score += 8;
  }
  for (const token of q.split(/[^a-z0-9&+]+/).filter(Boolean)) {
    if (haystacks.some((h) => h.includes(token))) score += 4;
  }
  if (industry && Array.isArray(item.industries)) {
    const inds = item.industries.map((x) => normalizeGrantText(x));
    if (inds.includes(industry) || inds.includes('all')) score += 20;
  }
  return score;
}

function formatSupportStack(items, queryText, industry) {
  if (!items.length) return `No strong support match found for: <b>${escapeHtml(queryText)}</b>`;
  const funding = items.filter((x) => /funding/i.test(x.support_level || '') || /grant/i.test(x.support_type || ''));
  const execution = items.filter((x) => /execution/i.test(x.support_level || '') || /centre|programme|ihl support/i.test(x.support_type || ''));
  const capability = items.filter((x) => /capability/i.test(x.support_level || ''));
  const lines = ['<b>Recommended Support Stack</b>', `Need: <b>${escapeHtml(queryText)}</b>`];
  if (industry) lines.push(`Industry detected: <b>${escapeHtml(industry)}</b>`);
  lines.push('');
  if (funding.length) {
    lines.push('<b>Funding layer</b>');
    funding.slice(0, 3).forEach((item) => {
      lines.push(`• <b>${escapeHtml(item.name)}</b>`);
      if (item.description) lines.push(`  ${escapeHtml(item.description)}`);
    });
    lines.push('');
  }
  if (execution.length) {
    lines.push('<b>Execution / implementation layer</b>');
    execution.slice(0, 3).forEach((item) => {
      lines.push(`• <b>${escapeHtml(item.name)}</b>`);
      if (item.description) lines.push(`  ${escapeHtml(item.description)}`);
    });
    lines.push('');
  }
  if (capability.length) {
    lines.push('<b>Capability / training layer</b>');
    capability.slice(0, 3).forEach((item) => {
      lines.push(`• <b>${escapeHtml(item.name)}</b>`);
      if (item.description) lines.push(`  ${escapeHtml(item.description)}`);
    });
    lines.push('');
  }
  const links = items.filter((x) => x.webpage).slice(0, 5);
  if (links.length) {
    lines.push('<b>Links</b>');
    links.forEach((item) => lines.push(`• ${escapeHtml(item.name)} — ${escapeHtml(item.webpage)}`));
  }
  return lines.join('\n').trim();
}

async function handleGrants(msg, editContext = null) {
  const items = await getActiveSupports(40);
  const text = formatSupportDirectory(items, 'Grants & Support Directory');
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

async function handleSupport(msg, editContext = null) {
  const items = await getActiveSupports(50);
  const text = formatSupportDirectory(items, 'All Grants, Programmes, FIRCs & IHL Support');
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

async function handleLinkHub(msg, editContext = null) {
  const items = await getActiveSupports(50);
  const text = formatLinkHub(items);
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

async function handleLatestGrants(msg, editContext = null) {
  const items = await getLatestGrantUpdates(8);
  const text = formatGrantUpdatesText(items);
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

async function handleIndustryGrant(msg, body, editContext = null) {
  const industry = detectIndustryAlias(body) || normalizeGrantText(body);
  if (!industry) return send(msg.chat.id, 'Use: <code>/industrygrant f&b</code> or <code>/industrygrant retail</code>');
  const items = await getActiveSupports(80);
  const filtered = items.filter((item) => {
    const inds = (item.industries || []).map((x) => normalizeGrantText(x));
    return inds.includes('all') || inds.includes(industry);
  });
  const text = formatSupportDirectory(filtered, `Support for ${industry}`);
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

async function handleMatchGrant(msg, body, editContext = null) {
  if (!body) return send(msg.chat.id, 'Use: <code>/matchgrant retail wants chatbot</code>');
  const items = await getActiveSupports(80);
  const industry = detectIndustryAlias(body);
  const ranked = items
    .map((item) => ({ item, score: scoreSupportMatch(item, body, industry) }))
    .filter((x) => x.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.item);
  const text = formatSupportStack(ranked, body, industry);
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: MAIN_KEYBOARD }) : send(msg.chat.id, text, { reply_markup: MAIN_KEYBOARD });
}

function buildDueSnapshotText(reminders, adminItems) {
  const lines = ['<b>📅 Due status</b>'];
  if (!reminders.length && !adminItems.length) {
    lines.push('• Nothing urgent right now.');
    return lines.join('\n');
  }
  reminders.slice(0, 3).forEach((r) => {
    lines.push(`• ${escapeHtml(formatDateTime(r.remind_at))} — ${escapeHtml(r.content)}`);
  });
  adminItems.slice(0, 3).forEach((a) => {
    lines.push(`• ${escapeHtml(a.title)} — ${escapeHtml(a.next_due_date)} (${escapeHtml(humanDueLabel(dueInDays(a.next_due_date)))})`);
  });
  return lines.join('\n');
}

async function buildPhvTodaySnapshotText(userId) {
  const logs = await getPhvRange(userId, todayDateString(), todayDateString());
  if (!logs.length) return '<b>🚗 PHV status</b>\n• No PHV logs for today yet.';
  const s = summarizePhv(logs);
  const score = scoreSession(s.hourlyNet);
  return [
    '<b>🚗 PHV status</b>',
    `• Gross: <b>${currency(s.gross)}</b>`,
    `• Petrol: <b>${currency(s.petrol)}</b>`,
    `• Net: <b>${currency(s.net)}</b>`,
    `• Hours: <b>${num(s.hours)}</b>`,
    `• Hourly net: <b>${currency(s.hourlyNet)}</b>`,
    `• Score: <b>${score.emoji} ${escapeHtml(score.label)}</b>`,
  ].join('\n');
}


function decodeXmlEntities(text = '') {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripHtmlTags(text = '') {
  return decodeXmlEntities(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function buildTldr(text = '', maxLen = 220) {
  const cleaned = stripHtmlTags(text);
  if (!cleaned) return 'TLDR: Tap the headline to read more.';
  if (cleaned.length <= maxLen) return `TLDR: ${cleaned}`;
  const cut = cleaned.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `TLDR: ${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function parseRssItems(xml = '', limit = 10) {
  const items = [];
  const source = String(xml || '');

  const blocks = [
    ...(source.match(/<item\b[\s\S]*?<\/item>/gi) || []),
    ...(source.match(/<entry\b[\s\S]*?<\/entry>/gi) || []),
  ];

  for (const block of blocks) {
    const titleMatch = block.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
    const linkHrefMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    const linkTagMatch = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
    const descMatch =
      block.match(/<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/i) ||
      block.match(/<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i) ||
      block.match(/<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i);

    const title = stripHtmlTags(titleMatch ? titleMatch[1] : '');
    let link = decodeXmlEntities(linkHrefMatch ? linkHrefMatch[1] : (linkTagMatch ? linkTagMatch[1] : '')).trim();
    const description = decodeXmlEntities(descMatch ? descMatch[1] : '').trim();

    if (link.startsWith('./')) {
      link = `https://news.google.com/${link.replace(/^\.\//, '')}`;
    }

    if (!title || !link) continue;
    if (items.some((x) => x.link === link || x.title === title)) continue;
    items.push({ title, link, summary: description });
    if (items.length >= limit) break;
  }

  return items;
}

async function fetchRssItemsFromUrl(url, limit = 10) {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 TelegramBot/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      },
      maxRedirects: 5
    });
    const xml = String(response.data || '');
    return parseRssItems(xml, limit);
  } catch (err) {
    console.error(`RSS fetch failed for ${url}:`, err.message);
    return [];
  }
}

async function fetchGoogleNews(category = 'top', limit = 10) {
  const sourceMap = {
    top: [
      'https://news.google.com/rss?hl=en-SG&gl=SG&ceid=SG:en',
      'https://www.channelnewsasia.com/rssfeeds/8395986',
      'https://feeds.bbci.co.uk/news/rss.xml'
    ],
    world: [
      'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-SG&gl=SG&ceid=SG:en',
      'https://news.google.com/rss/search?q=world&hl=en-SG&gl=SG&ceid=SG:en',
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://feeds.skynews.com/feeds/rss/world.xml'
    ],
    business: [
      'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-SG&gl=SG&ceid=SG:en',
      'https://news.google.com/rss/search?q=business&hl=en-SG&gl=SG&ceid=SG:en',
      'https://feeds.bbci.co.uk/news/business/rss.xml',
      'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936'
    ],
    singapore: [
      'https://news.google.com/rss/search?q=Singapore&hl=en-SG&gl=SG&ceid=SG:en',
      'https://www.channelnewsasia.com/rssfeeds/8395986'
    ]
  };

  const urls = sourceMap[category] || sourceMap.top;

  for (const url of urls) {
    const items = await fetchRssItemsFromUrl(url, limit);
    if (items.length) return items;
  }

  return [];
}

function formatNewsItems(items = [], header = '📰 News', maxItems = 8) {
  const lines = [`<b>${escapeHtml(header)}</b>`];
  if (!items.length) {
    lines.push('No live news items are available right now.');
    return lines.join('\n');
  }
  items.slice(0, maxItems).forEach((item, idx) => {
    lines.push('');
    lines.push(`${idx + 1}. <a href="${escapeHtml(item.link)}">${escapeHtml(item.title)}</a>`);
    lines.push(escapeHtml(buildTldr(item.summary)));
  });
  return lines.join('\n');
}

async function handleNews(msg, body = '', editContext = null) {
  await ensureUser(msg);
  const categoryRaw = normalizeGrantText(body || 'top');
  const category = ['top', 'world', 'business', 'singapore'].includes(categoryRaw) ? categoryRaw : 'top';
  const headerMap = {
    top: '📰 Top News',
    world: '🌍 World News',
    business: '💼 Business News',
    singapore: '🇸🇬 Singapore News'
  };
  const items = await fetchGoogleNews(category, 12);
  const text = formatNewsItems(items, headerMap[category], 12);
  const buttons = {
    inline_keyboard: [
      [
        { text: 'Top', callback_data: 'show:news:top' },
        { text: 'Singapore', callback_data: 'show:news:singapore' },
        { text: 'Business', callback_data: 'show:news:business' },
        { text: 'World', callback_data: 'show:news:world' }
      ]
    ]
  };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, { reply_markup: buttons }) : send(msg.chat.id, text, { reply_markup: buttons });
}

async function handleGrantDigest(msg) {
  await ensureUser(msg);
  const [{ reminders, adminItems }, phvText, topItems, singaporeItems, businessItems] = await Promise.all([
    getDueItems(msg.from.id),
    buildPhvTodaySnapshotText(msg.from.id),
    fetchGoogleNews('top', 4),
    fetchGoogleNews('singapore', 4),
    fetchGoogleNews('business', 4),
  ]);
  const lines = [
    '<b>Good morning ☀️</b>',
    '',
    formatNewsItems(topItems, '📰 Top News', 4),
    '',
    formatNewsItems(singaporeItems, '🇸🇬 Singapore News', 4),
    '',
    formatNewsItems(businessItems, '💼 Business News', 4),
    '',
    buildDueSnapshotText(reminders, adminItems),
    '',
    phvText,
  ];
  return send(msg.chat.id, lines.join('\n'), { reply_markup: MAIN_KEYBOARD });
}


function extractReceiptFields(text) {
  const clean = String(text || '').replace(/\r/g, '');
  const amountMatches = [...clean.matchAll(/(?:s\$|\$|sgd\s*)\s?(\d{1,4}(?:\.\d{2})?)/ig)].map((m) => parseFloat(m[1]));
  const looseAmounts = [...clean.matchAll(/\b(\d{1,4}\.\d{2})\b/g)].map((m) => parseFloat(m[1]));
  const allAmounts = [...amountMatches, ...looseAmounts].filter((n) => Number.isFinite(n) && n > 0);
  const bestAmount = allAmounts.length ? Math.max(...allAmounts) : null;
  const mileageMatch = clean.match(/(?:odometer|mileage|km|odo)\D{0,10}(\d{4,7})/i) || clean.match(/\b(\d{5,7})\s?km\b/i);
  const mileage = mileageMatch ? parseFloat(mileageMatch[1]) : null;
  const dateMatch = clean.match(/(\d{4}-\d{2}-\d{2})/) || clean.match(/(\d{2}[\/\-]\d{2}[\/\-]\d{4})/);
  return { amount: bestAmount, mileage, date: dateMatch ? dateMatch[1] : null, raw_text: clean.slice(0, 3000) };
}
async function runReceiptOcr(fileUrl) {
  const worker = await Tesseract.createWorker('eng');
  try {
    const { data } = await worker.recognize(fileUrl);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}
async function handlePhotoReceipt(msg) {
  await ensureUser(msg);
  const photo = msg.photo?.[msg.photo.length - 1];
  if (!photo) return;
  try {
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    await send(msg.chat.id, 'Reading the screenshot / receipt now. This can take a bit on free hosting.');
    const ocrText = await runReceiptOcr(fileUrl);
    const fields = extractReceiptFields(ocrText);
    const caption = String(msg.caption || '').toLowerCase();
    const hint = caption.includes('fuel') ? 'fuel' : (caption.includes('maint') || caption.includes('service') ? 'maintenance' : (caption.includes('insur') ? 'insurance' : 'general'));
    const { data: saved, error } = await supabase.from('receipt_scans').insert({ telegram_user_id: msg.from.id, chat_id: msg.chat.id, source_hint: hint, ocr_text: fields.raw_text, amount: fields.amount, mileage: fields.mileage, parsed_date: fields.date, created_at: nowIso() }).select('*').single();
    if (error) throw error;
    pendingReceiptActions.set(msg.from.id, saved.id);
    const lines = [
      '<b>Receipt / screenshot read complete</b>',
      `Hint: <b>${escapeHtml(hint)}</b>`,
      `Amount found: <b>${fields.amount !== null ? currency(fields.amount) : 'not found'}</b>`,
      `Mileage found: <b>${fields.mileage !== null ? `${num(fields.mileage, 0)} km` : 'not found'}</b>`,
      `Date found: <b>${escapeHtml(fields.date || 'not found')}</b>`,
      '',
      '<b>OCR preview</b>',
      `<blockquote>${escapeHtml((fields.raw_text || '').slice(0, 500) || 'No text extracted.')}</blockquote>`,
      '',
      'Choose what you want to do with this receipt:',
    ];
    return send(msg.chat.id, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⛽ Save Fuel Expense', callback_data: `receipt:fuel:${saved.id}` }, { text: '🛠 Save Maintenance Done', callback_data: `receipt:maintenance:${saved.id}` }],
          [{ text: '📅 Save Admin Item', callback_data: `receipt:admin:${saved.id}` }, { text: '🗑 Ignore', callback_data: `receipt:ignore:${saved.id}` }],
        ],
      },
    });
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not read that screenshot. Try a clearer image with larger text.');
  }
}

async function routeMessage(msg) {
  if (msg.photo?.length) return handlePhotoReceipt(msg);
  if (!msg.text) return;
  const text = msg.text.trim();

  const pending = pendingInputs.get(msg.from.id);
  if (pending && !text.startsWith('/')) {
    if (pending.kind === 'phvsetting') {
      const value = Number(text.replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(value)) return send(msg.chat.id, 'Please send a number only. Example: <code>3.46</code>');
      const { error } = await supabase.from('phv_settings').update({ [pending.field]: value, updated_at: nowIso() }).eq('telegram_user_id', msg.from.id);
      pendingInputs.delete(msg.from.id);
      if (error) { console.error(error); return send(msg.chat.id, 'Could not update PHV setting.'); }
      await send(msg.chat.id, `Updated <b>${escapeHtml(pending.field)}</b> to <b>${escapeHtml(String(value))}</b>.`);
      return handlePhvSettings(msg);
    }
    if (pending.kind === 'phvstart') {
      pendingInputs.delete(msg.from.id);
      return handlePhvStart(msg, text);
    }
    if (pending.kind === 'phvnow') {
      pendingInputs.delete(msg.from.id);
      return handlePhvNow(msg, text);
    }
    if (pending.kind === 'phvend') {
      pendingInputs.delete(msg.from.id);
      return handlePhvEnd(msg, text);
    }
    if (pending.kind === 'maintdone') {
      pendingInputs.delete(msg.from.id);
      return handleMaintDone(msg, text);
    }
  }

  const natural = parseNaturalLanguage(text);
  if (!text.startsWith('/') && natural) return handleNaturalLanguage(msg, natural);

  const [command, ...rest] = text.split(' ');
  const body = rest.join(' ').trim();
  switch (command.toLowerCase()) {
    case '/start': return handleStart(msg);
    case '/help':
    case '/menu': return showHelp(msg.chat.id);
    case '/note': return handleNote(msg, body, 'note');
    case '/idea': return handleNote(msg, body, 'idea');
    case '/task': return handleTask(msg, body);
    case '/done': return handleDone(msg, body);
    case '/search': return handleSearch(msg, body);
    case '/remind': return handleRemind(msg, body);
    case '/adminadd': return handleAdminAdd(msg, body);
    case '/admindone': return handleAdminDone(msg, body);
    case '/due': return handleDue(msg);
    case '/weekly': return handleWeekly(msg);
    case '/phvlog': return handlePhvLog(msg, body);
    case '/phvstart': return handlePhvStart(msg, body);
    case '/phvnow': return handlePhvNow(msg, body);
    case '/phvend': return handlePhvEnd(msg, body);
    case '/phvtoday': return handlePhvToday(msg);
    case '/phvweek': return handlePhvWeek(msg);
    case '/phvsettings': return handlePhvSettings(msg);
    case '/shoulddrive': return handleShouldDrive(msg);
    case '/gm': return handleGrantDigest(msg);
    case '/news': return handleNews(msg, body);
    case '/decide': return handleDecide(msg, body);
    case '/addmaintenance': return handleAddMaintenance(msg, body);
    case '/maintenance':
    case '/maintstatus': return handleMaintenance(msg);
    case '/maintdone': return handleMaintDone(msg, body);
    default: return showHelp(msg.chat.id);
  }
}

async function routeCallback(query) {
  const msg = query.message;
  const fauxMsg = { chat: msg.chat, from: query.from };
  const data = query.data || '';
  try {
    if (data === 'show:menu') return showHelp(msg.chat.id);
    if (data === 'show:due') return handleDue(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:weekly') return handleWeekly(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:phvtoday') return handlePhvToday(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:phvweek') return handlePhvWeek(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:phvsettings') return handlePhvSettings(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:shoulddrive') return handleShouldDrive(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:maintstatus') return handleMaintenance(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:news') return handleNews(fauxMsg, 'top', { messageId: msg.message_id });
    if (data.startsWith('show:news:')) return handleNews(fauxMsg, data.split(':')[2], { messageId: msg.message_id });
    if (data === 'show:phvstart') {
      pendingInputs.set(query.from.id, { kind: 'phvstart' });
      return send(msg.chat.id, 'Send your starting mileage. Example: <code>112280</code>');
    }
    if (data === 'show:phvnow') {
      pendingInputs.set(query.from.id, { kind: 'phvnow' });
      return send(msg.chat.id, 'Send: <code>gross:62 | current:112314</code>\nOptional: add <code>| hours:1.8</code> to override auto timing.');
    }
    if (data === 'show:phvend') {
      pendingInputs.set(query.from.id, { kind: 'phvend' });
      return send(msg.chat.id, 'Send: <code>112348 | gross:145</code>\nOptional: add <code>| hours:2.5</code> to override auto timing.');
    }
    if (data === 'hint:note') return send(msg.chat.id, 'Send a note like: <code>note: check tyre pressure</code>');
    if (data === 'hint:task') return send(msg.chat.id, 'Send a task like: <code>task: renew road tax</code>');
    if (data.startsWith('admindoneid:')) {
      const id = data.split(':')[1];
      const { data: row, error } = await supabase.from('admin_items').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return completeAdminItem(msg.chat.id, row);
    }
    if (data.startsWith('maintdonehint:')) {
      const id = data.split(':')[1];
      const { data: row, error } = await supabase.from('maintenance_items').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      pendingInputs.set(query.from.id, { kind: 'maintdone' });
      return send(msg.chat.id, `Send: <code>${escapeHtml(row.item_name)} | 120000 | optional_cost | optional_note</code>`);
    }
    if (data === 'phvset:togglemode') {
      const settings = await getOrCreatePhvSettings(fauxMsg);
      const nextMode = settings.mode === 'auto' ? 'simple' : 'auto';
      const { error } = await supabase.from('phv_settings').update({ mode: nextMode, updated_at: nowIso() }).eq('telegram_user_id', query.from.id);
      if (error) throw error;
      return handlePhvSettings(fauxMsg, { messageId: msg.message_id });
    }
    if (data.startsWith('phvset:')) {
      const field = data.split(':')[1];
      pendingInputs.set(query.from.id, { kind: 'phvsetting', field });
      return send(msg.chat.id, `Send the new value for <b>${escapeHtml(field)}</b>.`);
    }
    if (data.startsWith('receipt:')) {
      const [, action, id] = data.split(':');
      const { data: row, error } = await supabase.from('receipt_scans').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!row) return send(msg.chat.id, 'Receipt record not found.');
      if (action === 'ignore') {
        await supabase.from('receipt_scans').update({ status: 'ignored' }).eq('id', id);
        return send(msg.chat.id, 'Ignored that receipt.');
      }
      if (action === 'fuel') {
        await supabase.from('receipt_scans').update({ status: 'saved_fuel' }).eq('id', id);
        return send(msg.chat.id, `Saved as fuel reference. Amount found: <b>${row.amount !== null ? currency(row.amount) : 'not found'}</b>\nThis does not overwrite your PHV logs automatically.`);
      }
      if (action === 'maintenance') {
        pendingInputs.set(query.from.id, { kind: 'maintdone' });
        await supabase.from('receipt_scans').update({ status: 'maintenance_pending' }).eq('id', id);
        return send(msg.chat.id, `Send maintenance save info in this format:\n<code>engine servicing | ${row.mileage || '120000'} | ${row.amount || ''} | from receipt</code>`);
      }
      if (action === 'admin') {
        await supabase.from('receipt_scans').update({ status: 'admin_pending' }).eq('id', id);
        return send(msg.chat.id, `Send admin item in this format:\n<code>insurance | ${row.parsed_date || todayDateString()} | yearly | 30,7,1</code>`);
      }
    }
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'That button action failed.');
  }
}

app.get('/', (_req, res) => res.send('Bot is running.'));
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.post(`/webhook/${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    if (update.message) await routeMessage(update.message);
    if (update.callback_query) {
      await bot.answerCallbackQuery(update.callback_query.id).catch(() => {});
      await routeCallback(update.callback_query);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});

(async function start() {
  try {
    const webhookTarget = `${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`;
    await bot.setWebHook(webhookTarget);
    console.log(`Webhook configured: ${webhookTarget}`);
  } catch (err) {
    console.error('Webhook setup error', err);
  }
})();
