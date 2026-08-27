from __future__ import annotations

from datetime import datetime

from listing_metrics.coindcx import CoinDCXPublicClient
from listing_metrics.config import Settings
from listing_metrics.lake import MetricSource, NullMetricSource
from listing_metrics.models import SpotRow, SpotUpdate
from listing_metrics.timeutil import annotate_row, utcnow


class SpotJob:
    def __init__(
        self,
        settings: Settings,
        coindcx: CoinDCXPublicClient | None = None,
        lake: MetricSource | None = None,
        public_volume: bool = False,
    ) -> None:
        self.settings = settings
        self.coindcx = coindcx or CoinDCXPublicClient()
        self.lake = lake or NullMetricSource()
        self.public_volume = public_volume or settings.avg_volume_source == "coindcx_public"

    def run(self, rows: list[SpotRow], now: datetime | None = None) -> list[SpotUpdate]:
        now = now or utcnow()
        updates: list[SpotUpdate] = []
        for row in rows:
            updates.append(self._process(row, now))
        return updates

    def _process(self, row: SpotRow, now: datetime) -> SpotUpdate:
        annotate_row(row, now, self.settings.tracking_delay_hours)
        update = SpotUpdate(
            row_number=row.row_number,
            token=row.token,
            tracking_ready=row.tracking_ready,
            notes=list(row.notes),
        )
        if row.skip_reason:
            update.notes.append(row.skip_reason)
            return update

        update.days_since_listing = row.days_since_listing
        self._fill_current_price(row, update)

        if not row.tracking_ready:
            return update

        if self.settings.avg_volume_source == "sql":
            update.avg_volume_per_day = self.lake.avg_volume_per_day(row, now)
        elif self.public_volume:
            market = self.coindcx.resolve_market(row.token)
            if market and market.volume_24h is not None:
                update.avg_volume_per_day = market.volume_24h
                update.notes.append("avg_volume used CoinDCX public 24h volume fallback")

        if self.settings.avg_buy_price_source == "sql":
            update.avg_buy_price = self.lake.avg_buy_price(row, now)
        if self.settings.liquidity_rejection_source == "sql":
            update.liquidity_rejection_pct = self.lake.liquidity_rejection_pct(row, now)
        return update

    def _fill_current_price(self, row: SpotRow, update: SpotUpdate) -> None:
        if self.settings.current_price_source != "coindcx":
            return
        market = self.coindcx.resolve_market(row.token)
        if not market:
            update.notes.append(f"token {row.token!r} not found on CoinDCX spot")
            return
        row.coindcx_market = market.market
        row.quote_currency = market.quote_currency
        update.current_price = market.last_price
