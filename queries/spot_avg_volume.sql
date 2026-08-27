-- TODO: replace with the avg volume-per-day query.
-- The job starts using this 24 hours after Date of listing (date + time).
--
-- Placeholders you can use:
--   {{token}}            token as entered in column A (e.g. BTCUSDT)
--   {{market}}           CoinDCX market name if resolved
--   {{listing_at}}       listing datetime ISO-8601 (IST)
--   {{tracking_start}}   listing_at + 24 hours
--   {{window_start}}     now - 24 hours (rolling window)
--   {{window_end}}       now
--   {{quote_currency}}   USDT or INR when known
--
-- Required: return one row with column avg_volume_per_day (or volume).

SELECT
  AVG(notional_volume) AS avg_volume_per_day
FROM your_schema.spot_volume_daily
WHERE market = '{{token}}'
  AND trade_date >= TIMESTAMP '{{tracking_start}}'
  AND trade_date < TIMESTAMP '{{window_end}}'
