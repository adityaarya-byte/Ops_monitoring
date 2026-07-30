# Token Health

Google Apps Script project that tracks token listing / volume / deposit-withdraw health across Binance, KuCoin, and Gate, and writes results into a Google Sheet.

## Sheets required

| Tab | Purpose |
|-----|---------|
| `HEALTH` | Input tokens (A), ecode (B), CMC id (C); outputs price/volume/listing cols D–L |
| `CHAIN` | Per-chain deposit/withdraw matrix + summary (J–M) |
| `ALERTS` | Append-only alert history |
| `Monitoring` | Flattened monitoring export (A–G) |

## Apps Script setup

1. Open the target Google Sheet → **Extensions → Apps Script**.
2. Copy each `.gs` file from this folder into the Apps Script project (same filenames).
3. Set the CoinMarketCap API key (optional but recommended):

   ```javascript
   // Run once in the script editor:
   function setCmcApiKey() {
     PropertiesService.getScriptProperties()
       .setProperty('CMC_API_KEY', 'YOUR_KEY_HERE');
   }
   ```

   If unset, the script falls back to `CONFIG.CMC_API_KEY` in `Config.gs`.

4. Create a time-driven trigger on `runAllCryptoTrackers` (e.g. every 15–30 minutes).

## Binance volume reliability

Binance 24h ticker fetches can intermittently fail (timeouts, 418/429, empty/non-JSON bodies). When that happened previously, volumes were silently written as `0`.

This project mitigates that by:

- Checking HTTP status before parsing
- Retrying with backoff across multiple Binance hosts
- Logging response codes / payload shape on failure
- Preserving the previous HEALTH Binance volume column when a fresh Binance ticker pull fails (so a flaky fetch does not wipe good data to zeros)

## Entry point

```javascript
runAllCryptoTrackers()
```
