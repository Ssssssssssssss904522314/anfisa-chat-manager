import fs from "node:fs/promises";
import path from "node:path";

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
const MAX_WARNS = 3;
const SERVICE_CHAT_ID = process.env.SERVICE_CHAT_ID || "";
const BOT_OWNER_ID = String(process.env.BOT_OWNER_ID || "").trim();
const HELPER_USER_IDS = new Set((process.env.HELPER_USER_IDS || "").split(",").map((v) => v.trim()).filter(Boolean));
const GRID_BAN_CONCURRENCY = 5;
let offset = 0;
let state = { warnings: {}, groupIds: [], helperLastSeen: {}, balances: {}, processedPayments: [], activity: {}, levels: {} };
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
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load data.json:", error);
    state = { warnings: {}, groupIds: [], helperLastSeen: {}, balances: {}, processedPayments: [], botOwnerId: "", activity: {}, levels: {} };
  }
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
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


const COIN_PACKAGES = new Map([[10, 15], [15, 20], [20, 35], [35, 40]]);
const SERVICE_PRICES = { разварн: 10, разбан: 15, размут: 19 };
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

async function handleUpdate(update) {
  if (update.pre_checkout_query || update.message?.successful_payment) {
    await handleCoinPaymentUpdate(update);
    if (update.pre_checkout_query) return;
  }
  const message = update.message;
  if (!message?.chat || !message.from || typeof message.text !== "string") return;

  const chat = message.chat;
  const sender = message.from;
  const parsed = parseCommand(message.text);
  if (chat.type === "private") {
    if (parsed && ["buy", "transfer", "service", "balance", "grant"].includes(parsed.action)) await handleCoinCommand(message, parsed);
    else if (parsed?.action === "help") await send(chat.id, "Anfisa | CHAT-MANAGER\n\n.покупка 10 — купить Анфисокоины за ⭐\n.баланс — баланс\n.передать количество — ответом на сообщение\n.услуга — платные услуги.", message.message_id);
    return;
  }
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  // Count each message as activity for rolling day/week/month/year statistics.
  recordActivity(chat.id, sender.id);
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

  if (!parsed) { await saveState(); return; }
  if (["buy", "transfer", "service", "balance", "grant"].includes(parsed.action)) { await handleCoinCommand(message, parsed); return; }

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
      "Права Anfisa: " + levelLabel(level)
    ].join("\n");
    await saveState();
    await send(chat.id, activityText, message.message_id);
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
    const count = state.warnings[keyFor(chat.id, target.id)] || 0;
    await send(chat.id, `${displayName(target)}: ${count}/${MAX_WARNS} предупреждений.`, message.message_id);
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
  const reason = parsed.reason;

  try {
    switch (parsed.action) {
      case "warn": {
        const key = keyFor(chat.id, target.id);
        const count = (state.warnings[key] || 0) + 1;
        state.warnings[key] = count;
        await saveState();

        if (count >= MAX_WARNS) {
          await api("banChatMember", { chat_id: chat.id, user_id: target.id });
          delete state.warnings[key];
          await saveState();
          await send(chat.id,
            `⛔ ${targetName} получил(а) ${MAX_WARNS}-е предупреждение и забанен(а).${reasonSuffix(reason)}`,
            message.message_id);
        } else {
          await send(chat.id,
            `⚠️ Предупреждение ${count}/${MAX_WARNS} для ${targetName}.${reasonSuffix(reason)}`,
            message.message_id);
        }
        break;
      }
      case "ban":
        await api("banChatMember", { chat_id: chat.id, user_id: target.id });
        await send(chat.id, `⛔ ${targetName} забанен(а) администратором ${displayName(sender)}.${reasonSuffix(reason)}`, message.message_id);
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
        });
        await send(chat.id, `🔇 ${targetName} получил(а) мут до снятия администратором.${reasonSuffix(reason)}`, message.message_id);
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
  const me = await api("getMe");
  console.log(`Started ${me.first_name}${me.username ? ` (@${me.username})` : ""}. Polling Telegram updates...`);

  while (true) {
    try {
      const updates = await api("getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "pre_checkout_query"],
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
