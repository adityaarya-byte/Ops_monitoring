# Ops Monitoring — Slack Rejection Alert Pipeline

Google Apps Script pipeline that fetches Slack rejection alerts, parses them into structured rows, and aggregates incident sessions in Sheets.

## Deploy

1. Open the bound Apps Script project for your spreadsheet.
2. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Confirm Script Property `TOKEN` holds the Slack bot token.
4. Run `setupSheets()`, then `installTrigger()` (every 5 minutes) or `fetchAndProcessPipeline()` once.

## V2.2 fixes

- **Frozen-row crash**: raw staging clear uses `clearContent` instead of `deleteRows` (avoids *Sorry, it is not possible to delete all non-frozen rows*).
- **Channel naming**: `C0BDYE1RQTH` is tracked as `insufficient-funds-rails-mercury-rejections`.
- **Symbol parsing**: keeps full instruments such as `B-S-HBAR_USDT` (no `B-S-` strip).
- **Slack markdown**: strips `*` / backticks from field values; supports bullet and single-line label formats.

## Tests

```bash
npm test
```

Parser core used by tests lives in [`src/parser.js`](src/parser.js) and must stay in sync with the parser section inside `apps-script/Code.gs`.
