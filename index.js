import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_IDS = new Set(
  (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA_FILE = path.resolve(process.env.DATA_FILE || "./data.json");
const DEFAULT_WARN_LIMIT = 3;
const SERVICE_CHAT_ID = process.env.SERVICE_CHAT_ID || "";
const BOT_OWNER_ID = String(process.env.BOT_OWNER_ID || "").trim();
const UPDATE_CHANNEL_ID = String(process.env.UPDATE_CHANNEL_ID || "@anfisa_kanal_bot").trim();
const HELPER_USER_IDS = new Set((process.env.HELPER_USER_IDS || "").split(",").map((v) => v.trim()).filter(Boolean));
const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD || "");
const PORT = Number(process.env.PORT || 3000);
const PANEL_SESSIONS = new Map();
const recentMessages = new Map();
const joinsPerChat = new Map();
const raidUntilByChat = new Map();
const GRID_BAN_CONCURRENCY = 5;
let offset = 0;
let state = { warnings: {}, groupIds: [], helperLastSeen: {}, balances: {}, processedPayments: [], activity: {}, levels: {}, chatSettings: {}, moderationLog: [], reports: [], appeals: [], groupTitles: {} };
let saving = Promise.resolve();

const aliases = {
  warn: new Set(["варн", ".варн", "varn"]),
  ban: new Set(["бан", ".бан", "ban"]),
  mute: new Set(["мут", ".мут", "mut"]),
  unmute: new Set(["размут", ".размут", "unmute"]),
  warns: new Set(["варны", ".варны", "warns"]),
  help: new Set(["help", "/help", "команды", ".команды"]),
  online: new Set(["онлайн", ".онлайн"]),
  serviceHelp: new Set(["помощь", ".помощь"]),
  ping: new Set(["пинг", ".пинг"]),
  gridBan: new Set(["бан сетка", ".бан сетка"]),
  buy: new Set(["покупка", ".покупка"]),
  transfer: new Set(["передать", ".передать"]),
  service: new Set(["услуга", ".услуга"]),
  balance: new Set(["баланс", ".баланс"]),
  grant: new Set(["начислить", ".начислить"]),
  profile: new Set(["профиль", ".профиль"]),
  promote: new Set(["повысить", ".повысить"]),
  warnLimit: new Set(["+варнлимит", "варнлимит", ".варнлимит"]),
  summon: new Set([".позвать", "позвать"]),
  report: new Set([".репорт", "репорт"]),
  appeal: new Set([".апелляция", "апелляция"]),
  stats: new Set([".статистика", "статистика"]),
  antiSpam: new Set([".антиспам", "антиспам"]),
  raid: new Set([".рейд", "рейд", ".рейдзащита", "рейдзащита"]),
  welcome: new Set([".приветствие", "приветствие"]),
  shop: new Set([".магазин", "магазин"]),
  buyBadge: new Set([".купитьзначок", "купитьзначок"]),
  badge: new Set([".значок", "значок"]),
  coinTop: new Set([".топкоинов", "топкоинов"]),
  emojiTest: new Set([".эмодзитест", "эмодзитест"]),
  emojiChannelTest: new Set([".тестэмодзиканал"]),
};

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!state || typeof state !== "object" || !state.warnings) state = { warnings: {} };
    if (!Array.isArray(state.groupIds)) state.groupIds = [];
    if (!state.helperLastSeen || typeof state.helperLastSeen !== "object") state.helperLastSeen = {};
    if (!state.balances || typeof state.balances !== "object") state.balances = {};
    if (!Array.isArray(state.processedPayments)) state.processedPayments = [];
    if (typeof state.botOwnerId !== "string") state.botOwnerId = "";
    if (!state.activity || typeof state.activity !== "object") state.activity = {};
    if (!state.levels || typeof state.levels !== "object") state.levels = {};
    if (!state.warnLimits || typeof state.warnLimits !== "object") state.warnLimits = {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load data.json:", error);
    state = { warnings: {}, groupIds: [], helperLastSeen: {}, balances: {}, processedPayments: [], botOwnerId: "", activity: {}, levels: {}, warnLimits: {} };
  }
  if (!state.chatSettings || typeof state.chatSettings !== "object") state.chatSettings = {};
  if (!state.verifications || typeof state.verifications !== "object") state.verifications = {};
  if (!state.profileBadges || typeof state.profileBadges !== "object") state.profileBadges = {};
  if (!state.userNames || typeof state.userNames !== "object") state.userNames = {};
  if (!Array.isArray(state.moderationLog)) state.moderationLog = [];
  if (!Array.isArray(state.reports)) state.reports = [];
  if (!Array.isArray(state.appeals)) state.appeals = [];
  if (!state.groupTitles || typeof state.groupTitles !== "object") state.groupTitles = {};
  if (!state.warnLimits || typeof state.warnLimits !== "object") state.warnLimits = {};
}

function saveState() {
  saving = saving.then(async () => {
    const temp = `${DATA_FILE}.tmp`;
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, DATA_FILE);
  }).catch((error) => console.error("Could not save warning data:", error));
  return saving;
}

async function api(method, payload = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`${method}: ${result.description || response.statusText}`);
  }
  return result.result;
}

async function send(chatId, text, replyToMessageId, parseMode) {
  return api("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    disable_web_page_preview: true,
  });
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || (user.username ? `@${user.username}` : `ID ${user.id}`);
}

function keyFor(chatId, userId) {
  return `${chatId}:${userId}`;
}
function userLevel(chatId, userId) {
  return Number(state.levels?.[keyFor(chatId, userId)] || 1);
}
function recordActivity(chatId, userId) {
  if (!state.activity || typeof state.activity !== "object") state.activity = {};
  const key = keyFor(chatId, userId);
  const now = Date.now();
  const events = Array.isArray(state.activity[key]) ? state.activity[key] : [];
  events.push(now);
  const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
  state.activity[key] = events.filter((t) => Number(t) >= yearAgo).slice(-10000);
}
function countActivity(chatId, userId, periodMs) {
  const events = state.activity?.[keyFor(chatId, userId)];
  if (!Array.isArray(events)) return 0;
  const since = Date.now() - periodMs;
  return events.filter((t) => Number(t) >= since).length;
}
function warnLimit(chatId) {
  const value = Number(state.warnLimits?.[String(chatId)] || DEFAULT_WARN_LIMIT);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_WARN_LIMIT;
}
function levelLabel(level) {
  return ({1:"Уровень 1 — участник",2:"Уровень 2 — мут и варн",3:"Уровень 3 — бан"})[level] || "Уровень 1 — участник";
}

function parseCommand(text = "") {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s+/, 1)[0];
  const command = firstToken.replace(/^\/+/, "").replace(/@\w+$/, "").toLowerCase();
  for (const [action, names] of Object.entries(aliases)) {
    if (names.has(command)) {
      return { action, reason: trimmed.slice(firstToken.length).trim() };
    }
  }
  return null;
}

async function isAdmin(chatId, userId) {
  const member = await api("getChatMember", { chat_id: chatId, user_id: userId });
  return ["creator", "administrator"].includes(member.status);
}

async function isProtected(chatId, userId) {
  const member = await api("getChatMember", { chat_id: chatId, user_id: userId });
  return ["creator", "administrator"].includes(member.status) || member.user?.is_bot;
}

function reasonSuffix(reason) {
  return reason ? `\nПричина: ${reason}` : "";
}

function parseDurationInput(input = "") {
  const match = /^(\d+)\s*(секунд(?:а|ы)?|сек|с|минут(?:а|ы)?|мин|м|час(?:а|ов)?|ч|дней|дня|дн|день|д)(?=\s|$)\s*(.*)$/i.exec(String(input).trim());
  if (!match) return { matched: false, reason: String(input).trim() };
  const amount = Number(match[1]), unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("с") ? 1 : unit.startsWith("м") ? 60 : unit.startsWith("ч") ? 3600 : 86400;
  const durationSeconds = amount * multiplier;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 366 * 86400) return { matched: true, invalid: true, durationSeconds, reason: match[3].trim() };
  return { matched: true, durationSeconds, reason: match[3].trim() };
}
function durationLabel(seconds) {
  if (seconds % 86400 === 0) return (seconds / 86400) + " дн.";
  if (seconds % 3600 === 0) return (seconds / 3600) + " ч.";
  if (seconds % 60 === 0) return (seconds / 60) + " мин.";
  return seconds + " сек.";
}
function chatSettings(chatId) {
  const s = state.chatSettings?.[String(chatId)] || {};
  return { antiSpam: s.antiSpam !== false, raidProtection: s.raidProtection !== false, welcomeEnabled: s.welcomeEnabled !== false };
}
async function logModeration({ chatId, action, actor, target, reason = "" }) {
  const item = {
    id: crypto.randomUUID(), at: Date.now(), chatId: String(chatId),
    chatTitle: String(state.groupTitles?.[String(chatId)] || chatId), action: String(action),
    actorId: String(actor?.id || ""), actorName: String(actor ? displayName(actor) : "Anfisa"),
    targetId: String(target?.id || ""), targetName: String(target ? displayName(target) : ""),
    reason: String(reason || "").slice(0, 500)
  };
  state.moderationLog.unshift(item);
  state.moderationLog = state.moderationLog.slice(0, 500);
  await saveState();
  if (SERVICE_CHAT_ID) {
    const line = ["🧾 Журнал модерации", "Чат: " + item.chatTitle + " (" + item.chatId + ")", "Действие: " + item.action,
      item.targetName ? "Участник: " + item.targetName + " (ID " + item.targetId + ")" : "",
      item.actorName ? "Кто выполнил: " + item.actorName : "", item.reason ? "Причина: " + item.reason : "",
      "Время: " + new Date(item.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })].filter(Boolean).join("\n");
    try { await send(SERVICE_CHAT_ID, line); } catch (error) { console.error("Could not send moderation log:", error.message); }
  }
  return item;
}
async function notifyHelpers(text) {
  if (SERVICE_CHAT_ID) try { await send(SERVICE_CHAT_ID, text); } catch (error) { console.error("Service notification failed:", error.message); }
  for (const id of HELPER_USER_IDS) try { await send(id, text); } catch (error) { console.error("Helper notification failed:", error.message); }
}
async function handleReportCommand(message, parsed) {
  const replied = message.reply_to_message, target = replied?.from;
  if (!replied || !target || target.is_bot) {
    await send(message.chat.id, "Ответь командой .репорт на сообщение, на которое хочешь пожаловаться. Причину можно указать после команды.", message.message_id);
    return true;
  }
  const item = { id: crypto.randomUUID(), status: "open", at: Date.now(), chatId: String(message.chat.id),
    chatTitle: String(message.chat.title || message.chat.id), reporterId: String(message.from.id), reporterName: displayName(message.from),
    targetId: String(target.id), targetName: displayName(target),
    reason: String(parsed.reason || replied.text || replied.caption || "Причина не указана").slice(0, 500) };
  state.reports.unshift(item); state.reports = state.reports.slice(0, 300);
  await saveState();
  await send(message.chat.id, "✅ Жалоба передана модераторам и добавлена в журнал.", message.message_id);
  await notifyHelpers("🚨 Новая жалоба Anfisa\nЧат: " + item.chatTitle + " (" + item.chatId + ")\nНа кого: " + item.targetName + " (ID " + item.targetId + ")\nОт: " + item.reporterName + "\nПричина: " + item.reason + "\nID: " + item.id);
  return true;
}
async function handleAppealCommand(message, parsed) {
  const parts = String(parsed.reason || "").trim().split(/\s+/), chatId = parts.shift() || "", reason = parts.join(" ").trim();
  if (!/^-?\d{5,20}$/.test(chatId) || !reason) {
    await send(message.chat.id, "Использование: .апелляция CHAT_ID причина\nПример: .апелляция -1001234567890 Прошу пересмотреть бан.");
    return true;
  }
  const item = { id: crypto.randomUUID(), status: "open", at: Date.now(), chatId, userId: String(message.from.id), userName: displayName(message.from), reason: reason.slice(0, 500) };
  state.appeals.unshift(item); state.appeals = state.appeals.slice(0, 300);
  await saveState();
  await send(message.chat.id, "✅ Апелляция отправлена модераторам. Номер: " + item.id);
  await notifyHelpers("📨 Новая апелляция\nПользователь: " + item.userName + " (ID " + item.userId + ")\nЧат: " + item.chatId + "\nПричина: " + item.reason + "\nID: " + item.id);
  return true;
}
async function handleSettingsCommand(message, parsed) {
  let authorized = false;
  try { authorized = await isAdmin(message.chat.id, message.from.id); } catch {}
  if (!authorized) { await send(message.chat.id, "⛔ Настройки может менять только администратор группы.", message.message_id); return true; }
  const key = parsed.action === "antiSpam" ? "antiSpam" : parsed.action === "raid" ? "raidProtection" : "welcomeEnabled";
  const label = key === "antiSpam" ? "антиспам" : key === "raidProtection" ? "защита от рейдов" : "приветствия";
  const args = String(parsed.reason || "").trim().toLowerCase();
  if (!args) {
    await send(message.chat.id, "⚙️ " + label + ": " + (chatSettings(message.chat.id)[key] ? "включено" : "выключено") + ". Укажи вкл или выкл.", message.message_id);
    return true;
  }
  const on = ["вкл", "включить", "on", "да"].includes(args), off = ["выкл", "выключить", "off", "нет"].includes(args);
  if (!on && !off) { await send(message.chat.id, "Укажи «вкл» или «выкл».", message.message_id); return true; }
  state.chatSettings[String(message.chat.id)] = { ...chatSettings(message.chat.id), [key]: on };
  await saveState();
  await send(message.chat.id, (on ? "✅ Включено: " : "⏸ Выключено: ") + label + ".", message.message_id);
  await logModeration({ chatId: message.chat.id, action: "Настройка: " + label + " " + (on ? "включена" : "выключена"), actor: message.from });
  return true;
}
async function handleNewMembers(message) {
  const chatId = String(message.chat.id), settings = chatSettings(chatId), now = Date.now();
  const members = (message.new_chat_members || []).filter((member) => !member.is_bot);
  const recent = (joinsPerChat.get(chatId) || []).filter((time) => now - time < 60_000);
  const raidActive = settings.raidProtection && (raidUntilByChat.get(chatId) || 0) > now;
  if (raidActive) for (const member of members) {
    try {
      await api("restrictChatMember", { chat_id: message.chat.id, user_id: member.id,
        permissions: { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false },
        use_independent_chat_permissions: true, until_date: Math.floor(now / 1000) + 120 });
      state.verifications[keyFor(chatId, member.id)] = { expiresAt: now + 120_000 };
      await saveState();
      await api("sendMessage", { chat_id: message.chat.id, text: "🛡 Для защиты от рейда нажми кнопку проверки в течение 2 минут. До проверки отправка сообщений временно ограничена.", reply_markup: { inline_keyboard: [[{ text: "✅ Пройти проверку", callback_data: "verify:" + chatId + ":" + member.id }]] } });
      await logModeration({ chatId, action: "Защита от рейда: проверка новому участнику на 2 минуты", target: member, reason: "Активен режим рейда" });
    } catch (error) { console.error("Could not apply raid restriction:", error.message); }
  }
  if (settings.raidProtection) {
    for (const member of members) recent.push(now);
    joinsPerChat.set(chatId, recent);
    if (recent.length >= 5 && (raidUntilByChat.get(chatId) || 0) <= now) {
      raidUntilByChat.set(chatId, now + 10 * 60_000);
      try { await send(message.chat.id, "🚨 Anfisa включила защиту от рейда на 10 минут: в группу вошло 5+ участников за минуту.", message.message_id); } catch {}
      await notifyHelpers("🚨 Защита от рейда активирована\nЧат: " + (message.chat.title || chatId) + " (" + chatId + ")\nПричина: 5+ новых участников за минуту.");
      await logModeration({ chatId, action: "Автоматически включена защита от рейда", reason: "5+ новых участников за 60 секунд" });
    }
  }
  if (settings.welcomeEnabled && members.length) {
    await send(message.chat.id, "👋 Добро пожаловать в " + (message.chat.title || "нашу группу") + ", " + members.slice(0, 8).map(displayName).join(", ") + "!\nПожалуйста, соблюдайте правила. Чтобы сообщить о нарушении, ответь на сообщение командой .репорт.");
  }
}
async function runAntiSpam(message) {
  const chatId = String(message.chat.id);
  if (!chatSettings(chatId).antiSpam || message.from?.is_bot) return false;
  const text = String(message.text || message.caption || "").trim();
  const fingerprint = (text || (message.photo ? "[photo]" : message.sticker ? "[sticker]" : message.document ? "[document]" : "[media]")).toLowerCase().replace(/\s+/g, " ").slice(0, 600);
  const key = chatId + ":" + message.from.id, now = Date.now();
  const events = (recentMessages.get(key) || []).filter((event) => now - event.at <= 60_000);
  events.push({ at: now, fingerprint, hasLink: /https?:\/\/|t\.me\/|telegram\.me\//i.test(text) });
  recentMessages.set(key, events);
  const fast = events.filter((event) => now - event.at <= 10_000), repeated = events.filter((event) => event.fingerprint === fingerprint), links = events.filter((event) => event.hasLink && now - event.at <= 20_000);
  const reasons = [];
  if (fast.length >= 12) reasons.push("флуд: 12 сообщений за 10 секунд");
  if (text.length >= 4 && repeated.length >= 3) reasons.push("повторяющиеся сообщения");
  if (links.length >= 4) reasons.push("массовая отправка ссылок");
  if (!reasons.length) return false;
  let protectedMember = false;
  try { protectedMember = await isProtected(chatId, message.from.id); } catch { protectedMember = true; }
  if (protectedMember) return false;
  let deleted = false;
  try { await api("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }); deleted = true; } catch (error) { console.error("Could not delete spam:", error.message); }
  const reason = reasons.join("; ");
  await logModeration({ chatId, action: "Антиспам: " + (deleted ? "сообщение удалено" : "спам обнаружен"), target: message.from, reason });
  if (reasons.some((value) => value.startsWith("флуд") || value.startsWith("повторяющиеся"))) {
    try {
      await api("restrictChatMember", { chat_id: message.chat.id, user_id: message.from.id,
        permissions: { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false },
        use_independent_chat_permissions: true, until_date: Math.floor(now / 1000) + 300 });
      await logModeration({ chatId, action: "Антиспам: мут на 5 минут", target: message.from, reason });
      try { await send(message.chat.id, "🔇 Anfisa временно ограничила участника за спам на 5 минут."); } catch {}
    } catch (error) { console.error("Could not restrict spammer:", error.message); }
  }
  recentMessages.set(key, []);
  return true;
}
function panelSession(request) {
  const cookie = String(request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("anfisa_session="));
  const token = cookie ? cookie.slice("anfisa_session=".length) : "", expiry = PANEL_SESSIONS.get(token);
  if (!expiry || expiry < Date.now()) { if (token) PANEL_SESSIONS.delete(token); return false; }
  return true;
}
function panelLoginPage(error = "") {
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anfisa</title><style>body{margin:0;background:#07151e;color:#eaf7f7;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{width:min(420px,90vw);padding:28px;border:1px solid #087d77;border-radius:20px;background:#0c222d}h1{color:#39e7b1}input,button{width:100%;padding:13px;box-sizing:border-box;border-radius:10px;margin-top:10px;background:#06151e;color:#fff;border:1px solid #235e64}button{background:#11ba8c;color:#06221c;font-weight:700}.error{color:#ff7c8b}</style><main><h1>Anfisa | CHAT-MANAGER</h1><p>Защищённая панель управления группами.</p>' +
    (error ? '<p class="error">' + escapeHtml(error) + '</p>' : '') +
    '<form method="post" action="/login"><label>Пароль панели<input type="password" name="password" required autocomplete="current-password"></label><button>Войти</button></form></main></html>';
}
function panelPage(selectedChatId = "") {
  const groups = [...new Set((state.groupIds || []).map(String))];
  if (!selectedChatId || !groups.includes(selectedChatId)) selectedChatId = groups[0] || "";
  const settings = chatSettings(selectedChatId), title = state.groupTitles?.[selectedChatId] || selectedChatId || "Группы пока не обнаружены";
  const groupOptions = groups.map((id) => '<option value="' + escapeHtml(id) + '"' + (id === selectedChatId ? " selected" : "") + '>' + escapeHtml(state.groupTitles?.[id] || id) + ' (' + escapeHtml(id) + ')</option>').join("");
  const prefix = selectedChatId + ":";
  const activity = Object.entries(state.activity || {}).filter(([key, events]) => key.startsWith(prefix) && Array.isArray(events)).reduce((sum, pair) => sum + pair[1].filter((time) => Number(time) > Date.now() - 86400000).length, 0);
  const warnings = Object.entries(state.warnings || {}).filter(([key, value]) => key.startsWith(prefix) && Number(value) > 0).reduce((sum, pair) => sum + Number(pair[1]), 0);
  const logs = (state.moderationLog || []).filter((item) => !selectedChatId || item.chatId === selectedChatId).slice(0, 20);
  const logRows = logs.map((item) => '<tr><td>' + escapeHtml(new Date(item.at).toLocaleString("ru-RU")) + '</td><td>' + escapeHtml(item.action) + '</td><td>' + escapeHtml(item.targetName || "") + '</td><td>' + escapeHtml(item.actorName || "") + '</td><td>' + escapeHtml(item.reason || "") + '</td></tr>').join("");
  const reports = (state.reports || []).filter((item) => item.status === "open" && (!selectedChatId || item.chatId === selectedChatId)).slice(0, 20);
  const appeals = (state.appeals || []).filter((item) => item.status === "open" && (!selectedChatId || item.chatId === selectedChatId)).slice(0, 20);
  const row = (item, type, label, who, desc) => '<tr><td>' + label + '</td><td>' + escapeHtml(who) + '</td><td>' + escapeHtml(desc) + '</td><td><form method="post" action="/case"><input type="hidden" name="type" value="' + type + '"><input type="hidden" name="id" value="' + escapeHtml(item.id) + '"><input type="hidden" name="chat_id" value="' + escapeHtml(selectedChatId) + '"><select name="status"><option value="reviewed">На рассмотрении</option><option value="resolved">Решено</option><option value="rejected">Отклонено</option></select><button>Сохранить</button></form></td></tr>';
  const cases = reports.map((item) => row(item, "report", "Жалоба", item.reporterName + " → " + item.targetName, item.reason)).concat(appeals.map((item) => row(item, "appeal", "Апелляция", item.userName, "Чат " + item.chatId + ": " + item.reason))).join("");
  const moderators = Object.entries(state.levels || {}).filter(([key, level]) => key.startsWith(prefix) && Number(level) > 1);
  const moderatorRows = moderators.map(([key, level]) => {
    const userId = key.slice(prefix.length);
    return '<tr><td>' + escapeHtml(userId) + '</td><td>' + escapeHtml(levelLabel(Number(level))) + '</td><td><form method="post" action="/moderator"><input type="hidden" name="chat_id" value="' + escapeHtml(selectedChatId) + '"><input type="hidden" name="user_id" value="' + escapeHtml(userId) + '"><select name="level"><option value="1">Участник — снять роль</option><option value="2"' + (Number(level) === 2 ? " selected" : "") + '>Модератор — варн и мут</option><option value="3"' + (Number(level) === 3 ? " selected" : "") + '>Старший модератор — бан</option></select><button>Изменить</button></form></td></tr>';
  }).join("");
  const moderatorSection = '<section><h2>Модераторы Anfisa</h2>' + (selectedChatId ? '<form method="post" action="/moderator"><input type="hidden" name="chat_id" value="' + escapeHtml(selectedChatId) + '"><label>Telegram ID <input name="user_id" inputmode="numeric" pattern="[0-9]+" required></label><label>Уровень <select name="level"><option value="2">Модератор — варн и мут</option><option value="3">Старший модератор — бан</option><option value="1">Участник — снять роль</option></select></label><button>Назначить / изменить</button></form><div class="wrap"><table><tr><th>Telegram ID</th><th>Уровень</th><th>Управление</th></tr>' + (moderatorRows || '<tr><td colspan="3">Назначенных модераторов Anfisa нет.</td></tr>') + '</table></div>' : '<p>Сначала добавьте бота в группу.</p>') + '</section>';
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anfisa | Панель</title><style>*{box-sizing:border-box}body{margin:0;background:#07151e;color:#eaf7f7;font:15px system-ui}header{padding:24px;background:#0c222d;border-bottom:1px solid #087d77;display:flex;justify-content:space-between;gap:20px}h1{margin:0;color:#39e7b1;font-size:24px}main{padding:20px;max-width:1400px;margin:auto}section,.card{padding:16px;border:1px solid #164c55;border-radius:14px;background:#0b202b;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.number{font-size:26px;color:#39e7b1;font-weight:bold}h2{font-size:18px;margin:0 0 12px}label{display:inline-flex;gap:8px;margin:8px 14px 8px 0}input,select{padding:8px;background:#06151e;color:#fff;border:1px solid #235e64;border-radius:8px}button{background:#13c99a;border:0;padding:9px 13px;border-radius:8px;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #19404a;vertical-align:top}.wrap{overflow:auto}.muted{color:#9fbbc1}td form{display:flex;gap:6px;flex-wrap:wrap}</style>' +
    '<header><div><h1>Anfisa | CHAT-MANAGER</h1><p>Веб-панель модерации</p></div><form method="post" action="/logout"><button>Выйти</button></form></header><main>' +
    '<section><h2>Выбор группы</h2><form method="get" action="/"><select name="chat_id">' + groupOptions + '</select> <button>Открыть</button></form><p class="muted">' + escapeHtml(title) + ' · ' + escapeHtml(selectedChatId) + '</p></section>' +
    '<div class="grid"><div class="card">Сообщений за сутки<div class="number">' + activity + '</div></div><div class="card">Активных варнов<div class="number">' + warnings + '</div></div><div class="card">Открытых жалоб<div class="number">' + reports.length + '</div></div><div class="card">Открытых апелляций<div class="number">' + appeals.length + '</div></div></div>' +
    '<section><h2>Настройки защиты</h2>' + (selectedChatId ? '<form method="post" action="/settings"><input type="hidden" name="chat_id" value="' + escapeHtml(selectedChatId) + '"><label><input type="checkbox" name="antiSpam" ' + (settings.antiSpam ? 'checked' : '') + '> Антиспам</label><label><input type="checkbox" name="raidProtection" ' + (settings.raidProtection ? 'checked' : '') + '> Защита от рейдов</label><label><input type="checkbox" name="welcomeEnabled" ' + (settings.welcomeEnabled ? 'checked' : '') + '> Приветствия</label><button>Сохранить</button></form>' : '<p>Добавьте Anfisa в группу и отправьте сообщение.</p>') + '</section>' +
    moderatorSection + '<section><h2>Жалобы и апелляции</h2><div class="wrap"><table><tr><th>Тип</th><th>Кто</th><th>Описание</th><th>Статус</th></tr>' + (cases || '<tr><td colspan="4">Открытых обращений нет.</td></tr>') + '</table></div></section>' +
    '<section><h2>Журнал модерации</h2><div class="wrap"><table><tr><th>Время</th><th>Действие</th><th>Участник</th><th>Кто выполнил</th><th>Причина</th></tr>' + (logRows || '<tr><td colspan="5">Журнал пока пуст.</td></tr>') + '</table></div></section>' +
    '<p class="muted">Права администратора Telegram нужны для удаления сообщений, банов и мутов.</p></main></html>';
}
function startWebPanel() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const html = (status, body, headers = {}) => { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers }); response.end(body); };
    const redirect = (location, headers = {}) => { response.writeHead(303, { Location: location, ...headers }); response.end(); };
    const readForm = async () => { let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 10000) throw new Error("Form body too large"); } return new URLSearchParams(body); };
    if (url.pathname === "/healthz") { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("ok"); return; }
    if (!PANEL_PASSWORD) { html(503, '<!doctype html><meta charset=utf-8><h1>Панель не настроена</h1><p>Задайте PANEL_PASSWORD в переменных окружения хостинга.</p>'); return; }
    try {
      if (url.pathname === "/login" && request.method === "POST") {
        const form = await readForm(), supplied = Buffer.from(String(form.get("password") || "")), expected = Buffer.from(PANEL_PASSWORD);
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { html(401, panelLoginPage("Неверный пароль.")); return; }
        const token = crypto.randomBytes(32).toString("hex"); PANEL_SESSIONS.set(token, Date.now() + 12 * 3600000);
        const https = request.socket.encrypted || String(request.headers["x-forwarded-proto"] || "").split(",")[0] === "https";
        redirect("/", { "Set-Cookie": "anfisa_session=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200" + (https ? "; Secure" : "") }); return;
      }
      if (!panelSession(request)) { html(200, panelLoginPage()); return; }
      if (url.pathname === "/logout" && request.method === "POST") {
        const cookie = String(request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("anfisa_session="));
        if (cookie) PANEL_SESSIONS.delete(cookie.slice("anfisa_session=".length));
        redirect("/", { "Set-Cookie": "anfisa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" }); return;
      }
      if (url.pathname === "/settings" && request.method === "POST") {
        const form = await readForm(), chatId = String(form.get("chat_id") || "");
        if (!(state.groupIds || []).map(String).includes(chatId)) { html(400, panelPage()); return; }
        state.chatSettings[chatId] = { antiSpam: form.get("antiSpam") === "on", raidProtection: form.get("raidProtection") === "on", welcomeEnabled: form.get("welcomeEnabled") === "on" };
        await saveState(); redirect("/?chat_id=" + encodeURIComponent(chatId)); return;
      }
      if (url.pathname === "/moderator" && request.method === "POST") {
        const form = await readForm();
        const chatId = String(form.get("chat_id") || ""), userId = String(form.get("user_id") || ""), level = Number(form.get("level"));
        if (!(state.groupIds || []).map(String).includes(chatId) || !/^\d{5,20}$/.test(userId) || ![1, 2, 3].includes(level)) { html(400, '<h1>Неверные данные</h1><a href="/">Назад</a>'); return; }
        let member;
        try { member = await api("getChatMember", { chat_id: chatId, user_id: Number(userId) }); }
        catch { html(400, '<h1>Участник не найден в группе</h1><p>Убедитесь, что пользователь состоит в группе и Telegram ID верный.</p><a href="/?chat_id=' + encodeURIComponent(chatId) + '">Назад</a>'); return; }
        if (["creator", "administrator"].includes(member.status)) { html(400, '<h1>Нельзя назначить внутренний уровень настоящему администратору Telegram</h1><a href="/?chat_id=' + encodeURIComponent(chatId) + '">Назад</a>'); return; }
        const key = keyFor(chatId, userId);
        if (level === 1) delete state.levels[key]; else state.levels[key] = level;
        await saveState();
        await logModeration({ chatId, action: level === 1 ? "Снят внутренний уровень модератора" : "Назначен внутренний " + levelLabel(level), target: member.user });
        redirect("/?chat_id=" + encodeURIComponent(chatId)); return;
      }
      if (url.pathname === "/case" && request.method === "POST") {
        const form = await readForm(), type = String(form.get("type") || ""), id = String(form.get("id") || ""), status = String(form.get("status") || "");
        const list = type === "report" ? state.reports : type === "appeal" ? state.appeals : null;
        if (!list || !["reviewed", "resolved", "rejected"].includes(status)) { html(400, panelPage()); return; }
        const item = list.find((entry) => entry.id === id);
        if (item) { item.status = status; item.reviewedAt = Date.now(); await saveState(); }
        redirect("/?chat_id=" + encodeURIComponent(String(form.get("chat_id") || ""))); return;
      }
      if (request.method !== "GET" || url.pathname !== "/") { response.writeHead(404, { "Content-Type": "text/plain" }); response.end("Not found"); return; }
      html(200, panelPage(url.searchParams.get("chat_id") || ""));
    } catch (error) { console.error("Web panel request failed:", error); html(500, '<!doctype html><meta charset=utf-8><h1>Ошибка панели</h1>'); }
  });
  server.listen(PORT, "0.0.0.0", () => console.log("Anfisa web panel listening on port " + PORT + (PANEL_PASSWORD ? "" : " (set PANEL_PASSWORD to enable access)")));
}



async function handleServiceCommand(message, parsed) {
  const chatId = String(message.chat.id);
  const sender = message.from;
  if (!SERVICE_CHAT_ID || chatId !== SERVICE_CHAT_ID) return false;

  if (!["online", "serviceHelp", "ping", "gridBan"].includes(parsed.action)) return false;

  // Only configured helpers and group administrators can use the service controls.
  let authorized = HELPER_USER_IDS.has(String(sender.id));
  if (!authorized) {
    try { authorized = await isAdmin(message.chat.id, sender.id); }
    catch { authorized = false; }
  }
  if (!authorized) {
    await send(message.chat.id, "⛔ Эта служебная команда доступна только помощникам и администраторам.");
    return true;
  }

  if (parsed.action === "online") {
    const now = Date.now();
    const lines = [...HELPER_USER_IDS].map((id) => {
      const last = Number(state.helperLastSeen[id] || 0);
      const active = last && now - last <= 15 * 60 * 1000;
      const mention = `<a href="tg://user?id=${id}">Помощник ${id}</a>`;
      return `${active ? "🟢 активен недавно" : "⚪ не отмечался 15 минут"} — ${mention}`;
    });
    await send(message.chat.id,
      lines.length ? "👥 <b>Помощники Anfisa</b>\nСтатус основан на активности в сообщениях боту, а не на реальном статусе Telegram Online.\n\n" + lines.join("\n")
        : "Список помощников не настроен. Добавьте их Telegram ID в HELPER_USER_IDS.",
      message.message_id, "HTML");
    return true;
  }

  if (parsed.action === "serviceHelp") {
    const mentions = [...HELPER_USER_IDS].map((id) => `<a href="tg://user?id=${id}">помощник</a>`).join(" ");
    await send(message.chat.id,
      `🆘 ${mentions || "Помощники не настроены"}\nНужна помощь в служебном чате. Запрос от <a href="tg://user?id=${sender.id}">${escapeHtml(displayName(sender))}</a>.`,
      message.message_id, "HTML");
    return true;
  }

  if (parsed.action === "ping") {
    const start = process.hrtime.bigint();
    const sent = await send(message.chat.id, "🏓 Проверяю отклик…", message.message_id);
    const elapsedNs = process.hrtime.bigint() - start;
    const ms = Number(elapsedNs) / 1e6;
    const edited = `🏓 <b>Pong!</b>\nВремя ответа Telegram API: <code>${ms.toFixed(2)} мс</code>\nЛокальное измерение: <code>${elapsedNs.toString()} нс</code> (наносекунды не означают точность сетевого измерения).`;
    await api("editMessageText", { chat_id: message.chat.id, message_id: sent.message_id, text: edited, parse_mode: "HTML", disable_web_page_preview: true });
    return true;
  }

  if (parsed.action === "gridBan") {
    const target = message.reply_to_message?.from;
    const idText = parsed.reason.match(/\d+/)?.[0];
    const targetId = target?.id || (idText ? Number(idText) : null);
    if (!targetId || !Number.isSafeInteger(Number(targetId))) {
      await send(message.chat.id, "Ответьте на сообщение пользователя командой <code>.бан сетка</code> или укажите его Telegram ID: <code>.бан сетка 123456789</code>.", message.message_id, "HTML");
      return true;
    }
    if (Number(targetId) === Number(sender.id) || (target && target.is_bot)) {
      await send(message.chat.id, "Нельзя заблокировать самого себя или бота.", message.message_id);
      return true;
    }
    if (target && target.id !== Number(targetId)) {
      await send(message.chat.id, "Не удалось определить пользователя.", message.message_id);
      return true;
    }

    const groups = [...new Set((state.groupIds || []).map(String))].filter((id) => id !== SERVICE_CHAT_ID);
    if (!groups.length) {
      await send(message.chat.id, "Пока нет известных групп. Бот должен получить хотя бы одно обновление из каждой группы, а также иметь там право банить участников.", message.message_id);
      return true;
    }
    await send(message.chat.id, `🔎 Начинаю глобальную блокировку ID <code>${targetId}</code> в ${groups.length} известных группах…`, message.message_id, "HTML");
    let banned = 0;
    let failed = 0;
    for (let i = 0; i < groups.length; i += GRID_BAN_CONCURRENCY) {
      const batch = groups.slice(i, i + GRID_BAN_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (groupId) => {
        const member = await api("getChatMember", { chat_id: groupId, user_id: Number(targetId) });
        if (["creator", "administrator"].includes(member.status) || member.user?.is_bot) {
          throw new Error("protected member");
        }
        await api("banChatMember", { chat_id: groupId, user_id: Number(targetId) });
      }));
      for (const result of results) {
        if (result.status === "fulfilled") banned++;
        else failed++;
      }
    }
    await send(message.chat.id,
      `🛡 <b>Глобальная блокировка завершена</b>\nID: <code>${targetId}</code>\nУспешно заблокирован в группах: <b>${banned}</b>\nНе удалось / защищённые участники: <b>${failed}</b>\n\nБот знает только группы, из которых получал обновления, и где у него есть права администратора.`,
      message.message_id, "HTML");
    return true;
  }
  return false;
}

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");
}


const COIN_PACKAGES = new Map([[10, 15], [15, 20], [20, 35], [35, 40]]);
const SERVICE_PRICES = { разварн: 10, разбан: 15, размут: 19 };
const COIN_BADGES = {
  щит: { label: "Щит защитника", emoji: "🛡️", price: 15 },
  звезда: { label: "Звезда сообщества", emoji: "⭐", price: 25 },
  корона: { label: "Корона Анфисы", emoji: "👑", price: 50 },
};
const GRID_SERVICE_PRICE = 65;
function coinBalance(id) { return Number(state.balances[String(id)] || 0); }
function positiveInt(value) {
  if (!/^\d+$/.test(String(value || ""))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
async function handleCoinPaymentUpdate(update) {
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const m = /^anfisakoiny:(\d+):(\d+):(\d+)$/.exec(q.invoice_payload || "");
    const valid = m && String(q.from.id) === m[1] && COIN_PACKAGES.get(Number(m[2])) === Number(m[3]) && q.currency === "XTR" && q.total_amount === Number(m[3]);
    await api("answerPreCheckoutQuery", valid
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: "Счёт не прошёл проверку. Повторите .покупка." });
    return true;
  }
  const msg = update.message;
  const pay = msg?.successful_payment;
  if (!pay) return false;
  const m = /^anfisakoiny:(\d+):(\d+):(\d+)$/.exec(pay.invoice_payload || "");
  if (!m || String(msg.from.id) !== m[1] || pay.currency !== "XTR" || pay.total_amount !== Number(m[3]) || COIN_PACKAGES.get(Number(m[2])) !== Number(m[3])) {
    await send(msg.chat.id, "⚠️ Не удалось автоматически проверить платёж. Обратитесь к администратору бота.");
    return true;
  }
  if (!Array.isArray(state.processedPayments)) state.processedPayments = [];
  if (state.processedPayments.includes(pay.telegram_payment_charge_id)) return true;
  state.balances[m[1]] = coinBalance(m[1]) + Number(m[2]);
  state.processedPayments.push(pay.telegram_payment_charge_id);
  if (state.processedPayments.length > 5000) state.processedPayments = state.processedPayments.slice(-5000);
  await saveState();
  await send(msg.chat.id, "✅ Начислено " + m[2] + " Анфисокоинов 🪙\nБаланс: " + coinBalance(m[1]) + " АК.");
  return true;
}
async function handleCoinCommand(message, parsed) {
  const chatId = message.chat.id, sender = message.from, args = parsed.reason || "";
  const parts = args.split(/\s+/).filter(Boolean);

  if (parsed.action === "grant") {
    // If BOT_OWNER_ID was not configured in hosting, let the creator of a group
    // claim ownership once by using this command there. Store the ID in data.json.
    let ownerId = BOT_OWNER_ID || String(state.botOwnerId || "");
    if (!ownerId && ["group", "supergroup"].includes(message.chat.type)) {
      try {
        const member = await api("getChatMember", { chat_id: chatId, user_id: sender.id });
        if (member.status === "creator") {
          ownerId = String(sender.id);
          state.botOwnerId = ownerId;
          await saveState();
        }
      } catch (error) {
        console.error("Could not bootstrap bot owner:", error.message);
      }
    }
    if (!ownerId || String(sender.id) !== ownerId) {
      await send(chatId, ownerId
        ? "⛔ Начислять Анфисокоины может только владелец бота."
        : "⚙️ Владелец ещё не настроен. Напишите эту команду в группе, где вы создатель, ответом на сообщение пользователя: .начислить 100. Бот запомнит ваш ID как владельца. После этого можно начислять и в ЛС.",
        message.message_id);
      return true;
    }
    const target = message.reply_to_message?.from;
    const values = parts.map(positiveInt).filter((n) => n !== null);
    let targetId, amount;
    if (target && values.length >= 1) {
      targetId = target.id;
      amount = values[0];
    } else if (values.length >= 2) {
      targetId = values[0];
      amount = values[1];
    }
    if (!targetId || !amount || target?.is_bot || Number(targetId) <= 0) {
      await send(chatId, "Использование:\n• Ответьте на сообщение пользователя: .начислить количество\n• Или укажите ID: .начислить USER_ID количество\nПример: .начислить 123456789 100", message.message_id);
      return true;
    }
    state.balances[String(targetId)] = coinBalance(targetId) + amount;
    await saveState();
    await send(chatId, "✅ Владелец начислил " + amount + " Анфисокоинов пользователю ID " + targetId + ".\nНовый баланс: " + coinBalance(targetId) + " АК.", message.message_id);
    return true;
  }

  if (parsed.action === "shop") {
    await send(chatId, "🛍 Магазин Анфисокоинов\n\nщит — Щит защитника: 15 АК\nзвезда — Звезда сообщества: 25 АК\nкорона — Корона Анфисы: 50 АК\n\nПокупка: .купитьзначок щит\nТвои значки можно посмотреть командой .значок. Значки декоративные и не дают прав модерации.", message.message_id);
    return true;
  }
  if (parsed.action === "buyBadge") {
    const badgeKey = String(parts[0] || "").toLowerCase();
    const badge = COIN_BADGES[badgeKey];
    if (!badge) { await send(chatId, "Неизвестный значок. Открой .магазин и выбери: щит, звезда или корона.", message.message_id); return true; }
    const owned = Array.isArray(state.profileBadges[String(sender.id)]) ? state.profileBadges[String(sender.id)] : [];
    if (owned.includes(badgeKey)) { await send(chatId, "У тебя уже есть значок " + badge.emoji + " " + badge.label + ".", message.message_id); return true; }
    if (coinBalance(sender.id) < badge.price) { await send(chatId, "Не хватает Анфисокоинов. Цена: " + badge.price + " АК; твой баланс: " + coinBalance(sender.id) + " АК.", message.message_id); return true; }
    state.balances[String(sender.id)] = coinBalance(sender.id) - badge.price;
    state.profileBadges[String(sender.id)] = [...owned, badgeKey];
    await saveState();
    await send(chatId, "✅ Куплен значок " + badge.emoji + " " + badge.label + " за " + badge.price + " АК. Остаток: " + coinBalance(sender.id) + " АК.", message.message_id);
    return true;
  }
  if (parsed.action === "badge") {
    const owned = Array.isArray(state.profileBadges[String(sender.id)]) ? state.profileBadges[String(sender.id)] : [];
    const label = owned.length ? owned.map((key) => COIN_BADGES[key]?.emoji + " " + COIN_BADGES[key]?.label).join("\n") : "Пока нет значков. Загляни в .магазин.";
    await send(chatId, "🎖 Значки " + displayName(sender) + "\n" + label, message.message_id);
    return true;
  }
  if (parsed.action === "coinTop") {
    const leaders = Object.entries(state.balances || {}).filter(([, balance]) => Number(balance) > 0).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10);
    const text = leaders.length ? leaders.map(([id, balance], index) => (index + 1) + ". " + (state.userNames?.[id] || "Участник") + " — " + Number(balance) + " АК").join("\n") : "Рейтинг пока пуст.";
    await send(chatId, "🏆 Топ Анфисокоинов\n" + text, message.message_id);
    return true;
  }
  if (parsed.action === "balance") {
    await send(chatId, "🪙 Баланс: " + coinBalance(sender.id) + " Анфисокоинов (АК).", message.message_id);
    return true;
  }
  if (parsed.action === "buy") {
    const coins = positiveInt(parts[0]);
    if (!coins || !COIN_PACKAGES.has(coins)) {
      await send(chatId, "Пакеты:\n10 АК — 15 ⭐\n15 АК — 20 ⭐\n20 АК — 35 ⭐\n35 АК — 40 ⭐\n\nПример: .покупка 10", message.message_id);
      return true;
    }
    const stars = COIN_PACKAGES.get(coins);
    await api("sendInvoice", {
      chat_id: chatId, title: coins + " Анфисокоинов",
      description: "Покупка Анфисокоинов для услуг Anfisa | CHAT-MANAGER.",
      payload: "anfisakoiny:" + sender.id + ":" + coins + ":" + stars,
      provider_token: "", currency: "XTR",
      prices: [{ label: coins + " Анфисокоинов", amount: stars }]
    });
    return true;
  }
  if (parsed.action === "transfer") {
    const amount = positiveInt(parts[0]), target = message.reply_to_message?.from;
    if (!amount || !target) {
      await send(chatId, "Ответьте на сообщение получателя командой .передать количество", message.message_id);
      return true;
    }
    if (target.is_bot || target.id === sender.id) {
      await send(chatId, "Нельзя передать коины самому себе или боту.", message.message_id);
      return true;
    }
    if (coinBalance(sender.id) < amount) {
      await send(chatId, "Недостаточно средств. Баланс: " + coinBalance(sender.id) + " АК.", message.message_id);
      return true;
    }
    state.balances[String(sender.id)] = coinBalance(sender.id) - amount;
    state.balances[String(target.id)] = coinBalance(target.id) + amount;
    await saveState();
    await send(chatId, "✅ Передано " + amount + " АК пользователю " + displayName(target) + ".\nВаш баланс: " + coinBalance(sender.id) + " АК.", message.message_id);
    return true;
  }
  if (parsed.action !== "service") return false;
  const action = String(parts[0] || "").toLowerCase();
  if (!["разбан", "размут", "разварн"].includes(action)) {
    await send(chatId, "Услуги:\n.услуга разварн — 10 АК\n.услуга разбан — 15 АК\n.услуга размут — 19 АК\nДействие по сетке — 65 АК.\nОтветьте на сообщение пользователя; в ЛС укажите ID пользователя и ID чата или @username группы.", message.message_id);
    return true;
  }
  const network = parts.some((p) => ["сетке", "сетка"].includes(p.toLowerCase()));
  const target = message.reply_to_message?.from;
  const explicitUserId = parts.map(positiveInt).find((v) => v !== null);
  const targetId = target?.id || explicitUserId;
  if (!targetId) {
    await send(chatId, "Ответьте на сообщение пользователя или укажите его Telegram ID.", message.message_id);
    return true;
  }
  if (Number(targetId) === Number(sender.id) || target?.is_bot) {
    await send(chatId, "Нельзя применить услугу к себе или боту.", message.message_id);
    return true;
  }
  let groups = [];
  if (network) {
    groups = [...new Set((state.groupIds || []).map(String))].filter((id) => id !== SERVICE_CHAT_ID);
  } else if (message.chat.type === "group" || message.chat.type === "supergroup") {
    groups = [String(message.chat.id)];
  } else {
    const chatArg = parts.find((p) => p.startsWith("@") || p.startsWith("-"));
    if (!chatArg) {
      await send(chatId, "В ЛС укажите ID/username группы: .услуга разбан USER_ID CHAT_ID_ИЛИ_@username", message.message_id);
      return true;
    }
    try {
      const c = await api("getChat", { chat_id: chatArg });
      if (!["group", "supergroup"].includes(c.type)) throw new Error("not a group");
      groups = [String(c.id)];
    } catch {
      await send(chatId, "Не удалось найти группу. Укажите точный ID или публичный @username; бот должен иметь доступ к группе.", message.message_id);
      return true;
    }
  }
  if (!groups.length) {
    await send(chatId, "Нет известных групп для действия по сетке. Коины не списаны.", message.message_id);
    return true;
  }
  const price = network ? GRID_SERVICE_PRICE : SERVICE_PRICES[action];
  if (coinBalance(sender.id) < price) {
    await send(chatId, "Услуга стоит " + price + " АК; ваш баланс — " + coinBalance(sender.id) + " АК.", message.message_id);
    return true;
  }
  const me = await api("getMe");
  const usable = [];
  for (const groupId of groups) {
    try {
      const botMember = await api("getChatMember", { chat_id: groupId, user_id: me.id });
      if (!["administrator", "creator"].includes(botMember.status)) continue;
      if (action === "разбан") {
        usable.push(groupId);
      } else {
        const member = await api("getChatMember", { chat_id: groupId, user_id: Number(targetId) });
        if (!["creator", "administrator"].includes(member.status) && !member.user?.is_bot) usable.push(groupId);
      }
    } catch (e) {
      if (action === "разбан") usable.push(groupId);
    }
  }
  if (!usable.length) {
    await send(chatId, "Бот не имеет нужных прав или пользователь защищён/не найден. Коины не списаны.", message.message_id);
    return true;
  }
  let success = 0, failed = 0;
  for (const groupId of usable) {
    try {
      if (action === "разбан") {
        await api("unbanChatMember", { chat_id: groupId, user_id: Number(targetId), only_if_banned: false });
      } else if (action === "размут") {
        await api("restrictChatMember", { chat_id: groupId, user_id: Number(targetId), use_independent_chat_permissions: true, permissions: {
          can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true,
          can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true,
          can_send_other_messages: true, can_add_web_page_previews: true
        }});
      } else {
        for (const key of Object.keys(state.warnings)) {
          if (network ? key.endsWith(":" + targetId) : key === keyFor(groupId, targetId)) delete state.warnings[key];
        }
      }
      success++;
    } catch (e) {
      failed++;
      console.error("Paid service " + action + " failed in " + groupId + ":", e.message);
    }
  }
  if (success) {
    state.balances[String(sender.id)] = coinBalance(sender.id) - price;
    await saveState();
  }
  await send(chatId, success
    ? "✅ Услуга «" + action + (network ? " по сетке" : "") + "» завершена.\nID пользователя: " + targetId + "\nУспешно: " + success + "; ошибки: " + failed + "\nСписано: " + price + " АК.\nБаланс: " + coinBalance(sender.id) + " АК."
    : "❌ Не удалось выполнить услугу. Коины не списаны.", message.message_id);
  return true;
}

async function handleEmojiTest(message) {
  const senderId = String(message.from?.id || "");
  const ownerId = BOT_OWNER_ID || String(state.botOwnerId || "");
  if (!ownerId || senderId !== ownerId) {
    await send(message.chat.id, ownerId
      ? "⛔ Тест премиум-эмодзи доступен только владельцу бота."
      : "⚙️ Не задан BOT_OWNER_ID. Укажи свой Telegram ID в переменных окружения хостинга, затем перезапусти бота.");
    return true;
  }

  try {
    const pack = await api("getStickerSet", { name: "NewsEmoji" });
    const sticker = (pack.stickers || []).find((item) => item.emoji && item.custom_emoji_id);
    if (!sticker) {
      await send(message.chat.id, "Не удалось найти в наборе NewsEmoji эмодзи с custom_emoji_id. Проверь название набора.");
      return true;
    }
    const emoji = sticker.emoji;
    await api("sendMessage", {
      chat_id: message.chat.id,
      text: emoji + " Тест премиум-эмодзи Anfisa",
      entities: [{
        type: "custom_emoji",
        offset: 0,
        length: emoji.length,
        custom_emoji_id: sticker.custom_emoji_id
      }],
      link_preview_options: { is_disabled: true }
    });
  } catch (error) {
    console.error("Premium emoji test failed:", error.message);
    await send(message.chat.id, "❌ Тест не прошёл. Telegram ответил: " + error.message);
  }
  return true;
}


async function handleChannelEmojiTest(message) {
  const senderId = String(message.from?.id || "");
  const ownerId = BOT_OWNER_ID || String(state.botOwnerId || "");
  if (!ownerId || senderId !== ownerId) {
    await send(message.chat.id, ownerId
      ? "⛔ Команда .тестэмодзиканал доступна только владельцу бота."
      : "⚙️ Не задан BOT_OWNER_ID. Укажи свой Telegram ID в переменных окружения хостинга и перезапусти бота.");
    return true;
  }

  try {
    const pack = await api("getStickerSet", { name: "NewsEmoji" });
    const stickers = (pack.stickers || []).filter((item) => item.emoji && item.custom_emoji_id);
    if (!stickers.length) {
      await send(message.chat.id, "❌ В наборе NewsEmoji не нашлось премиум-эмодзи с custom_emoji_id.");
      return true;
    }

    let text = "🧪 Тест премиум-эмодзи Anfisa | CHAT-MANAGER\n\n";
    const entities = [];
    const maxTextLength = 4000;
    let sentCount = 0;

    for (const sticker of stickers) {
      const separator = sentCount === 0 ? "" : (sentCount % 8 === 0 ? "\n" : " ");
      const emoji = sticker.emoji;
      if (text.length + separator.length + emoji.length > maxTextLength) break;

      text += separator;
      const offset = text.length;
      text += emoji;
      entities.push({
        type: "custom_emoji",
        offset,
        length: emoji.length,
        custom_emoji_id: sticker.custom_emoji_id
      });
      sentCount++;
    }

    text += "\n\nВсего в тесте: " + sentCount + " премиум-эмодзи из набора NewsEmoji.";
    await api("sendMessage", {
      chat_id: UPDATE_CHANNEL_ID,
      text,
      entities,
      link_preview_options: { is_disabled: true }
    });
    await send(message.chat.id,
      "✅ Тестовая публикация отправлена в канал.\nПроверено премиум-эмодзи: " + sentCount + ".\nЕсли эмодзи не отображаются, убедись, что Anfisa может публиковать сообщения в канале.");
  } catch (error) {
    console.error("Channel premium emoji test failed:", error.message);
    await send(message.chat.id,
      "❌ Не удалось отправить тест в канал. Проверь, что Anfisa добавлена администратором канала и может публиковать сообщения.\nДетали: " + error.message);
  }
  return true;
}

async function handleVerificationCallback(query) {
  const match = /^verify:([^:]+):(\d+)$/.exec(String(query.data || ""));
  if (!match) { await api("answerCallbackQuery", { callback_query_id: query.id, text: "Неизвестная проверка." }); return; }
  const chatId = match[1], targetId = match[2], key = keyFor(chatId, targetId);
  const verification = state.verifications?.[key];
  if (!verification || Number(verification.expiresAt) < Date.now()) {
    if (state.verifications) delete state.verifications[key];
    await saveState();
    await api("answerCallbackQuery", { callback_query_id: query.id, text: "Время проверки истекло. Попроси администратора помочь." });
    return;
  }
  if (String(query.from?.id) !== targetId) {
    await api("answerCallbackQuery", { callback_query_id: query.id, text: "Эта кнопка предназначена другому участнику.", show_alert: true });
    return;
  }
  try {
    await api("restrictChatMember", { chat_id: chatId, user_id: Number(targetId),
      permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true },
      use_independent_chat_permissions: true });
    delete state.verifications[key];
    await saveState();
    await api("answerCallbackQuery", { callback_query_id: query.id, text: "Проверка пройдена!" });
    await send(chatId, "✅ " + displayName(query.from) + ", проверка пройдена. Теперь можно писать.");
    await logModeration({ chatId, action: "Антирейд: проверка пройдена", actor: query.from, target: query.from });
  } catch (error) {
    console.error("Could not complete raid verification:", error.message);
    await api("answerCallbackQuery", { callback_query_id: query.id, text: "Не удалось завершить проверку. Обратись к администратору.", show_alert: true });
  }
}

async function handleUpdate(update) {
  if (update.callback_query) { await handleVerificationCallback(update.callback_query); return; }
  if (update.pre_checkout_query || update.message?.successful_payment) {
    await handleCoinPaymentUpdate(update);
    if (update.pre_checkout_query) return;
  }
  if (update.my_chat_member) {
    const change = update.my_chat_member;
    const chat = change.chat;
    const oldStatus = change.old_chat_member?.status;
    const newStatus = change.new_chat_member?.status;
    if (["member", "administrator"].includes(newStatus) && !["member", "administrator"].includes(oldStatus) && ["group", "supergroup"].includes(chat?.type)) {
      try {
        await send(chat.id,
          "👋 Спасибо, что добавили Anfisa | CHAT-MANAGER!\\n\\nДля работы модерации выдайте боту права администратора: включите все доступные права, кроме «Оставаться анонимным». Особенно важны права банить участников и ограничивать участников.\\n\\nПосле выдачи прав проверьте команды .профиль и .варны.");
      } catch (error) { console.error("Could not send add-to-chat notice:", error.message); }
    }
    return;
  }
  const message = update.message;
  if (!message?.chat || !message.from) return;
  const messageText = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  if (!messageText && !Array.isArray(message.new_chat_members)) return;

  const chat = message.chat;
  const sender = message.from;
  if (!state.userNames || typeof state.userNames !== "object") state.userNames = {};
  state.userNames[String(sender.id)] = displayName(sender);
  const parsed = parseCommand(messageText);
  if (chat.type === "private") {
    if (parsed?.action === "appeal") { await handleAppealCommand(message, parsed); return; }
    if (parsed?.action === "emojiTest") { await handleEmojiTest(message); return; }
    if (parsed?.action === "emojiChannelTest") { await handleChannelEmojiTest(message); return; }
    if (parsed && ["buy", "transfer", "service", "balance", "grant", "shop", "buyBadge", "badge", "coinTop"].includes(parsed.action)) await handleCoinCommand(message, parsed);
    else if (parsed?.action === "help") await send(chat.id, "Anfisa | CHAT-MANAGER\n\n.покупка 10 — купить Анфисокоины за ⭐\n.баланс — баланс\n.передать количество — ответом на сообщение\n.услуга — платные услуги\n.магазин — витрина значков\n.купитьзначок щит — купить декор\n.значок — мои значки\n.топкоинов — рейтинг балансов\n.апелляция CHAT_ID причина — обжаловать бан.\n.тестэмодзиканал — тест эмодзи в канал (только владелец).", message.message_id);
    return;
  }
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  // Count each message as activity for rolling day/week/month/year statistics.
  recordActivity(chat.id, sender.id);
  if (!state.groupTitles || typeof state.groupTitles !== "object") state.groupTitles = {};
  state.groupTitles[String(chat.id)] = String(chat.title || chat.id);
  // Remember groups where Telegram has delivered an update. Persist helper activity for .онлайн.
  if (!Array.isArray(state.groupIds)) state.groupIds = [];
  if (!state.groupIds.includes(String(chat.id))) {
    state.groupIds.push(String(chat.id));
    await saveState();
  }
  if (HELPER_USER_IDS.has(String(sender.id))) {
    state.helperLastSeen[sender.id] = Date.now();
    await saveState();
  }

  if (Array.isArray(message.new_chat_members) && message.new_chat_members.length) {
    await handleNewMembers(message);
    await saveState();
    return;
  }
  if (!parsed) { await runAntiSpam(message); await saveState(); return; }
  if (parsed.action === "report") { await handleReportCommand(message, parsed); return; }
  if (["antiSpam", "raid", "welcome"].includes(parsed.action)) { await handleSettingsCommand(message, parsed); return; }
  if (["buy", "transfer", "service", "balance", "grant", "shop", "buyBadge", "badge", "coinTop"].includes(parsed.action)) { await handleCoinCommand(message, parsed); return; }

  if (parsed.action === "stats") {
    let authorized = false;
    try { authorized = await isAdmin(chat.id, sender.id); } catch {}
    if (!authorized) { await send(chat.id, "⛔ Статистика группы доступна только администраторам.", message.message_id); return; }
    const prefix = String(chat.id) + ":";
    const messagesToday = Object.entries(state.activity || {}).filter(([key, events]) => key.startsWith(prefix) && Array.isArray(events)).reduce((sum, [, events]) => sum + events.filter((time) => Number(time) > Date.now() - 24 * 60 * 60 * 1000).length, 0);
    const activeUsers = Object.entries(state.activity || {}).filter(([key, events]) => key.startsWith(prefix) && Array.isArray(events) && events.some((time) => Number(time) > Date.now() - 24 * 60 * 60 * 1000)).length;
    const warnings = Object.entries(state.warnings || {}).filter(([key, count]) => key.startsWith(prefix) && Number(count) > 0).reduce((sum, [, count]) => sum + Number(count), 0);
    const openReports = (state.reports || []).filter((item) => item.chatId === String(chat.id) && item.status === "open").length;
    await send(chat.id, "📊 Статистика группы\nСообщений за сутки: " + messagesToday + "\nАктивных участников за сутки: " + activeUsers + "\nАктивных варнов: " + warnings + "\nОткрытых жалоб: " + openReports, message.message_id);
    return;
  }

  if (parsed.action === "profile") {
    const target = message.reply_to_message?.from || sender;
    let role = "Участник";
    try {
      const member = await api("getChatMember", { chat_id: chat.id, user_id: target.id });
      if (member.status === "creator") role = "Владелец группы";
      else if (member.status === "administrator") role = "Администратор группы";
      else if (["left", "kicked"].includes(member.status)) role = "Не состоит в группе";
    } catch {}
    const level = userLevel(chat.id, target.id);
    const activityText = [
      "📊 Актив пользователя: " + displayName(target),
      "День: " + countActivity(chat.id, target.id, 24*60*60*1000) + " сообщ.",
      "Неделя: " + countActivity(chat.id, target.id, 7*24*60*60*1000) + " сообщ.",
      "Месяц: " + countActivity(chat.id, target.id, 30*24*60*60*1000) + " сообщ.",
      "Год: " + countActivity(chat.id, target.id, 365*24*60*60*1000) + " сообщ.",
      "Статус: " + role,
      "Права Anfisa: " + levelLabel(level),
      "Значки: " + ((Array.isArray(state.profileBadges?.[String(target.id)]) && state.profileBadges[String(target.id)].length) ? state.profileBadges[String(target.id)].map((key) => (COIN_BADGES[key]?.emoji || "") + " " + (COIN_BADGES[key]?.label || key)).join(", ") : "нет")
    ].join("\n");
    await saveState();
    await send(chat.id, activityText, message.message_id);
    return;
  }

  if (parsed.action === "warnLimit") {
    let authorized = false;
    try { authorized = await isAdmin(chat.id, sender.id); } catch {}
    if (!authorized) {
      await send(chat.id, "⛔ Менять лимит варнов могут только администраторы группы.", message.message_id);
      return;
    }
    const match = /^([1-9]|[1-9][0-9]|100)$/.exec(parsed.reason);
    if (!match) {
      await send(chat.id, "Укажите лимит от 1 до 100. Например: +варнлимит 5", message.message_id);
      return;
    }
    state.warnLimits[String(chat.id)] = Number(match[1]);
    await saveState();
    await send(chat.id, "✅ Лимит предупреждений установлен: " + match[1] + ". После достижения лимита участник будет забанен.", message.message_id);
    return;
  }

  if (parsed.action === "summon") {
    let authorized = false;
    try { authorized = await isAdmin(chat.id, sender.id) || userLevel(chat.id, sender.id) >= 2; } catch {}
    if (!authorized) {
      await send(chat.id, "⛔ Позвать модераторов могут только администраторы и модераторы уровня 2/3.", message.message_id);
      return;
    }
    const title = message.chat.title || "Группа";
    let invite = message.chat.username ? "https://t.me/" + message.chat.username : "";
    if (!invite) {
      try { invite = await api("exportChatInviteLink", { chat_id: chat.id }); } catch {}
    }
    const details = "🆘 Вызов модератора Anfisa\\nЧат: " + title + "\\nID: " + chat.id +
      (invite ? "\\nСсылка для входа: " + invite : "\\nСсылку не удалось создать — откройте чат по ID: " + chat.id) +
      "\\nКто позвал: " + displayName(sender) + "\\nПожалуйста, присоединитесь и помогите разобраться.";
    let sent = 0;
    for (const id of HELPER_USER_IDS) {
      try { await send(id, details); sent++; }
      catch (error) { console.error("Could not DM helper " + id + ":", error.message); }
    }
    await send(chat.id, sent
      ? "📣 Модераторы оповещены (" + sent + "). Они получат сообщение от Anfisa в личные сообщения. Если они ещё не запускали бота, им нужно открыть его и нажать /start."
      : "⚠️ Не удалось отправить личные сообщения модераторам. Проверьте HELPER_USER_IDS и убедитесь, что каждый модератор нажал /start у бота.", message.message_id);
    return;
  }

  if (parsed.action === "promote") {
    let actorIsAdmin = false;
    try { actorIsAdmin = await isAdmin(chat.id, sender.id); } catch {}
    if (!actorIsAdmin) {
      await send(chat.id, "⛔ Повышать и понижать уровни могут только администраторы группы.", message.message_id);
      return;
    }
    const target = message.reply_to_message?.from;
    const match = /(?:до\s*)?([1-3])\s*$/.exec(parsed.reason);
    if (!target || !match) {
      await send(chat.id, "Ответьте на сообщение пользователя командой .повысить до 2 (или до 1 / до 3).", message.message_id);
      return;
    }
    if (target.is_bot || target.id === sender.id) {
      await send(chat.id, "Нельзя назначить уровень самому себе или боту.", message.message_id);
      return;
    }
    try {
      const member = await api("getChatMember", { chat_id: chat.id, user_id: target.id });
      if (["creator", "administrator"].includes(member.status)) {
        await send(chat.id, "У настоящих администраторов и владельца группы права Telegram не меняются этой командой.", message.message_id);
        return;
      }
    } catch {
      await send(chat.id, "Не удалось проверить пользователя. Убедитесь, что Anfisa — администратор группы.", message.message_id);
      return;
    }
    const level = Number(match[1]);
    state.levels[keyFor(chat.id, target.id)] = level;
    await saveState();
    await send(chat.id, "✅ Для " + displayName(target) + " установлен " + levelLabel(level) + ".", message.message_id);
    return;
  }

  if (await handleServiceCommand(message, parsed)) return;

  // Service-only commands never run in ordinary groups, even if the bot is an admin there.
  if (["online", "serviceHelp", "ping", "gridBan"].includes(parsed.action)) return;
  if (ALLOWED_CHAT_IDS.size && !ALLOWED_CHAT_IDS.has(String(chat.id))) return;

  if (parsed.action === "help") {
    if (!(await isAdmin(chat.id, sender.id))) return;
    await send(chat.id,
      "Anfisa | CHAT-MANAGER\n\n" +
      "Команды доступны администраторам и применяются ответом на сообщение участника:\n" +
      "• варн / .варн / varn — предупреждение; 3 предупреждения = бан\n" +
      "• бан / .бан / ban — бан\n" +
      "• мут / .мут / mut — запрет писать\n" +
      "• размут / .размут / unmute — снять мут\n" +
      "• варны / .варны / warns — число предупреждений\n" +
      "• .мут 10м / .бан 1д — временное наказание (ответом на сообщение)\n" +
      "• .антиспам вкл/выкл — фильтр флуда и повторов\n" +
      "• .рейд вкл/выкл — защита от рейдов\n" +
      "• .приветствие вкл/выкл — приветствия при входе\n" +
      "• .репорт — ответом на сообщение, пожаловаться модераторам\n" +
      "• .статистика — сводка группы\n" +
      "• помощь / .помощь / help — эта справка",
      message.message_id);
    return;
  }

  let admin;
  try {
    const telegramAdmin = await isAdmin(chat.id, sender.id);
    const level = userLevel(chat.id, sender.id);
    admin = telegramAdmin || (["warn", "mute", "unmute"].includes(parsed.action) && level >= 2) || (parsed.action === "ban" && level >= 3);
  } catch (error) {
    console.error("Could not verify administrator:", error.message);
    await send(chat.id, "Не удалось проверить права администратора. Попробуйте позже.", message.message_id);
    return;
  }

  if (!admin) {
    const level = userLevel(chat.id, sender.id);
    if (["warn", "mute", "unmute", "ban"].includes(parsed.action)) {
      await send(chat.id, "⛔ Недостаточно прав. Ваш уровень: " + level + "/3.", message.message_id);
    }
    return;
  }

  const target = message.reply_to_message?.from;
  if (!target) {
    await send(chat.id, "Ответьте командой на сообщение участника, к которому нужно применить действие.", message.message_id);
    return;
  }

  if (target.id === sender.id) {
    await send(chat.id, "Нельзя применить это действие к самому себе.", message.message_id);
    return;
  }

  if (parsed.action === "warns") {
    const limit = warnLimit(chat.id);
    const count = state.warnings[keyFor(chat.id, target.id)] || 0;
    await send(chat.id, `${displayName(target)}: ${count}/${limit} предупреждений.`, message.message_id);
    return;
  }

  if (target.is_bot) {
    await send(chat.id, "Эту команду нельзя применить к боту.", message.message_id);
    return;
  }

  try {
    if (await isProtected(chat.id, target.id)) {
      await send(chat.id, "Нельзя применить это действие к владельцу или администратору группы.", message.message_id);
      return;
    }
  } catch (error) {
    console.error("Could not inspect target member:", error.message);
    await send(chat.id, "Не удалось проверить статус участника. Убедитесь, что бот — администратор группы.", message.message_id);
    return;
  }

  const targetName = displayName(target);
  const durationInput = (parsed.action === "ban" || parsed.action === "mute") ? parseDurationInput(parsed.reason) : { matched: false, reason: parsed.reason };
  if (durationInput.matched && durationInput.invalid) {
    await send(chat.id, "⛔ Длительность должна быть от 30 секунд до 366 дней. Примеры: .мут 10м, .бан 1д.", message.message_id);
    return;
  }
  const reason = durationInput.matched ? durationInput.reason : parsed.reason;
  const untilDate = durationInput.matched ? Math.floor(Date.now() / 1000) + durationInput.durationSeconds : undefined;
  const durationText = durationInput.matched ? " на " + durationLabel(durationInput.durationSeconds) : "";

  try {
    switch (parsed.action) {
      case "warn": {
        const key = keyFor(chat.id, target.id);
        const count = (state.warnings[key] || 0) + 1;
        state.warnings[key] = count;
        await saveState();

        if (count >= warnLimit(chat.id)) {
          await api("banChatMember", { chat_id: chat.id, user_id: target.id });
          delete state.warnings[key];
          await saveState();
          await send(chat.id,
            `⛔ ${targetName} достиг(ла) лимита в ${warnLimit(chat.id)} предупреждений и забанен(а).${reasonSuffix(reason)}`,
            message.message_id);
          await logModeration({ chatId: chat.id, action: "Автобан за лимит предупреждений", actor: sender, target, reason: reason || (count + "/" + warnLimit(chat.id) + " варнов") });
        } else {
          await send(chat.id,
            `⚠️ Предупреждение ${count}/${warnLimit(chat.id)} для ${targetName}.${reasonSuffix(reason)}`,
            message.message_id);
          await logModeration({ chatId: chat.id, action: "Предупреждение " + count + "/" + warnLimit(chat.id), actor: sender, target, reason });
        }
        break;
      }
      case "ban":
        await api("banChatMember", { chat_id: chat.id, user_id: target.id, ...(untilDate ? { until_date: untilDate } : {}) });
        await send(chat.id, `⛔ ${targetName} забанен(а) администратором ${displayName(sender)}${durationText}.${reasonSuffix(reason)}`, message.message_id);
        await logModeration({ chatId: chat.id, action: "Бан" + durationText, actor: sender, target, reason });
        break;
      case "mute":
        await api("restrictChatMember", {
          chat_id: chat.id,
          user_id: target.id,
          permissions: {
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          },
          use_independent_chat_permissions: true,
          ...(untilDate ? { until_date: untilDate } : {}),
        });
        await send(chat.id, `🔇 ${targetName} получил(а) мут${durationInput.matched ? " на " + durationLabel(durationInput.durationSeconds) : " до снятия администратором"}.${reasonSuffix(reason)}`, message.message_id);
        await logModeration({ chatId: chat.id, action: "Мут" + durationText, actor: sender, target, reason });
        break;
      case "unmute":
        await api("restrictChatMember", {
          chat_id: chat.id,
          user_id: target.id,
          permissions: {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          },
          use_independent_chat_permissions: true,
        });
        await send(chat.id, `🔊 Мут для ${targetName} снят.`, message.message_id);
        await logModeration({ chatId: chat.id, action: "Мут снят", actor: sender, target, reason });
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`Moderation action ${parsed.action} failed:`, error.message);
    await send(chat.id,
      `Не удалось выполнить команду. Проверьте, что Anfisa — администратор и у неё есть право банить/ограничивать участников.\nДетали: ${error.message}`,
      message.message_id);
  }
}

async function main() {
  await loadState();
  startWebPanel();
  const me = await api("getMe");
  console.log(`Started ${me.first_name}${me.username ? ` (@${me.username})` : ""}. Polling Telegram updates...`);

  while (true) {
    try {
      const updates = await api("getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "pre_checkout_query", "my_chat_member", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          console.error("Update handler failed:", error);
        }
      }
    } catch (error) {
      console.error("Telegram polling failed:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

process.on("SIGTERM", async () => {
  await saveState();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await saveState();
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
