from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


SPOT_HEADERS = [
    "Token (pair)",
    "Avg. Volume per day",
    "Avg buying price of user from lisitng(USDT/INR)",
    "Current Price",
    "% rejection due to Liquidity (CB)",
    "Date of lisitng",
    "days since listing",
]

TOKEN_HEADER_ALIASES = {"token", "token (pair)", "token(pair)", "pair", "market"}
VOLUME_HEADER_ALIASES = {"avg. volume per day", "avg volume per day", "avg volume per day(coindcx)"}
BUY_PRICE_HEADER_ALIASES = {
    "avg buying price of user from lisitng(usdt/inr)",
    "avg buying price of user from listing(usdt/inr)",
    "avg buying price",
}
PRICE_HEADER_ALIASES = {"current price", "ltp"}
REJECTION_HEADER_ALIASES = {
    "% rejection due to liquidity (cb)",
    "pct rejection due to liquidity (cb)",
    "rejection",
}
LISTING_HEADER_ALIASES = {
    "date of lisitng",
    "date of listing",
    "listing date",
    "listing datetime",
    "date and time of listing",
}
DAYS_HEADER_ALIASES = {"days since listing", "total days"}


@dataclass
class SpotRow:
    """One SPOT sheet row. Token + listing time are operator-owned inputs."""

    row_number: int
    token: str
    listing_at: datetime | None
    listing_raw: str = ""
    avg_volume_per_day: float | None = None
    avg_buy_price: float | None = None
    current_price: float | None = None
    liquidity_rejection_pct: float | None = None
    days_since_listing: float | None = None
    quote_currency: str | None = None
    coindcx_market: str | None = None
    tracking_ready: bool = False
    skip_reason: str | None = None
    notes: list[str] = field(default_factory=list)

    def is_actionable(self) -> bool:
        return bool(self.token) and self.listing_at is not None and not self.skip_reason


@dataclass
class SpotUpdate:
    """Values the job is allowed to write back. Never overwrites token or listing time."""

    row_number: int
    token: str
    avg_volume_per_day: float | None = None
    avg_buy_price: float | None = None
    current_price: float | None = None
    liquidity_rejection_pct: float | None = None
    days_since_listing: float | None = None
    tracking_ready: bool = False
    notes: list[str] = field(default_factory=list)

    def as_public_dict(self) -> dict[str, Any]:
        return {
            "row": self.row_number,
            "token": self.token,
            "avg_volume_per_day": self.avg_volume_per_day,
            "avg_buy_price": self.avg_buy_price,
            "current_price": self.current_price,
            "liquidity_rejection_pct": self.liquidity_rejection_pct,
            "days_since_listing": self.days_since_listing,
            "tracking_ready": self.tracking_ready,
            "notes": self.notes,
        }
