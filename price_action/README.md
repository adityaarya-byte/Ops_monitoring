# price_action — Token Health / Withdrawal Alerts

Single-file Google Apps Script (`Code.gs`).

## Sheets

| Tab | Purpose |
|-----|---------|
| `HEALTH` | Token inputs + price/volume/listing |
| `CHAIN` | Per-chain deposit/withdraw matrix |
| `ALERTS` | Withdrawal OFF / ON history |
| `Monitoring` | Flattened monitoring export |

## Alerts

| Transition | Event logged | Email |
|------------|--------------|-------|
| Yes → NO | `Withdrawal OFF` | Binance (with red reason) or KuCoin/Gate |
| NO → Yes | `Withdrawal ON` | Resumed digest (all exchanges) |

Example ALERTS rows:

```
2026-08-09 5:27   RVN  Binance  RVN  Withdrawal OFF  TEMPORARY  The wallet is currently undergoing maintenance...
2026-08-09 8:10   RVN  Binance  RVN  Withdrawal ON   RESTORED   Binance has turned withdrawals back ON for RVN on RVN...
```

## Setup

1. Paste `Code.gs` into Apps Script.
2. Ensure tabs `HEALTH`, `CHAIN`, `ALERTS`, `Monitoring` exist.
3. Keep CMC key in `CONFIG.CMC_API_KEY` (or Script Property `CMC_API_KEY`).
4. Trigger `runAllCryptoTrackers` on a schedule.
