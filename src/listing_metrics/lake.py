from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from listing_metrics.models import SpotRow
from listing_metrics.timeutil import rolling_window, tracking_start

_SAFE_TOKEN = re.compile(r"^[A-Z0-9._-]+$")
_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


class QueryExecutor(Protocol):
    def fetch_one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None: ...


class MetricSource(Protocol):
    def avg_volume_per_day(self, row: SpotRow, now) -> float | None: ...

    def avg_buy_price(self, row: SpotRow, now) -> float | None: ...

    def liquidity_rejection_pct(self, row: SpotRow, now) -> float | None: ...


@dataclass
class NullMetricSource:
    reason: str = "source not configured"

    def avg_volume_per_day(self, row: SpotRow, now) -> float | None:
        return None

    def avg_buy_price(self, row: SpotRow, now) -> float | None:
        return None

    def liquidity_rejection_pct(self, row: SpotRow, now) -> float | None:
        return None


class RenderedSqlSource:
    """Runs the operator-supplied SQL templates in queries/."""

    def __init__(
        self,
        executor: QueryExecutor,
        volume_sql: str | None = None,
        buy_price_sql: str | None = None,
        rejection_sql: str | None = None,
        delay_hours: int = 24,
        window_hours: int = 24,
    ) -> None:
        self.executor = executor
        self.volume_sql = volume_sql
        self.buy_price_sql = buy_price_sql
        self.rejection_sql = rejection_sql
        self.delay_hours = delay_hours
        self.window_hours = window_hours

    def avg_volume_per_day(self, row: SpotRow, now) -> float | None:
        return self._run(self.volume_sql, row, now, ("avg_volume_per_day", "avg_volume", "volume"))

    def avg_buy_price(self, row: SpotRow, now) -> float | None:
        return self._run(self.buy_price_sql, row, now, ("avg_buy_price", "avg_price", "price"))

    def liquidity_rejection_pct(self, row: SpotRow, now) -> float | None:
        return self._run(
            self.rejection_sql,
            row,
            now,
            ("liquidity_rejection_pct", "rejection_pct", "pct"),
        )

    def _run(self, sql: str | None, row: SpotRow, now, keys: tuple[str, ...]) -> float | None:
        if not sql or not row.listing_at:
            return None
        params = query_params(row, now, self.delay_hours, self.window_hours)
        rendered = render_sql(sql, params)
        result = self.executor.fetch_one(rendered, params)
        if not result:
            return None
        lowered = {str(k).lower(): v for k, v in result.items()}
        for key in keys:
            if key in lowered and lowered[key] not in (None, ""):
                return float(lowered[key])
        # single-column result
        if len(result) == 1:
            value = next(iter(result.values()))
            return None if value in (None, "") else float(value)
        return None


class CsvQueryExecutor:
    """Tiny stand-in so queries can be developed against local CSVs before the lake is wired."""

    def __init__(self, csv_dir: Path) -> None:
        self.csv_dir = csv_dir

    def fetch_one(self, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        table = _csv_table_name(sql)
        if not table:
            return None
        path = self.csv_dir / f"{table}.csv"
        if not path.exists():
            return None
        token = str(params.get("token") or "")
        with path.open(newline="", encoding="utf-8") as handle:
            for record in csv.DictReader(handle):
                record_token = str(record.get("token") or record.get("market") or "").strip()
                if record_token.upper() == token.upper():
                    return record
        return None


def query_params(row: SpotRow, now, delay_hours: int, window_hours: int) -> dict[str, Any]:
    if row.listing_at is None:
        raise ValueError("listing_at is required")
    window_start, window_end = rolling_window(now, window_hours)
    start = tracking_start(row.listing_at, delay_hours)
    return {
        "token": row.token,
        "market": row.coindcx_market or row.token,
        "listing_at": row.listing_at.isoformat(),
        "tracking_start": start.isoformat(),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "quote_currency": row.quote_currency or "",
    }


def render_sql(sql: str, params: dict[str, Any]) -> str:
    token = str(params.get("token") or "")
    if token and not _SAFE_TOKEN.match(token.replace("/", "").replace("-", "").upper()):
        # Allow the original token through only after a conservative check.
        compact = re.sub(r"[^A-Z0-9]", "", token.upper())
        if not compact:
            raise ValueError(f"Refusing to interpolate unsafe token {token!r}")

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in params:
            raise KeyError(f"Unknown SQL placeholder {key}")
        value = params[key]
        return str(value).replace("'", "''")

    return _PLACEHOLDER.sub(repl, sql)


def load_sql(path: Path) -> str | None:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    if not text or text.startswith("-- TODO"):
        # Still return it; the executor/tests decide. Empty files are skipped.
        pass
    return text or None


def _csv_table_name(sql: str) -> str | None:
    match = re.search(r"from\s+([A-Za-z0-9_.]+)", sql, flags=re.IGNORECASE)
    if not match:
        return None
    return match.group(1).split(".")[-1]
