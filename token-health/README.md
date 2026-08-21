# Token Health

## Alerts → Slack Incoming Webhook

One message **per token**. No bot `chat:write` scope needed.

### Setup
1. Create Incoming Webhook for `#token-health-alerts` (URL starts with `https://hooks.slack.com/services/...`)
2. In Apps Script, either:
   - Paste URL into `setSlackWebhookUrl()` and **Run** once, or
   - Script Properties → `SLACK_WEBHOOK_URL` = your webhook URL

### Format
```
GRT | D1W1 : 2→1 | Current Active: Gate
Action: Ask MOC and Fund Ops; add to TPE withdrawal sheet
Verified: 2026-08-21 14:55 IST
```

### Skipped
- 3 → 2
- USDT / USDC

Entry point: `runAllCryptoTrackers()`
