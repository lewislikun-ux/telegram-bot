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
      { text: '🏛 Grants', callback_data: 'show:grants' },
      { text: '🆕 Grant Updates', callback_data: 'show:latestgrants' },
    ],
    [
      { text: '🏭 By Industry', callback_data: 'show:industryhelp' },
      { text: '🔗 Link Hub', callback_data: 'show:linkhub' },
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



async function getGrantSupports(limit = 40) {
  const { data, error } = await supabase
    .from('grants_master')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: false, nullsFirst: false })
    .order('category', { ascending: true })
    .order('name', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
async function getGrantUpdates(limit = 8) {
  const { data, error } = await supabase
    .from('grant_updates')
    .select('*')
    .order('effective_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
function groupGrantSupports(items) {
  const grouped = {};
  (items || []).forEach((item) => {
    const key = item.category || 'Other';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });
  return grouped;
}
function normalizeGrantKeyword(value) {
  return String(value || '').trim().toLowerCase();
}
const GRANT_INDUSTRY_ALIASES = {
  'fnb': 'f&b',
  'food and beverage': 'f&b',
  'food': 'f&b',
  'retail shop': 'retail',
  'shop': 'retail',
  'factory': 'manufacturing',
  'maker': 'manufacturing',
  'service': 'services',
  'startup company': 'startup',
  'new business': 'startup',
};
const GRANT_PROBLEM_PATTERNS = [
  { tag: 'digitalisation', keywords: ['digital', 'software', 'system', 'crm', 'pos', 'erp', 'hr', 'accounting', 'qr ordering'] },
  { tag: 'automation', keywords: ['automation', 'automate', 'chatbot', 'ai', 'analytics'] },
  { tag: 'business transformation', keywords: ['branding', 'growth', 'transformation', 'consultancy', 'strategy', 'process'] },
  { tag: 'overseas expansion', keywords: ['overseas', 'export', 'market entry', 'internationalisation', 'distributor'] },
  { tag: 'energy saving', keywords: ['aircon', 'chiller', 'energy', 'utility', 'equipment', 'efficiency'] },
  { tag: 'product development', keywords: ['product development', 'testing', 'shelf life', 'pilot', 'formulation'] },
  { tag: 'workforce training', keywords: ['training', 'upskill', 'reskill', 'skillsfuture', 'course'] },
];
function grantArray(value) {
  return Array.isArray(value) ? value : [];
}
function grantSupportsIndustry(item, industry) {
  if (!industry) return true;
  const list = grantArray(item.industries).map(normalizeGrantKeyword);
  return list.includes('all') || list.includes(normalizeGrantKeyword(industry));
}
function detectIndustryFromText(text) {
  const q = normalizeGrantKeyword(text);
  const aliasHit = Object.keys(GRANT_INDUSTRY_ALIASES).find((key) => q.includes(key));
  if (aliasHit) return GRANT_INDUSTRY_ALIASES[aliasHit];
  const candidates = ['f&b', 'retail', 'manufacturing', 'services', 'startup'];
  return candidates.find((x) => q.includes(x)) || null;
}
function detectProblemTags(text) {
  const q = normalizeGrantKeyword(text);
  return GRANT_PROBLEM_PATTERNS
    .filter((row) => row.keywords.some((kw) => q.includes(kw)))
    .map((row) => row.tag);
}
function scoreGrantMatch(item, queryText, detectedIndustry = null, detectedTags = []) {
  const q = normalizeGrantKeyword(queryText);
  if (!q) return 0;
  let score = 0;
  const keywords = grantArray(item.keywords);
  keywords.forEach((kw) => {
    const k = normalizeGrantKeyword(kw);
    if (!k) return;
    if (q.includes(k)) score += Math.max(3, k.split(' ').length);
  });
  if (detectedIndustry && grantSupportsIndustry(item, detectedIndustry)) score += 4;
  const itemTags = grantArray(item.problem_solved).map(normalizeGrantKeyword);
  detectedTags.forEach((tag) => {
    if (itemTags.includes(normalizeGrantKeyword(tag))) score += 4;
  });
  const haystacks = [item.name, item.category, item.description, item.support_type, item.agency].map((x) => normalizeGrantKeyword(x));
  haystacks.forEach((field) => {
    if (field && q.includes(field)) score += 2;
    else if (field && field.split(' ').some((token) => token && q.includes(token))) score += 1;
  });
  if ((item.support_type || '').toLowerCase() === 'grant') score += 1;
  if (Number.isFinite(Number(item.priority))) score += Number(item.priority) / 10;
  return score;
}
function formatGrantSupportLine(item, { includeWebpage = true, includeMeta = true } = {}) {
  const lines = [`• <b>${escapeHtml(item.name || 'Untitled')}</b>`];
  const meta = [];
  if (includeMeta && item.support_type) meta.push(item.support_type);
  if (includeMeta && item.agency) meta.push(item.agency);
  if (meta.length) lines.push(`  ${escapeHtml(meta.join(' · '))}`);
  if (item.description) lines.push(`  ${escapeHtml(item.description)}`);
  if (item.eligibility_summary) lines.push(`  Who should use this: ${escapeHtml(item.eligibility_summary)}`);
  if (includeWebpage && item.webpage) lines.push(`  ${escapeHtml(item.webpage)}`);
  return lines.join('\n');
}
function formatGrantSupportList(items, { title = '<b>Grants & Support</b>', compact = false } = {}) {
  if (!items.length) return `${title}\n\nNo active grant or programme records found yet.`;
  const grouped = groupGrantSupports(items);
  const lines = [title, ''];
  Object.keys(grouped).sort().forEach((category) => {
    lines.push(`<b>${escapeHtml(category)}</b>`);
    grouped[category].forEach((item) => lines.push(formatGrantSupportLine(item, { includeWebpage: !compact, includeMeta: true })));
    lines.push('');
  });
  return lines.join('\n').trim();
}
function formatGrantLinkHub(items) {
  if (!items.length) return '<b>Grant Link Hub</b>\n\nNo active records found yet.';
  const grouped = groupGrantSupports(items);
  const lines = ['<b>Grant Link Hub</b>', '', 'One-stop list of grants, programmes, FIRCs and IHL support links.', ''];
  Object.keys(grouped).sort().forEach((category) => {
    lines.push(`<b>${escapeHtml(category)}</b>`);
    grouped[category].forEach((item) => {
      lines.push(`• <b>${escapeHtml(item.name || 'Untitled')}</b>`);
      if (item.webpage) lines.push(`  ${escapeHtml(item.webpage)}`);
    });
    lines.push('');
  });
  return lines.join('\n').trim();
}
function formatGrantUpdates(updates) {
  if (!updates.length) return '<b>Latest grant updates</b>\n\nNo update records found yet.';
  const lines = ['<b>Latest grant updates</b>', ''];
  updates.forEach((item) => {
    lines.push(`• <b>${escapeHtml(item.title || 'Untitled update')}</b>`);
    if (item.summary) lines.push(`  ${escapeHtml(item.summary)}`);
    if (item.client_angle) lines.push(`  Useful for clients: ${escapeHtml(item.client_angle)}`);
    if (item.webpage) lines.push(`  ${escapeHtml(item.webpage)}`);
  });
  return lines.join('\n');
}
function buildSupportStackFromMatches(matches) {
  const buckets = {
    funding: [],
    execution: [],
    capability: [],
  };
  matches.forEach((item) => {
    const level = normalizeGrantKeyword(item.support_level || item.category);
    if (level.includes('funding') || level.includes('grant') || (item.support_type || '').toLowerCase() === 'grant') buckets.funding.push(item);
    else if (level.includes('execution') || level.includes('centre') || level.includes('programme')) buckets.execution.push(item);
    else buckets.capability.push(item);
  });
  return buckets;
}
async function handleGrants(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const items = await getGrantSupports();
    const text = formatGrantSupportList(items);
    const extra = { reply_markup: { inline_keyboard: [[{ text: '🆕 Grant Updates', callback_data: 'show:latestgrants' }, { text: '🔗 Link Hub', callback_data: 'show:linkhub' }], [{ text: '🏭 By Industry', callback_data: 'show:industryhelp' }, { text: '➕ Menu', callback_data: 'show:menu' }]] } };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, extra) : send(msg.chat.id, text, extra);
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not load grants and support items.');
  }
}
async function handleGrantUpdates(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const updates = await getGrantUpdates();
    const text = formatGrantUpdates(updates);
    const extra = { reply_markup: { inline_keyboard: [[{ text: '🏛 Grants', callback_data: 'show:grants' }, { text: '🔗 Link Hub', callback_data: 'show:linkhub' }], [{ text: '🏭 By Industry', callback_data: 'show:industryhelp' }, { text: '➕ Menu', callback_data: 'show:menu' }]] } };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, extra) : send(msg.chat.id, text, extra);
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not load grant updates.');
  }
}
async function handleGrantLinkHub(msg, editContext = null) {
  await ensureUser(msg);
  try {
    const items = await getGrantSupports();
    const text = formatGrantLinkHub(items);
    const extra = { reply_markup: { inline_keyboard: [[{ text: '🏛 Grants', callback_data: 'show:grants' }, { text: '🆕 Grant Updates', callback_data: 'show:latestgrants' }], [{ text: '🏭 By Industry', callback_data: 'show:industryhelp' }, { text: '➕ Menu', callback_data: 'show:menu' }]] } };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, extra) : send(msg.chat.id, text, extra);
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not load the grant link hub.');
  }
}
async function handleIndustryGrant(msg, body, editContext = null) {
  await ensureUser(msg);
  const query = String(body || '').trim();
  if (!query) return send(msg.chat.id, 'Use: <code>/industrygrant f&b</code> or <code>/industrygrant retail</code>');
  try {
    const items = await getGrantSupports(100);
    const industry = detectIndustryFromText(query) || normalizeGrantKeyword(query);
    const filtered = items.filter((item) => grantSupportsIndustry(item, industry));
    if (!filtered.length) return send(msg.chat.id, `No support records found for industry: <b>${escapeHtml(query)}</b>`);
    const text = formatGrantSupportList(filtered, { title: `<b>Support for ${escapeHtml(industry)}</b>`, compact: false });
    const extra = { reply_markup: { inline_keyboard: [[{ text: '🔗 Link Hub', callback_data: 'show:linkhub' }, { text: '🏛 Grants', callback_data: 'show:grants' }], [{ text: '➕ Menu', callback_data: 'show:menu' }]] } };
    return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, extra) : send(msg.chat.id, text, extra);
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not load industry-specific support.');
  }
}
async function handleIndustryGrantHelp(msg, editContext = null) {
  const text = [
    '<b>Industry lookup</b>',
    'Use <code>/industrygrant industry</code>',
    '',
    'Examples:',
    '• <code>/industrygrant f&b</code>',
    '• <code>/industrygrant retail</code>',
    '• <code>/industrygrant manufacturing</code>',
    '• <code>/industrygrant services</code>',
    '• <code>/industrygrant startup</code>',
  ].join('\n');
  const extra = { reply_markup: { inline_keyboard: [[{ text: '🏛 Grants', callback_data: 'show:grants' }, { text: '🔗 Link Hub', callback_data: 'show:linkhub' }]] } };
  return editContext ? editOrSend(msg.chat.id, editContext.messageId, text, extra) : send(msg.chat.id, text, extra);
}
async function handleMatchGrant(msg, body) {
  await ensureUser(msg);
  const query = String(body || '').trim();
  if (!query) return send(msg.chat.id, 'Use: <code>/matchgrant your client need</code>');
  try {
    const items = await getGrantSupports(100);
    const detectedIndustry = detectIndustryFromText(query);
    const detectedTags = detectProblemTags(query);
    const ranked = items
      .map((item) => ({ item, score: scoreGrantMatch(item, query, detectedIndustry, detectedTags) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.item);
    if (!ranked.length) {
      return send(msg.chat.id, [
        '<b>Recommended support</b>',
        '',
        `Need: <blockquote>${escapeHtml(query)}</blockquote>`,
        'No direct match found yet in your grant dataset.',
        'Try adding more records into <code>grants_master</code> or use more specific keywords like <code>aircon</code>, <code>chiller</code>, <code>chatbot</code>, <code>overseas</code>, <code>POS</code>.',
      ].join('\n'));
    }
    const stack = buildSupportStackFromMatches(ranked);
    const lines = [
      '<b>Recommended support stack</b>',
      '',
      `Need: <blockquote>${escapeHtml(query)}</blockquote>`,
      detectedIndustry ? `Industry detected: <b>${escapeHtml(detectedIndustry)}</b>` : null,
      detectedTags.length ? `Problem tags: <b>${escapeHtml(detectedTags.join(', '))}</b>` : null,
      '',
    ].filter(Boolean);
    if (stack.funding.length) {
      lines.push('<b>Funding layer</b>');
      stack.funding.slice(0, 3).forEach((item) => lines.push(formatGrantSupportLine(item, { includeWebpage: true, includeMeta: true })));
      lines.push('');
    }
    if (stack.execution.length) {
      lines.push('<b>Execution / implementation layer</b>');
      stack.execution.slice(0, 3).forEach((item) => lines.push(formatGrantSupportLine(item, { includeWebpage: true, includeMeta: true })));
      lines.push('');
    }
    if (stack.capability.length) {
      lines.push('<b>Capability / training layer</b>');
      stack.capability.slice(0, 3).forEach((item) => lines.push(formatGrantSupportLine(item, { includeWebpage: true, includeMeta: true })));
      lines.push('');
    }
    lines.push('<b>Why this stack works</b>');
    lines.push('• Combines funding with execution support and capability-building where possible.');
    return send(msg.chat.id, lines.join('\n').trim(), { reply_markup: { inline_keyboard: [[{ text: '🏛 Grants', callback_data: 'show:grants' }, { text: '🏭 By Industry', callback_data: 'show:industryhelp' }], [{ text: '🆕 Grant Updates', callback_data: 'show:latestgrants' }]] } });
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not run grant matching.');
  }
}
async function handleGrantMorning(msg) {
  await ensureUser(msg);
  try {
    const updates = await getGrantUpdates(5);
    const items = await getGrantSupports(12);
    const highPriority = items.filter((x) => Number(x.priority || 0) >= 80).slice(0, 3);
    const text = [
      'Good morning ☀️',
      '',
      '<b>Grants & support updates</b>',
      ...(updates.length ? updates.map((item) => `• ${escapeHtml(item.title || 'Untitled update')}`) : ['• No new grant updates found yet.']),
      '',
      '<b>Useful for clients today</b>',
      ...(highPriority.length ? highPriority.map((item) => `• ${escapeHtml(item.name)} — ${escapeHtml(item.description || '')}`) : ['• Add high-priority records into <code>grants_master</code> to surface advisor picks here.']),
    ].join('\n');
    return send(msg.chat.id, text, { reply_markup: { inline_keyboard: [[{ text: '🆕 Full Updates', callback_data: 'show:latestgrants' }, { text: '🏛 Grants', callback_data: 'show:grants' }], [{ text: '🏭 By Industry', callback_data: 'show:industryhelp' }]] } });
  } catch (err) {
    console.error(err);
    return send(msg.chat.id, 'Could not build the grant morning update.');
  }
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
  if (/^(good morning|gm)$/i.test(trimmed)) return { type: 'grantmorning' };
  if (/^(grants|grant list)$/i.test(trimmed)) return { type: 'grants' };
  if (/^(latest grants|grant updates)$/i.test(trimmed)) return { type: 'latestgrants' };
  if ((m = trimmed.match(/^(industry grants|support for)\s*:\s*(.+)$/i))) return { type: 'industrygrant', body: m[2].trim() };
  if ((m = trimmed.match(/^industry\s+(.+)$/i))) return { type: 'industrygrant', body: m[1].trim() };
  if (/^(grant hub|link hub)$/i.test(trimmed)) return { type: 'linkhub' };
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
    case 'grants': return handleGrants(msg);
    case 'latestgrants': return handleGrantUpdates(msg);
    case 'industrygrant': return handleIndustryGrant(msg, parsed.body);
    case 'linkhub': return handleGrantLinkHub(msg);
    case 'grantmorning': return handleGrantMorning(msg);
    case 'maintenance': return handleMaintenance(msg);
    case 'addmaintenance': return handleAddMaintenance(msg, parsed.body);
    case 'maintdone': return handleMaintDone(msg, parsed.body);
    default: return send(msg.chat.id, 'Unknown input. Use /help');
  }
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
    case '/grants':
    case '/support': return handleGrants(msg);
    case '/latestgrants': return handleGrantUpdates(msg);
    case '/industrygrant': return handleIndustryGrant(msg, body);
    case '/linkhub': return handleGrantLinkHub(msg);
    case '/matchgrant': return handleMatchGrant(msg, body);
    case '/gm': return handleGrantMorning(msg);
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
    if (data === 'show:grants') return handleGrants(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:latestgrants') return handleGrantUpdates(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:industryhelp') return handleIndustryGrantHelp(fauxMsg, { messageId: msg.message_id });
    if (data === 'show:linkhub') return handleGrantLinkHub(fauxMsg, { messageId: msg.message_id });
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

(async function start() {
  try {
    await bot.setWebHook(`${WEBHOOK_URL}/webhook/${TELEGRAM_BOT_TOKEN}`);
    app.listen(PORT, () => console.log(`Listening on ${PORT}`));
  } catch (err) {
    console.error('Startup error', err);
    process.exit(1);
  }
})();
