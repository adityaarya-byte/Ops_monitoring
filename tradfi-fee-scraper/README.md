# TradFi Futures fee scraper

Beautiful Soup scraper for the Binance **TradFi Futures** fee table:

[https://www.binance.com/en/fee/tradFiFee](https://www.binance.com/en/fee/tradFiFee)

Columns match the Trading → TradFi Futures tab:

| Level | 30D Trade Volume (USD) | and/or | BNB Balance | Maker | Taker | Taker (BNB 10% off) |

## Why HTML + API

The fee page is a React app. A plain `requests` + Beautiful Soup fetch of the URL does **not** include the VIP rows (they render in the browser). The scraper still uses Beautiful Soup on the page HTML, then fills the table from the same public sources the page uses:

1. Parse the fee page with Beautiful Soup (`title`, tabs, `__APP_DATA`, `biz-fee` script URL, any rendered `<table>`).
2. Load VIP volume / BNB gates from  
   `/bapi/composite/v1/public/commission/futures-trade-level/get`.
3. Read TradFi promotional maker/taker rates from the `biz-fee` JavaScript bundle (those rates are not in the JSON API).

If you pass a saved, fully rendered HTML file that already contains the table, Beautiful Soup parses the rows directly.

## Setup

```bash
python3 -m pip install -r tradfi-fee-scraper/requirements.txt
```

## Usage

```bash
# Pretty table (default)
python3 tradfi-fee-scraper/scrape_tradfi_fees.py

# JSON or CSV
python3 tradfi-fee-scraper/scrape_tradfi_fees.py --format json
python3 tradfi-fee-scraper/scrape_tradfi_fees.py --format csv -o tradfi_fees.csv

# Pin a host (binance.com is often WAF-challenged; binance.info usually works)
python3 tradfi-fee-scraper/scrape_tradfi_fees.py --url https://www.binance.info/en/fee/tradFiFee
```

## Tests

```bash
cd tradfi-fee-scraper
python3 -m unittest tests.test_scrape_tradfi_fees -v
```
