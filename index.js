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
const HELPER_USER_IDS = new Set((process.env.HELPER_USER_IDS || "").split(",").map((v) => v.trim()).filter(Boolean));
const GRID_BAN_CONCURRENCY = 5;
let offset = 0;
let state = { warnings: {}, groupIds: [], helperLastSeen: {} };
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
};

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!state || typeof state !== "object" || !state.warnings) state = { warnings: {} };
    if (!Array.isArray(state.groupIds)) state.groupIds = [];
    if (!state.helperLastSeen || typeof state.helperLastSeen !== "object") state.helperLastSeen = {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not load data.json:", error);
    state = { warnings: {}, groupIds: [], helperLastSeen: {} };
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
      lines.length ? "👥 <b>Помощники Anfisa</b>\\nСтатус основан на активности в сообщениях боту, а не на реальном статусе Telegram Online.\\n\\n" + lines.join("\\n")
        : "Список помощников не настроен. Добавьте их Telegram ID в HELPER_USER_IDS.",
      message.message_id, "HTML");
    return true;
  }

  if (parsed.action === "serviceHelp") {
    const mentions = [...HELPER_USER_IDS].map((id) => `<a href="tg://user?id=${id}">помощник</a>`).join(" ");
    await send(message.chat.id,
      `🆘 ${mentions || "Помощники не настроены"}\\nНужна помощь в служебном чате. Запрос от <a href="tg://user?id=${sender.id}">${escapeHtml(displayName(sender))}</a>.`,
      message.message_id, "HTML");
    return true;
  }

  if (parsed.action === "ping") {
    const start = process.hrtime.bigint();
    const sent = await send(message.chat.id, "🏓 Проверяю отклик…", message.message_id);
    const elapsedNs = process.hrtime.bigint() - start;
    const ms = Number(elapsedNs) / 1e6;
    const edited = `🏓 <b>Pong!</b>\\nВремя ответа Telegram API: <code>${ms.toFixed(2)} мс</code>\\nЛокальное измерение: <code>${elapsedNs.toString()} нс</code> (наносекунды не означают точность сетевого измерения).`;
    await api("editMessageText", { chat_id: message.chat.id, message_id: sent.message_id, text: edited, parse_mode: "HTML", disable_web_page_preview: true });
    return true;
  }

  if (parsed.action === "gridBan") {
    const target = message.reply_to_message?.from;
    const idText = parsed.reason.match(/\\d+/)?.[0];
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
      `🛡 <b>Глобальная блокировка завершена</b>\\nID: <code>${targetId}</code>\\nУспешно заблокирован в группах: <b>${banned}</b>\\nНе удалось / защищённые участники: <b>${failed}</b>\\n\\nБот знает только группы, из которых получал обновления, и где у него есть права администратора.`,
      message.message_id, "HTML");
    return true;
  }
  return false;
}

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.chat || !message.from || typeof message.text !== "string") return;

  const chat = message.chat;
  const sender = message.from;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

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

  const parsed = parseCommand(message.text);
  if (!parsed) return;

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
    admin = await isAdmin(chat.id, sender.id);
  } catch (error) {
    console.error("Could not verify administrator:", error.message);
    await send(chat.id, "Не удалось проверить права администратора. Попробуйте позже.", message.message_id);
    return;
  }

  if (!admin) return;

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
        allowed_updates: ["message"],
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
