# New listing performance metrics

Ops tracker for CoinDCX **new listing** performance. This first slice is **SPOT rejections**.

You type the token and the listing date/time. A daily job fills the rest of the `SPOT` tab on a rolling 24-hour window.

Spreadsheet: [New Listing metrics (performance checks)](https://docs.google.com/spreadsheets/d/1yiO9iG0nBCAIO5mzmJTUJI3YxT7XJ4OeNuhKn2qfZZ8/edit)

## SPOT tab

| Column | Who fills it | Source |
| --- | --- | --- |
| A Token (pair) | You | e.g. `BTCUSDT`, `ETH/USDT`, `SOLINR` |
| B Avg. Volume per day | Job, after 24h | SQL query you will provide (`queries/spot_avg_volume.sql`) |
| C Avg buying price of user from listing | Job, after 24h | Lake trades query you will provide (`queries/spot_avg_buy_price.sql`) |
| D Current Price | Job, immediately | CoinDCX public ticker (`last_price`) |
| E % rejection due to Liquidity (CB) | Job, after 24h | Rejection query you will provide (`queries/spot_liquidity_rejection.sql`) |
| F Date of listing | You | Date **and time**, IST. `15/07/2026 14:00` or `15/07/2026` (midnight IST) |
| G days since listing | Job, immediately | `(now - listing datetime)` in days |

The job **never overwrites** columns A or F.

## When tracking starts

If a token is listed at `15/07/2026 14:00` IST:

- Current price and days-since-listing start as soon as A + F are filled.
- Volume, avg buy price, and rejection % start at `16/07/2026 14:00` IST (24 hours later).
- After that, values refresh on a rolling 24-hour window (GitHub Action daily at 01:00 IST).

## How to run locally

```bash
python -m pip install -e ".[dev]"
pytest
python -m listing_metrics --input-csv data/spot_input.csv --output-csv data/spot_output.csv --print-json
```

That dry-run hits the live CoinDCX ticker and writes current price + days into a local CSV. Volume / buy price / rejection stay empty until the queries are wired.

## Plug in the warehouse queries

1. Paste the real SQL into:
   - `queries/spot_avg_volume.sql`
   - `queries/spot_avg_buy_price.sql`
   - `queries/spot_liquidity_rejection.sql`
2. In `config/settings.yaml` set those sources to `sql`.
3. Tell us the lake (BigQuery / Postgres / etc.) and we will connect the executor.

Placeholders already supported in the SQL files: `{{token}}`, `{{market}}`, `{{listing_at}}`, `{{tracking_start}}`, `{{window_start}}`, `{{window_end}}`, `{{quote_currency}}`.

Until then, `sources.avg_volume: coindcx_public` can temporarily use CoinDCX 24h ticker volume. That is **not** the long-term source — your query is.

## Write to the Google Sheet

1. Create a Google Cloud service account, download JSON.
2. Share the spreadsheet with that service account email (Editor).
3. Set `GOOGLE_APPLICATION_CREDENTIALS` locally, or GitHub secret `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. Run:

```bash
python -m pip install -e ".[sheets]"
python -m listing_metrics --sheet --print-json
```

## In-sheet option (no GitHub)

`apps_script/Code.gs` can be pasted into **Extensions → Apps Script** on that spreadsheet. It fills **current price** and **days since listing** only. Attach a daily time-driven trigger.

## Futures

The `Future` tab (volume, exposure, P/L due to exposure) is next, after SPOT rejections is filling correctly.
