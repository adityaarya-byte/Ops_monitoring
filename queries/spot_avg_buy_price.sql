-- TODO: replace with the lake trades / user trading-price query.
-- Avg buying price of users from listing time (USDT or INR depending on the pair).
--
-- Placeholders: {{token}} {{market}} {{listing_at}} {{tracking_start}}
--               {{window_start}} {{window_end}} {{quote_currency}}
--
-- Required: return one row with column avg_buy_price (or avg_price / price).

SELECT
  SUM(price * quantity) / NULLIF(SUM(quantity), 0) AS avg_buy_price
FROM your_schema.lake_spot_trades
WHERE market = '{{token}}'
  AND side = 'buy'
  AND trade_time >= TIMESTAMP '{{listing_at}}'
  AND trade_time < TIMESTAMP '{{window_end}}'
