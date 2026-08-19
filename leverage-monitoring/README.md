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

## Deploy

1. Open the spreadsheet. **Extensions → Apps Script**. Paste [`Code.gs`](Code.gs).
2. Set `CONFIG.EMAIL_TO`. Optional: copy [`appsscript.json`](appsscript.json) (timezone `Asia/Kolkata`).
3. Run **`runLeverageCheckNow`** to test. Run **`setupWeeklyTrigger`** once to schedule Monday 8am.
