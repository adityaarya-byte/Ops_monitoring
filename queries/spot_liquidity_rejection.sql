-- TODO: replace with the spot liquidity / circuit-breaker rejection query.
-- % rejection due to Liquidity (CB).
--
-- Placeholders: {{token}} {{market}} {{listing_at}} {{tracking_start}}
--               {{window_start}} {{window_end}} {{quote_currency}}
--
-- Required: return one row with column liquidity_rejection_pct (or rejection_pct).

SELECT
  100.0 * SUM(CASE WHEN reject_reason IN ('LIQUIDITY', 'CB') THEN 1 ELSE 0 END)
    / NULLIF(COUNT(*), 0) AS liquidity_rejection_pct
FROM your_schema.spot_order_rejections
WHERE market = '{{token}}'
  AND event_time >= TIMESTAMP '{{tracking_start}}'
  AND event_time < TIMESTAMP '{{window_end}}'
