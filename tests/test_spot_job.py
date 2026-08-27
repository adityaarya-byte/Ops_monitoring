from datetime import datetime
from zoneinfo import ZoneInfo

from listing_metrics.coindcx import CoinDCXPublicClient, SpotMarket, normalize_token
from listing_metrics.config import load_settings
from listing_metrics.lake import NullMetricSource
from listing_metrics.models import SpotRow
from listing_metrics.spot_job import SpotJob

IST = ZoneInfo("Asia/Kolkata")


class FakeCoinDCX(CoinDCXPublicClient):
    def __init__(self, markets: dict[str, SpotMarket]):
        super().__init__()
        self._markets = markets

    def resolve_market(self, token: str) -> SpotMarket | None:
        return self._markets.get(normalize_token(token))


def _job(volume_source: str = "none", **kwargs) -> SpotJob:
    settings = load_settings()
    object.__setattr__(settings, "avg_volume_source", volume_source)
    object.__setattr__(settings, "avg_buy_price_source", kwargs.get("buy", "none"))
    object.__setattr__(settings, "liquidity_rejection_source", kwargs.get("rej", "none"))
    return SpotJob(
        settings,
        coindcx=kwargs.get(
            "coindcx",
            FakeCoinDCX(
                {
                    "BTCUSDT": SpotMarket(
                        market="BTCUSDT",
                        pair="B-BTC_USDT",
                        last_price=78821.4,
                        volume_24h=1000.0,
                        quote_currency="USDT",
                        base_currency="BTC",
                    )
                }
            ),
        ),
        lake=kwargs.get("lake", NullMetricSource()),
        public_volume=kwargs.get("public_volume", False),
    )


def test_fills_current_price_and_days_but_waits_24h_for_other_metrics():
    listing = datetime(2026, 8, 26, 12, 0, tzinfo=IST)
    now = datetime(2026, 8, 27, 11, 59, tzinfo=IST)
    row = SpotRow(row_number=2, token="BTCUSDT", listing_at=listing)
    updates = _job(public_volume=True).run([row], now=now)
    assert updates[0].current_price == 78821.4
    assert updates[0].days_since_listing == 0.9993
    assert updates[0].tracking_ready is False
    assert updates[0].avg_volume_per_day is None
    assert updates[0].avg_buy_price is None
    assert updates[0].liquidity_rejection_pct is None


def test_after_24h_public_volume_fallback_is_used():
    listing = datetime(2026, 8, 26, 12, 0, tzinfo=IST)
    now = datetime(2026, 8, 27, 12, 0, tzinfo=IST)
    row = SpotRow(row_number=2, token="BTCUSDT", listing_at=listing)
    update = _job(public_volume=True).run([row], now=now)[0]
    assert update.tracking_ready is True
    assert update.avg_volume_per_day == 1000.0
    assert update.current_price == 78821.4


def test_sql_lake_fills_volume_buy_price_and_rejection():
    class FakeLake:
        def avg_volume_per_day(self, row, now):
            return 55.0

        def avg_buy_price(self, row, now):
            return 109250.5

        def liquidity_rejection_pct(self, row, now):
            return 1.25

    listing = datetime(2026, 7, 15, 14, 0, tzinfo=IST)
    now = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
    row = SpotRow(row_number=2, token="BTCUSDT", listing_at=listing)
    update = _job(volume_source="sql", buy="sql", rej="sql", lake=FakeLake()).run(
        [row], now=now
    )[0]
    assert update.avg_volume_per_day == 55.0
    assert update.avg_buy_price == 109250.5
    assert update.liquidity_rejection_pct == 1.25


def test_unknown_token_notes_and_skips_price():
    listing = datetime(2026, 7, 15, 14, 0, tzinfo=IST)
    now = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
    row = SpotRow(row_number=2, token="NOTAREALCOINUSDT", listing_at=listing)
    update = _job().run([row], now=now)[0]
    assert update.current_price is None
    assert any("not found" in note for note in update.notes)


def test_missing_listing_datetime_is_skipped():
    row = SpotRow(row_number=2, token="BTCUSDT", listing_at=None)
    update = _job().run([row], now=datetime(2026, 8, 27, tzinfo=IST))[0]
    assert update.current_price is None
    assert "missing listing datetime" in update.notes
