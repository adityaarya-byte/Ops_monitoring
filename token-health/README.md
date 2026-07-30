# Token Health

Single-file Google Apps Script tracker for token listing / volume / deposit-withdraw health across Binance, KuCoin, and Gate.

## File

- `Code.gs` — paste this into Apps Script (entry point: `runAllCryptoTrackers`)

## Sheets required

| Tab | Purpose |
|-----|---------|
| `HEALTH` | Input tokens (A), ecode (B), CMC id (C); outputs price/volume/listing cols D–L |
| `CHAIN` | Per-chain deposit/withdraw matrix + summary (J–M) |
| `ALERTS` | Append-only alert history |
| `Monitoring` | Flattened monitoring export (A–G) |

## Setup

1. Open the Google Sheet → **Extensions → Apps Script**.
2. Replace the default script with `Code.gs`.
3. Run `setCmcApiKey()` once after pasting your CMC key into that function (or set Script Property `CMC_API_KEY`).
4. Create a time-driven trigger on `runAllCryptoTrackers`.

## Binance volume reliability

Binance 24h ticker fetches can intermittently fail (timeouts, 418/429/451, empty/non-JSON). Previously that silently wrote volume `0`.

This script:

- Retries with backoff across multiple Binance hosts
- Validates HTTP status + JSON array shape
- Preserves the previous HEALTH Binance volume column when a fresh pull fails
