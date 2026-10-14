# Anfisa | CHAT-MANAGER

Telegram group moderation bot. Requires Node.js 20+.

## Environment variables

Set these in the hosting service (do not commit tokens or passwords):

- `TELEGRAM_BOT_TOKEN` — required Telegram bot token.
- `BOT_OWNER_ID` — owner's Telegram numeric ID; used for owner-only coin grants and emoji-test commands.
- `SERVICE_CHAT_ID` — optional ID of the private service group where moderation logs and appeals are forwarded.
- `HELPER_USER_IDS` — optional comma-separated Telegram IDs of helpers who receive reports and appeals.
- `UPDATE_CHANNEL_ID` — optional channel username or ID for automated update announcements.
- `PANEL_PASSWORD` — **required to enable the protected web panel**. Use a long, unique password; do not reuse your Telegram password.
- `PORT` — supplied by the host automatically on most platforms.
- `DATA_FILE` — optional path to persistent JSON state; default is `./data.json`.

The host must preserve `data.json` (or set `DATA_FILE` to persistent storage) between restarts if warnings, balances, group settings and logs are to survive redeploys.

## Moderation commands

Commands that act on a member are used as a reply to their message:

- `.варн` — warn; the default is automatic ban after 3 warnings.
- `.бан` — ban permanently; `.бан 1д` — ban for one day.
- `.мут` — mute until lifted; `.мут 10м` — mute for ten minutes.
- `.размут` — remove mute.
- `.варны` — show warning count.
- `.репорт` — report a replied-to message to helpers and the service chat.
- `.статистика` — group statistics for administrators.
- `.антиспам вкл/выкл` — toggle repeated-message and flood checks.
- `.рейд вкл/выкл` — toggle join-spike protection; in raid mode new members pass a one-tap check.
- `.приветствие вкл/выкл` — toggle welcome messages.
- `.апелляция CHAT_ID reason` — submit an appeal in the bot's private chat.
- `.магазин` — open the cosmetic badge shop (15/25/50 Анфисокоинов).
- `.купитьзначок щит`, `.купитьзначок звезда` or `.купитьзначок корона` — buy a decorative badge.
- `.значок` — display owned badges; `.топкоинов` — show the coin leaderboard.

Temporary durations support seconds, minutes, hours, or days; Telegram requires a duration of at least 30 seconds and at most 366 days. The bot needs administrator rights to delete messages, restrict members or ban members.

## Web panel

Once deployed, open the service URL in a browser. Set `PANEL_PASSWORD` in the host environment and restart the service. Sign in with that panel password. The panel shows known groups, recent activity, active warnings, moderation logs, reports and appeals, lets you toggle anti-spam, raid protection and welcome messages, and lets you assign or remove Anfisa moderator levels (levels 2 and 3). Actual Telegram administrators cannot be assigned an internal bot level.

A group appears in the panel after Telegram delivers at least one update from it. Raid protection starts after 5 or more new human accounts arrive within one minute; later joiners are temporarily restricted and can unlock messaging with the verification button. This is a basic anti-raid check, not a guaranteed CAPTCHA or proof of identity. Use HTTPS at the hosting provider; the panel does not implement TLS itself.

## Checks

GitHub Actions runs `node --check index.js` when the bot code changes.
