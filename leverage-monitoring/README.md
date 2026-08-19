# Leverage monitoring (Live Checks)

Weekly check of the **Outcome** sheet. Four checks per symbol are written to **Live Checks** and emailed every Monday at 8am (spreadsheet timezone).

## Master actions

| Priority | When | Action |
|---|---|---|
| **1-CRITICAL** | Utilization ≥ 100% **and** Max Notional to Users **> 450,000** | Capacity breach — reclass tier or add Binance capacity / cut leverage |
| **2-WARNING** | Highest single user / DCX on Binance **> 70%** | Cap user / add DCX margin |
| **2-WARNING** | Highest single user / Max Notional **≥ 70%** | Cap user position |
| **3-WATCH** | Utilization ≥ 70% (including ≥ 100% when max notional ≤ 450,000) | Monitor, pre-position capacity |
| **4-ACTION** | Both weeks underutilized **and** Max Notional to Users **> 450,000** | Reduce tier on DCX |
| OK | None of the above | No action |

Utilization ≥ 100% on a name with Max Notional **≤ 450,000** is **not** 1-CRITICAL. It still shows as utilization `CRITICAL - BREACH` on the sheet, but MASTER ACTION is 3-WATCH (or a concentration warning if that also fires).

Underutilized names with Max Notional **≤ 450,000** do **not** get a reduce-tier action.

## Ignore / exception list

To keep a token off Live Checks and the email, add it to `CONFIG.IGNORE_SYMBOLS` using the exact symbol from the Outcome sheet:

```javascript
IGNORE_SYMBOLS: ['BTCUSDT', 'ETHUSDT'],
```

Matching is case-insensitive (`btcusdt` also works). Leave it as `[]` to include every symbol.

## Deploy (copy-paste into Apps Script)

Do **not** copy from the GitHub file view (that often includes line numbers). Use the raw file:

1. Open this URL: [raw Code.gs](https://raw.githubusercontent.com/adityaarya-byte/Ops_monitoring/cursor/leverage-max-notional-tier-2766/leverage-monitoring/Code.gs)
2. `Ctrl+A` (or `Cmd+A`) → `Ctrl+C` / `Cmd+C`
3. In the Google Sheet: **Extensions → Apps Script**. Delete any existing code. `Ctrl+V` / `Cmd+V`. Save.
4. Set `CONFIG.EMAIL_TO` if needed.
5. Run **`runLeverageCheckNow`** to test. Run **`setupWeeklyTrigger`** once to schedule Monday 8am.
