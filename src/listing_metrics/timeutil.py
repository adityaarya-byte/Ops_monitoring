from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from listing_metrics.models import SpotRow

_DATE_ONLY = re.compile(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$")
_DATE_TIME = re.compile(
    r"^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$"
)


def parse_listing_datetime(value: object, tz_name: str = "Asia/Kolkata") -> datetime | None:
    """Parse operator-entered listing date/time. Bare dates/times are IST."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=ZoneInfo(tz_name))
        return value.astimezone(ZoneInfo(tz_name))
    text = str(value).strip()
    if not text:
        return None

    tz = ZoneInfo(tz_name)
    iso_candidate = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(iso_candidate)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=tz)
        return parsed.astimezone(tz)
    except ValueError:
        pass

    match = _DATE_TIME.match(text) or _DATE_ONLY.match(text)
    if not match:
        raise ValueError(f"Unrecognised listing datetime: {text!r}")
    day, month, year, hour, minute, second = (match.groups() + (None, None, None))[:6]
    year_i = int(year)
    if year_i < 100:
        year_i += 2000
    return datetime(
        year_i,
        int(month),
        int(day),
        int(hour or 0),
        int(minute or 0),
        int(second or 0),
        tzinfo=tz,
    )


def tracking_start(listing_at: datetime, delay_hours: int = 24) -> datetime:
    return listing_at + timedelta(hours=delay_hours)


def is_tracking_ready(listing_at: datetime, now: datetime, delay_hours: int = 24) -> bool:
    return now >= tracking_start(listing_at, delay_hours)


def days_since_listing(listing_at: datetime, now: datetime) -> float:
    elapsed = now - listing_at
    return round(elapsed.total_seconds() / 86400, 4)


def complete_windows_since(
    listing_at: datetime,
    now: datetime,
    delay_hours: int = 24,
    window_hours: int = 24,
) -> int:
    """How many finished rolling windows exist after the tracking start."""
    start = tracking_start(listing_at, delay_hours)
    if now < start:
        return 0
    return int((now - start).total_seconds() // (window_hours * 3600))


def rolling_window(now: datetime, window_hours: int = 24) -> tuple[datetime, datetime]:
    return now - timedelta(hours=window_hours), now


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def annotate_row(row: SpotRow, now: datetime, delay_hours: int = 24) -> SpotRow:
    if not row.token:
        row.skip_reason = "missing token"
        return row
    if row.listing_at is None:
        row.skip_reason = "missing listing datetime"
        return row
    row.days_since_listing = days_since_listing(row.listing_at, now)
    row.tracking_ready = is_tracking_ready(row.listing_at, now, delay_hours)
    if not row.tracking_ready:
        row.notes.append(
            f"tracking starts at {tracking_start(row.listing_at, delay_hours).isoformat()}"
        )
    return row
