# Anfisa | CHAT-MANAGER

Standalone Telegram group moderation bot. It is not connected to EKOOOL or any other project.

## Commands (group administrators only)

Use commands by replying to the target member's message:

- `варн`, `.варн`, `varn` — issue a warning. At 3 warnings, the bot bans the member.
- `бан`, `.бан`, `ban` — ban the replied-to member.
- `мут`, `.мут`, `mut` — restrict the replied-to member from sending messages, media, polls, links, and other content.
- `размут`, `.размут`, `unmute` — restore normal member permissions.
- `варны`, `.варны`, `warns` — show warning count for the replied-to member.
- `помощь`, `.помощь`, `help` — show help.

An optional reason can follow a command, for example: `варн спам`.

## Telegram setup

1. Create a new bot with `@BotFather` and copy its token.
2. Add it to the group and promote it to administrator.
3. Enable at least **Ban users** and **Restrict members** permissions. Message deletion is not required.
4. Run this folder with Node.js 20+ (for example, locally or on a compatible always-on host).
5. Set `TELEGRAM_BOT_TOKEN` in the environment. Optionally set `ALLOWED_CHAT_IDS` to comma-separated group IDs.
6. Start command: `npm start`.

## Notes

- Warning counts are stored in `data.json`. On hosts where the local filesystem resets, warning history can be lost; use persistent storage or a database for durable history.
- The bot intentionally requires replying to the target member's message for moderation commands.
- The bot refuses to moderate group owners, administrators, bots, or the command sender.
- Never publish the bot token.
