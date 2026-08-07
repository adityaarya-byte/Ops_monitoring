# price_action — Token Health / Withdrawal Alerts

Single-file Google Apps Script (`Code.gs`).

## Sheets

| Tab | Purpose |
|-----|---------|
| `HEALTH` | Token inputs + price/volume/listing |
| `CHAIN` | Per-chain deposit/withdraw matrix |
| `ALERTS` | Withdrawal-off history (with Binance reason) |
| `Monitoring` | Flattened monitoring export |

## Alerts (new format)

Triggers only when withdrawal goes **Yes → NO** for a monitored token/chain:

1. **Email 1 — Binance**  
   Includes `withdrawDesc` in **red**, tagged `TEMPORARY` / `PERMANENT` / `UNKNOWN`.

2. **Email 2 — KuCoin + Gate**  
   State-only (APIs do not provide a reason).

Coverage / D1W1 email alerts are removed. Live exchange summary still writes to CHAIN columns J–L.

## Setup

1. Paste `Code.gs` into Apps Script bound to the sheet.
2. Ensure tabs `HEALTH`, `CHAIN`, `ALERTS`, `Monitoring` exist.
3. Trigger `runAllCryptoTrackers` on a schedule.

## Note

Local only for now — not pushed to GitHub until approved.
