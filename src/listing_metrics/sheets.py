from __future__ import annotations

import csv
from pathlib import Path
from typing import Sequence

from listing_metrics.models import (
    BUY_PRICE_HEADER_ALIASES,
    DAYS_HEADER_ALIASES,
    LISTING_HEADER_ALIASES,
    PRICE_HEADER_ALIASES,
    REJECTION_HEADER_ALIASES,
    SPOT_HEADERS,
    TOKEN_HEADER_ALIASES,
    VOLUME_HEADER_ALIASES,
    SpotRow,
    SpotUpdate,
)
from listing_metrics.timeutil import parse_listing_datetime


class SheetColumns:
    def __init__(self, headers: Sequence[str] | None = None) -> None:
        self.headers = list(headers) if headers else list(SPOT_HEADERS)
        self.token = _find(self.headers, TOKEN_HEADER_ALIASES, 0)
        self.avg_volume = _find(self.headers, VOLUME_HEADER_ALIASES, 1)
        self.avg_buy_price = _find(self.headers, BUY_PRICE_HEADER_ALIASES, 2)
        self.current_price = _find(self.headers, PRICE_HEADER_ALIASES, 3)
        self.rejection = _find(self.headers, REJECTION_HEADER_ALIASES, 4)
        self.listing_at = _find(self.headers, LISTING_HEADER_ALIASES, 5)
        self.days = _find(self.headers, DAYS_HEADER_ALIASES, 6)


def parse_spot_rows(
    values: Sequence[Sequence[object]],
    tz_name: str = "Asia/Kolkata",
    has_header: bool = True,
) -> tuple[SheetColumns, list[SpotRow]]:
    if not values:
        return SheetColumns(), []
    if has_header:
        headers = [str(v) for v in values[0]]
        data_rows = values[1:]
        start_number = 2
    else:
        headers = list(SPOT_HEADERS)
        data_rows = values
        start_number = 1
    columns = SheetColumns(headers)
    rows: list[SpotRow] = []
    for offset, raw in enumerate(data_rows):
        token = _cell(raw, columns.token).strip()
        listing_raw = _cell(raw, columns.listing_at).strip()
        if not token and not listing_raw:
            continue
        listing_at = None
        skip_reason = None
        if listing_raw:
            try:
                listing_at = parse_listing_datetime(listing_raw, tz_name)
            except ValueError as exc:
                skip_reason = str(exc)
        rows.append(
            SpotRow(
                row_number=start_number + offset,
                token=token,
                listing_at=listing_at,
                listing_raw=listing_raw,
                avg_volume_per_day=_to_float(_cell(raw, columns.avg_volume)),
                avg_buy_price=_to_float(_cell(raw, columns.avg_buy_price)),
                current_price=_to_float(_cell(raw, columns.current_price)),
                liquidity_rejection_pct=_to_float(_cell(raw, columns.rejection)),
                days_since_listing=_to_float(_cell(raw, columns.days)),
                skip_reason=skip_reason,
            )
        )
    return columns, rows


def apply_updates(
    values: list[list[object]],
    columns: SheetColumns,
    updates: Sequence[SpotUpdate],
    has_header: bool = True,
) -> list[list[object]]:
    """Write computed fields only. Token and listing datetime stay untouched."""
    grid = [list(row) for row in values]
    width = max(len(columns.headers), max((len(r) for r in grid), default=0), 7)
    for row in grid:
        while len(row) < width:
            row.append("")
    by_row = {u.row_number: u for u in updates}
    start = 1 if has_header else 0
    for idx in range(start, len(grid)):
        row_number = idx + 1
        update = by_row.get(row_number)
        if not update:
            continue
        clear_unready = not update.tracking_ready
        _set(grid[idx], columns.avg_volume, update.avg_volume_per_day, clear_if_none=clear_unready)
        _set(grid[idx], columns.avg_buy_price, update.avg_buy_price, clear_if_none=clear_unready)
        _set(grid[idx], columns.current_price, update.current_price)
        _set(grid[idx], columns.rejection, update.liquidity_rejection_pct, clear_if_none=clear_unready)
        _set(grid[idx], columns.days, update.days_since_listing)
    return grid


def read_csv_sheet(path: Path) -> list[list[object]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return [list(row) for row in csv.reader(handle)]


def write_csv_sheet(path: Path, values: Sequence[Sequence[object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        for row in values:
            writer.writerow(row)


def _find(headers: Sequence[str], aliases: set[str], default: int) -> int:
    for idx, header in enumerate(headers):
        if header.strip().lower() in aliases:
            return idx
    return default


def _cell(row: Sequence[object], idx: int) -> str:
    if idx >= len(row) or row[idx] is None:
        return ""
    return str(row[idx])


def _to_float(value: str) -> float | None:
    text = value.strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _set(row: list[object], idx: int, value: float | None, clear_if_none: bool = False) -> None:
    if value is None:
        if clear_if_none:
            while len(row) <= idx:
                row.append("")
            row[idx] = ""
        return
    while len(row) <= idx:
        row.append("")
    if isinstance(value, float) and value.is_integer():
        row[idx] = int(value)
    else:
        row[idx] = value
