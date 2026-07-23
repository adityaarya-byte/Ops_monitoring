# Rejection Dashboard setup (V2.3)

## Files to paste into Apps Script

| File | Purpose |
|---|---|
| `Code.gs` | Pipeline (fetch / transform / alerts) — already writes Reason Category + Rejection Type |
| `Dashboard.gs` | `classifyReason_`, `buildDashboard()`, `buildAlertsSummaryV2()` |
| `WebApp.gs` | `doGet()`, `getDashboardData()` |
| `Index.html` | Live web UI (Chart.js) |
| `preview.html` | Optional local mock preview |

Raw branch folder:  
https://github.com/adityaarya-byte/Ops_monitoring/tree/cursor/slack-rejection-parse-fixes-9be5/apps-script

## Wire-up

1. Paste/update all files in the **same** Apps Script project.
2. Run `setupSheets` (adds Rejection Type header on `alerts`).
3. Run `resetAndRebuildAllowlistedAlerts` or `fetchAndProcessPipeline` — this rebuilds `alerts` **and** the `dashboard` sheet tab.
4. Optional: run `buildAlertsSummaryV2` for `alerts_summary` type breakdown.
5. Deploy web app: **Deploy → New deployment → Web app**
   - Execute as: Me
   - Who has access: your org (or Anyone with the link)
6. Open the deployment URL — UI auto-refreshes every 60s from the `alerts` tab.

## Classification

- `cb-order-rejection` + volatility reason → **CB Rejection / Market Volatility**
- Insufficient / balance keywords → **Balance Rejection**
- Other matched keywords → Exchange / Insta as defined in `CLASSIFY_RULES`
