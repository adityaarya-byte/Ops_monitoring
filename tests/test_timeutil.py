from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from listing_metrics.timeutil import (
    days_since_listing,
    is_tracking_ready,
    parse_listing_datetime,
    tracking_start,
)


IST = ZoneInfo("Asia/Kolkata")


def test_parse_date_only_is_midnight_ist():
    parsed = parse_listing_datetime("15/07/2026")
    assert parsed == datetime(2026, 7, 15, 0, 0, tzinfo=IST)


def test_parse_date_and_time_ist():
    parsed = parse_listing_datetime("15/07/2026 14:00")
    assert parsed == datetime(2026, 7, 15, 14, 0, tzinfo=IST)


def test_parse_iso_naive_is_ist():
    parsed = parse_listing_datetime("2026-07-15T14:00:00")
    assert parsed == datetime(2026, 7, 15, 14, 0, tzinfo=IST)


def test_tracking_starts_24h_after_listing_time():
    listing = parse_listing_datetime("15/07/2026 14:00")
    start = tracking_start(listing, 24)
    assert start == datetime(2026, 7, 16, 14, 0, tzinfo=IST)
    now_before = datetime(2026, 7, 16, 13, 59, tzinfo=IST)
    now_after = datetime(2026, 7, 16, 14, 0, tzinfo=IST)
    assert is_tracking_ready(listing, now_before) is False
    assert is_tracking_ready(listing, now_after) is True


def test_days_since_listing():
    listing = datetime(2026, 8, 20, 10, 0, tzinfo=IST)
    now = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
    assert days_since_listing(listing, now) == 7.0


def test_bad_datetime_raises():
    with pytest.raises(ValueError):
        parse_listing_datetime("July 15")
