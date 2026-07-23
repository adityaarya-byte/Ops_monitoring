# Ops Monitoring — Slack Rejection Alert Pipeline

Google Apps Script pipeline that fetches Slack rejection alerts, parses them into structured rows, and aggregates incident sessions in Sheets.

## Deploy

1. Open the bound Apps Script project for your spreadsheet.
2. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Confirm Script Property `TOKEN` holds the Slack bot token.
4. Run `setupSheets()`, then `installTrigger()` (every 5 minutes) or `fetchAndProcessPipeline()` once.

## Allowlist (V2.3)

| Channel | Kept reasons |
|---|---|
| `cb-order-rejection` (`C0BCN9QG679`) | Only *The market is too volatile right now. Please try again later* |
| All other channels | Only insufficient / balance keywords (`insufficient`, `not enough balance`, `BALANCE_NOT_ENOUGH`, etc.) |

## V2.3 fixes

- CB digest drops `insufficient funds`, `something went wrong`, and any non-volatile reason.
- Non-CB channels drop fill-timeout / generic “Order action failed” / etc.
- Parses `Production Binance MANTAUSDT sell … rejected: response {…}` and Gateio `InsufficientFunds` CREATE failures.
- Parses `Instrument/Symbol: SAPIENUSDT` and `Symbol: B-S-HBAR_USDT` with full token + real insufficient reason (not blank / “Order rejected”).

## Deploy / rebuild

1. Paste [`apps-script/Code.gs`](apps-script/Code.gs) into the bound Apps Script project.
2. Run **`resetAndRebuildAllowlistedAlerts()`** once — clears stale transform/alerts, resets Slack cursors, and rebuilds from the last 48h with the allowlist applied.
3. Or run `setupSheets()` then `fetchAndProcessPipeline()` if you prefer not to wipe history.

## Tests

```bash
npm test
```

Parser core used by tests lives in [`src/parser.js`](src/parser.js) and must stay in sync with the parser section inside `apps-script/Code.gs`.
