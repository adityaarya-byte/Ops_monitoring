# Token Health

Google Apps Script tracker for listing / volume / chain D1W1 health.

## D1W1 rule

For each token, for each exchange (KuCoin, Binance, Gate):

> If **any** chain has `deposit=Yes` **and** `withdraw=Yes` → that exchange counts as **1**.

Example **GRT**: KuCoin none, Binance ARBITRUM, Gate ETH/ARBEVM → count **2** (`Gate,Binance`).

**CHR** with KuCoin+Binance+Gate all D1W1 somewhere → count **3** → no alert if previous was also 3.

Asymmetric **D0W1** (deposit NO, withdraw Yes) is shown on CHAIN/Monitoring only — it does **not** trigger alerts (this was the CHR false positive).

## Action column (ALERTS col F)

| Change | Action |
|--------|--------|
| 3 → 2 | No action |
| 2 → 1 | Ask MOC and Fund Ops; add to TPE withdrawal sheet |
| 1 → 0 | Check funds should be TPE |
| 1 → 2 | No action |
| 2 → 3 | Remove from TPE withdrawal sheet |

Sheet `TPE withdrawal` is auto-updated for add/remove actions.

## Sheets

HEALTH, CHAIN, ALERTS, Monitoring, TPE withdrawal

## Entry point

`runAllCryptoTrackers()`
