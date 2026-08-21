# Token Health

## Alerts → Slack `#token-health-alerts`

One Slack message **per token** (not batched). Format:

```
GRT | D1W1 : 2→1 | Current Active: Gate
Action: Ask MOC and Fund Ops; add to TPE withdrawal sheet
Verified: 2026-08-21 14:55 IST
```

### Skipped
- **3 → 2** (no Slack, no ALERTS row)
- **USDT** / **USDC**

### Setup Slack bot token
1. Invite bot to `#token-health-alerts`
2. Apps Script → paste token into `setSlackBotToken()` → Run once  
   Or Script Properties: `SLACK_BOT_TOKEN` = `xoxb-...`, `SLACK_CHANNEL_ID` = `C0BRWAFT24C`

### Action rules
| Change | Action |
|--------|--------|
| 2 → 1 | Ask MOC and Fund Ops; add to TPE withdrawal sheet |
| 1 → 0 | Check funds should be TPE |
| 1 → 2 | No action |
| 2 → 3 | Remove from TPE withdrawal sheet |

Entry point: `runAllCryptoTrackers()`
