# Regitra Daily Check (GitHub Actions)

This project runs daily in GitHub Actions and checks these values from:
`https://www.eregitra.lt/services/vehicle-registration/data-search`

- `draudimas galioja`
- `leidimas dalyvauti eisme`
- `technikine`

## Why inputs stay private
Your car data is read from **GitHub repository secrets**, not from code.

Required secrets:

- `REGITRA_PLATE_NUMBER`
- `REGITRA_REG_CERT_NUMBER`

Telegram secrets (required for message delivery):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Setup
1. Push this project to a GitHub repo.
2. In GitHub: `Settings -> Secrets and variables -> Actions -> New repository secret`.
3. Add the Regitra and Telegram secrets listed above.
4. Enable Actions for the repo.
5. Manually run workflow once (`Actions -> Regitra Daily Check -> Run workflow`) to validate selectors.

## Telegram setup
1. Create bot with `@BotFather` and copy bot token.
2. Start a chat with your bot (or add it to a group).
3. Get your `chat_id`:
   - Open: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Send one message to the bot first, then refresh and copy `message.chat.id`.
4. Save both values as repository secrets.

Each successful run sends one Telegram message with:
- `draudimas galioja`
- `leidimas dalyvauti eisme`
- `technikine`

If all retry attempts fail, it sends a failure message with the error.

## Schedule
Workflow is scheduled with UTC cron and internally checks local time `Europe/Vilnius` to run at 07:00 every day.

## Important about anti-bot
Even with one run/day, sites can block by IP reputation and automation fingerprint.
If GitHub-hosted runners get blocked, use a free self-hosted runner (your own machine/IP).

### Enable self-hosted mode
1. In GitHub repo variables, add `USE_SELF_HOSTED=true`.
2. Add a GitHub self-hosted runner (`Settings -> Actions -> Runners -> New self-hosted runner`).
3. Keep that runner machine online at 07:00 Europe/Vilnius.

If `USE_SELF_HOSTED` is not `true`, workflow uses normal `ubuntu-latest`.

## Anti-bot notes
- Script uses human-like typing delays, realistic browser headers, and retries.
- If Regitra shows a captcha or stronger anti-bot challenge, automation may fail (by design, no captcha bypass).
- On failures, screenshot is saved to `artifacts/last-page.png` and uploaded by Actions.

## Local run
```bash
npm install
npx playwright install chromium
REGITRA_PLATE_NUMBER="ABC123" \
REGITRA_REG_CERT_NUMBER="ABC123456" \
TELEGRAM_BOT_TOKEN="123456:abc..." \
TELEGRAM_CHAT_ID="123456789" \
node src/checkRegitra.js
```
