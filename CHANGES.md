# Subscription expiry fix

## Root cause
The expiry cron only notified the member *after* a successful kick, and retried a failed kick
every minute forever. When the member was the channel owner (Telegram: "can't remove chat
owner") or the bot lacked "Ban users", nothing was ever removed and no one was ever told.

## New behaviour
| When | What happens |
|---|---|
| 3 / 2 / 1 day(s) before expiry | one reminder per day with a Renew button (skipped if the member turned expiry notifications off) |
| At expiry (grace window, default 24h) | member gets "Subscription Expired — renew before <time>" |
| After grace | member is removed from the channel, sub → `expired`, member + creator + admin are told |
| Owner / admin of the channel | can never be removed by a bot → sub is still closed, member told, admin + creator informed once |
| Missing bot permission / network error | member still told; retry every 10 min (hourly after 6 tries); admin + creator alerted once per 24h with the exact fix; recovers automatically |

## Safety nets added
- `src/handlers/subscription-lifecycle.js` — all expiry logic in one place; state is tied to `expires_at`, so any renew/extend path resets it automatically.
- Compare-and-swap on every state change + per-task locks in `cron.js` → overlapping runs (node-cron + `/cron`) can't double-send or double-kick.
- `src/db/ensure-schema.js` — adds any missing DB column at startup (no manual migration needed).
- `GET /health` now shows `expiryJob.lastRunAt / lastOkAt / lastError / lastStats` — if `lastRunAt` is old, the job isn't running.
- `telegram.js`: 429 retry, non-JSON replies no longer escape as unhandled rejections, unban is retried (a banned member could not rejoin after renewing), errors are classified.
- Renewal payment now clears any leftover ban before creating the invite link.
- The bot's own kick no longer triggers a bogus "Member Left Channel" alert / status flip.
- HTML-escaping of channel/user names in these messages.

## Tests
`npm test` (Node 22+) — 16 offline simulations (fake clock + SQLite + fake Telegram).
