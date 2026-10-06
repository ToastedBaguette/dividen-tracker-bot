# Dividen Tracker Bot

Personal Discord bot that tracks **upcoming dividends of Indonesian stocks (IDX)** — every
announced dividend that can still be caught, **nearest cum date first** — and posts a digest every
evening before a trading day. Replies are in Bahasa Indonesia.

Sister project of [expense-tracker-bot](https://github.com/ToastedBaguette/expense-tracker-bot) and
[calorie-tracker-bot](https://github.com/ToastedBaguette/calorie-tracker-bot) — same stack: Node.js,
discord.js, Docker Compose. No database, no Google credentials: the only secret is the Discord token,
and the watchlist is kept in a pinned message in the bot's channel.

## Features

| | |
|---|---|
| 📅 **Daily digest** | 20:00 WIB, Sunday–Thursday (the evening before each trading day): stocks whose cum date is in the next 7 days, grouped by date, with dividend per share, yield at the current price, and payment date. "Besok" marks tomorrow as the last day to buy. |
| 📋 **All upcoming** | `dividen` lists every announced dividend that can still be bought. |
| 🔎 **Per stock** | `dividen BBRI` (or just `BBRI`): announced dividend, last price, trailing 12-month yield, last 6 payouts. |
| ⭐ **Watchlist** | `pantau BBRI 10` — watch a stock, optionally with the lots you hold. Watched stocks are starred and listed first in the digest with the cash your lots would get, and the digest shows when a held stock's dividend is paid. |
| 🚨 **Source alerts** | If the data source breaks (site down, layout changed, data stops updating), the bot says so in the channel once, keeps serving the last good data, and says so again when it recovers. |

**Cum date** is the last day to buy in the regular market and still receive the dividend; buying on
the ex date or later does not qualify. After market close (16:00 WIB) today's cum date is over, so
every list starts from the next day. Not investment advice — confirm on IDX disclosures before trading.

## Commands

| Message | What it does |
|---|---|
| `dividen` / `jadwal` | All upcoming dividends, nearest cum date first |
| `dividen BBRI` / `BBRI` | One stock — the bare form must be typed in capitals |
| `ringkasan` / `digest` | Post the daily digest now |
| `pantau BBRI` / `pantau BBRI 10` | Watch a stock; the number is the lots you hold (1 lot = 100 shares). Several at once: `pantau BBRI 10 ASII`. `pantau BBRI 0` clears the lots |
| `lepas BBRI` | Stop watching |
| `pantauan` | The watchlist: announced dividends, expected payouts, company names |
| `status` | Data source health, last update, errors, watchlist |
| `bantuan` / `help` | Usage guide |

## Data sources

| Data | Source | Notes |
|---|---|---|
| Announced dividends (cum / ex / recording / payment date, amount) | [SahamIDX](https://www.new.sahamidx.com/?/deviden) — HTML table, scraped | Unofficial. The official IDX site blocks scripts (Cloudflare). |
| Price, company name, dividend history | Yahoo Finance chart API (`BBRI.JK`) | Unofficial, no key. If it fails, yields are just left out. |

`src/providers.js` holds the source list **in fallback order**: the first provider that returns valid
data wins. Data counts as invalid when the request fails, the table is missing, no row parses, or the
newest cum date is more than 45 days old (the site stopped updating). Only SahamIDX is configured today;
a paid API can be added as a second provider.

## Setup

1. **Discord app** — https://discord.com/developers/applications → New Application → Bot → copy the
   token, enable **MESSAGE CONTENT INTENT**. Invite it (OAuth2 → URL Generator → `bot` scope) with
   *View Channel, Send Messages, Embed Links, Read Message History, Pin Messages* in your channel.
   The watchlist lives in a message the bot pins there, **📌 Daftar Pantauan** — don't delete or unpin
   it. Without *Pin Messages*, pin that message by hand once.
2. `cp .env.example .env` and fill in `DISCORD_TOKEN` and `DISCORD_CHANNEL_ID`.
3. Run:
   ```bash
   docker compose up -d --build     # or: npm install && npm start
   ```

| Variable | Required | Default | |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | | Bot token |
| `DISCORD_CHANNEL_ID` | for the digest | | Digest, alerts, and commands go here. Without it: commands in any channel, no digest. |
| `DISCORD_AUTHORIZED_USERS` | no | everyone | Comma-separated user IDs allowed to use commands |
| `DIGEST_TIME` | no | `20:00` | Digest time, Asia/Jakarta. From 16:00 on it posts Sun–Thu (evening before a trading day); earlier, Mon–Fri |
| `DIGEST_DAYS` | no | `7` | How many days ahead the digest looks |

## Development

```bash
npm test               # unit tests (parser runs against a saved SahamIDX page)
npm run preview        # print the digest from live data — no Discord needed
npm run preview -- 30  # look 30 days ahead
```
