#!/usr/bin/env python3
"""Scrape Binance TradFi Futures VIP fee tiers with Beautiful Soup.

The public fee page (https://www.binance.com/en/fee/tradFiFee) is a React app.
The VIP table is not in the first HTML response, so this scraper:

1. Fetches the fee page and parses it with Beautiful Soup (title, tabs,
   any rendered <table>, embedded __APP_DATA, frontend script URLs).
2. Loads the same public futures VIP API the page uses for 30-day volume
   and BNB balance gates.
3. Reads TradFi maker/taker rates from the fee-page JavaScript bundle
   (those promotional rates are hardcoded in the UI, not in the API).

If a saved/rendered HTML file already contains the table, Beautiful Soup
parses the rows directly and skips the API/JS overlay.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

DEFAULT_PAGE_URLS = (
    "https://www.binance.info/en/fee/tradFiFee",
    "https://www.binance.com/en/fee/tradFiFee",
)
FUTURES_TRADE_LEVEL_PATH = "/bapi/composite/v1/public/commission/futures-trade-level/get"
USER_AGENT = (
    "Mozilla/5.0 (compatible; OpsMonitoring TradFiFeeScraper/1.0; "
    "+https://github.com/adityaarya-byte/Ops_monitoring)"
)
REQUEST_TIMEOUT = 25
COLUMNS = (
    "level",
    "volume_30d_usd",
    "and_or",
    "bnb_balance",
    "maker",
    "taker",
    "taker_bnb_10_off",
)

# Last-known promotional TradFi rates from the fee UI / announcement.
# Used only if the live JS bundle cannot be parsed.
TRADFI_PROMO_FALLBACK: dict[int, dict[str, float]] = {
    0: {"maker": 0.0, "taker": 0.0004, "taker_bnb": 0.00036},
    1: {"maker": 0.0, "taker": 0.0004, "taker_bnb": 0.00036},
    2: {"maker": 0.0, "taker": 0.00032, "taker_bnb": 0.000288},
    3: {"maker": 0.0, "taker": 0.000256, "taker_bnb": 0.00023},
    4: {"maker": 0.0, "taker": 0.00015, "taker_bnb": 0.000135},
    5: {"maker": 0.0, "taker": 0.000135, "taker_bnb": 0.000122},
    6: {"maker": 0.0, "taker": 0.000125, "taker_bnb": 0.000113},
    7: {"maker": 0.0, "taker": 0.00011, "taker_bnb": 0.000099},
    8: {"maker": 0.0, "taker": 0.0001, "taker_bnb": 0.00009},
    9: {"maker": 0.0, "taker": 0.000085, "taker_bnb": 0.000077},
}

JS_FEE_MAP_RE = re.compile(
    r"\{(?:\s*\d+\s*:\s*\{"
    r"makerCommission\s*:\s*[\d.eE+-]+\s*,\s*"
    r"takerCommission\s*:\s*[\d.eE+-]+\s*,\s*"
    r"takerCommissionBnb\s*:\s*[\d.eE+-]+\s*"
    r"\}\s*,?)+\}"
)
JS_TIER_RE = re.compile(
    r"(?P<level>\d+)\s*:\s*\{"
    r"makerCommission\s*:\s*(?P<maker>[\d.eE+-]+)\s*,\s*"
    r"takerCommission\s*:\s*(?P<taker>[\d.eE+-]+)\s*,\s*"
    r"takerCommissionBnb\s*:\s*(?P<taker_bnb>[\d.eE+-]+)"
)


@dataclass(frozen=True)
class FeeRow:
    level: str
    volume_30d_usd: str
    and_or: str
    bnb_balance: str
    maker: str
    taker: str
    taker_bnb_10_off: str


@dataclass(frozen=True)
class FeeSchedule:
    source: str
    page_url: str
    rows: tuple[FeeRow, ...]
    title: str = "TradFi Futures Trading Fee Rate"


class ScrapeError(RuntimeError):
    """Raised when the fee page or supporting APIs cannot be scraped."""


def format_pct(rate: float) -> str:
    return f"{rate * 100:.4f}%"


def format_amount(value: float) -> str:
    if float(value).is_integer():
        return f"{int(value):,}"
    text = f"{value:,.10f}".rstrip("0").rstrip(".")
    return text


def level_label(level: int) -> str:
    return "Regular User" if level == 0 else f"VIP {level}"


def format_volume(level: int, floor: float, ceil: float) -> str:
    if level == 0:
        return f"< {format_amount(ceil)} USD"
    return f"≥ {format_amount(floor)} USD"


def format_bnb(floor: float) -> str:
    return f"≥ {format_amount(floor)} BNB"


def and_or_for_level(level: int) -> str:
    return "or" if level == 0 else "and"


def parse_tradfi_fee_map(javascript: str) -> dict[int, dict[str, float]]:
    """Extract the TradFi promotional maker/taker map from the fee UI bundle."""
    match = JS_FEE_MAP_RE.search(javascript)
    if not match:
        return {}
    fees: dict[int, dict[str, float]] = {}
    for tier in JS_TIER_RE.finditer(match.group(0)):
        fees[int(tier["level"])] = {
            "maker": float(tier["maker"]),
            "taker": float(tier["taker"]),
            "taker_bnb": float(tier["taker_bnb"]),
        }
    return fees


def _header_key(text: str) -> str | None:
    normalized = re.sub(r"\s+", " ", text).strip().lower()
    if not normalized:
        return None
    if normalized == "level" or normalized.startswith("level"):
        return "level"
    if "30d" in normalized and "volume" in normalized:
        return "volume_30d_usd"
    if normalized in {"and/or", "and / or"} or ("and" in normalized and "or" in normalized):
        return "and_or"
    if "bnb" in normalized and "balance" in normalized:
        return "bnb_balance"
    if "taker" in normalized and "bnb" in normalized:
        return "taker_bnb_10_off"
    if normalized == "taker" or normalized.startswith("taker"):
        return "taker"
    if normalized == "maker" or normalized.startswith("maker"):
        return "maker"
    return None


def parse_html_table(soup: BeautifulSoup) -> list[FeeRow]:
    """Parse a rendered TradFi fee <table> if the HTML already contains rows."""
    for table in soup.find_all("table"):
        header_cells = table.find_all("th")
        if not header_cells:
            first_row = table.find("tr")
            if first_row:
                header_cells = first_row.find_all(["th", "td"])
        keys = [_header_key(cell.get_text(" ", strip=True)) for cell in header_cells]
        if "level" not in keys or "maker" not in keys:
            continue
        rows: list[FeeRow] = []
        body_rows = table.find_all("tr")
        start = 1 if table.find("th") or (body_rows and _header_key(body_rows[0].get_text()) == "level") else 0
        for tr in body_rows[start:]:
            cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if len(cells) < 5:
                continue
            mapped: dict[str, str] = {}
            for key, value in zip(keys, cells):
                if key:
                    mapped[key] = value
            if not mapped.get("level"):
                continue
            rows.append(
                FeeRow(
                    level=mapped.get("level", ""),
                    volume_30d_usd=mapped.get("volume_30d_usd", ""),
                    and_or=mapped.get("and_or", ""),
                    bnb_balance=mapped.get("bnb_balance", ""),
                    maker=mapped.get("maker", ""),
                    taker=mapped.get("taker", ""),
                    taker_bnb_10_off=mapped.get("taker_bnb_10_off", ""),
                )
            )
        if rows:
            return rows
    return []


def parse_app_data(soup: BeautifulSoup) -> dict[str, Any]:
    tag = soup.find("script", id="__APP_DATA")
    if not tag or not tag.string:
        return {}
    try:
        payload = json.loads(tag.string)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def find_biz_fee_script(soup: BeautifulSoup, page_url: str) -> str | None:
    for script in soup.find_all("script", src=True):
        src = script["src"]
        if "biz-fee" in src:
            return urljoin(page_url, src)
    return None


def page_title(soup: BeautifulSoup, app_data: Mapping[str, Any]) -> str:
    title_tag = soup.find("title")
    if title_tag and title_tag.get_text(strip=True):
        return title_tag.get_text(strip=True)
    try:
        i18n = app_data["pageData"]["i18nResource"]["en"]["exchange-fee-page-ui"]
        return str(i18n["exchange-tradfi-future-fee-title"])
    except (KeyError, TypeError):
        return "TradFi Futures Trading Fee Rate"


def merge_levels_with_fees(
    levels: Sequence[Mapping[str, Any]],
    fee_map: Mapping[int, Mapping[str, float]],
) -> list[FeeRow]:
    rows: list[FeeRow] = []
    for item in levels:
        level = int(item["level"])
        fees = fee_map.get(level) or TRADFI_PROMO_FALLBACK.get(level)
        if not fees:
            continue
        rows.append(
            FeeRow(
                level=level_label(level),
                volume_30d_usd=format_volume(
                    level,
                    float(item.get("btcBusdFloor") or 0),
                    float(item.get("btcBusdCeil") or 0),
                ),
                and_or=and_or_for_level(level),
                bnb_balance=format_bnb(float(item.get("bnbFloor") or 0)),
                maker=format_pct(float(fees["maker"])),
                taker=format_pct(float(fees["taker"])),
                taker_bnb_10_off=format_pct(float(fees["taker_bnb"])),
            )
        )
    return rows


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
    )
    return session


def _get(session: requests.Session, url: str, timeout: float) -> requests.Response:
    response = session.get(url, timeout=timeout)
    response.raise_for_status()
    return response


def fetch_first_ok(
    session: requests.Session,
    urls: Iterable[str],
    timeout: float,
) -> tuple[str, requests.Response]:
    errors: list[str] = []
    for url in urls:
        try:
            return url, _get(session, url, timeout)
        except requests.RequestException as exc:
            errors.append(f"{url}: {exc}")
    raise ScrapeError("All fetch attempts failed:\n" + "\n".join(errors))


def futures_trade_level_urls(page_url: str) -> list[str]:
    parsed = urlsplit(page_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    hosts = [origin, "https://www.binance.info", "https://www.binance.com"]
    seen: set[str] = set()
    urls: list[str] = []
    for host in hosts:
        candidate = host.rstrip("/") + FUTURES_TRADE_LEVEL_PATH
        if candidate not in seen:
            seen.add(candidate)
            urls.append(candidate)
    return urls


def scrape_tradfi_fees(
    page_url: str | None = None,
    timeout: float = REQUEST_TIMEOUT,
    session: requests.Session | None = None,
) -> FeeSchedule:
    """Scrape TradFi Futures VIP fee tiers from the public Binance fee page."""
    own_session = session is None
    session = session or _session()
    try:
        page_urls = (page_url,) if page_url else DEFAULT_PAGE_URLS
        used_url, page_response = fetch_first_ok(session, page_urls, timeout)
        soup = BeautifulSoup(page_response.text, "html.parser")
        app_data = parse_app_data(soup)
        title = page_title(soup, app_data)

        html_rows = parse_html_table(soup)
        if len(html_rows) >= 10:
            return FeeSchedule(
                source="html-table",
                page_url=used_url,
                rows=tuple(html_rows),
                title=title,
            )

        _, levels_response = fetch_first_ok(
            session, futures_trade_level_urls(used_url), timeout
        )
        payload = levels_response.json()
        levels = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(levels, list) or not levels:
            raise ScrapeError(f"Unexpected trade-level payload from {levels_response.url}")

        fee_map: dict[int, dict[str, float]] = {}
        js_url = find_biz_fee_script(soup, used_url)
        fee_source = "fallback-promo-rates"
        if js_url:
            js_text = _get(session, js_url, timeout).text
            fee_map = parse_tradfi_fee_map(js_text)
            if fee_map:
                fee_source = "js-bundle"
        if not fee_map:
            fee_map = TRADFI_PROMO_FALLBACK

        rows = merge_levels_with_fees(levels, fee_map)
        if not rows:
            raise ScrapeError("No TradFi fee rows could be built from API + fee map")
        return FeeSchedule(
            source=f"api+{fee_source}",
            page_url=used_url,
            rows=tuple(rows),
            title=title,
        )
    except requests.RequestException as exc:
        raise ScrapeError(str(exc)) from exc
    finally:
        if own_session:
            session.close()


def schedule_as_dicts(schedule: FeeSchedule) -> list[dict[str, str]]:
    return [asdict(row) for row in schedule.rows]


def render_table(schedule: FeeSchedule) -> str:
    headers = [
        "Level",
        "30D Trade Volume (USD)",
        "and/or",
        "BNB Balance",
        "Maker",
        "Taker",
        "Taker (BNB 10% off)",
    ]
    records = [
        [
            row.level,
            row.volume_30d_usd,
            row.and_or,
            row.bnb_balance,
            row.maker,
            row.taker,
            row.taker_bnb_10_off,
        ]
        for row in schedule.rows
    ]
    widths = [len(h) for h in headers]
    for record in records:
        for i, cell in enumerate(record):
            widths[i] = max(widths[i], len(cell))

    def fmt(cells: Sequence[str]) -> str:
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    lines = [
        f"{schedule.title}",
        f"Source: {schedule.source}",
        f"Page:   {schedule.page_url}",
        "",
        fmt(headers),
        "  ".join("-" * w for w in widths),
    ]
    lines.extend(fmt(record) for record in records)
    return "\n".join(lines) + "\n"


def write_csv(schedule: FeeSchedule, handle) -> None:
    writer = csv.DictWriter(handle, fieldnames=list(COLUMNS))
    writer.writeheader()
    writer.writerows(schedule_as_dicts(schedule))


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scrape Binance TradFi Futures VIP fee tiers with Beautiful Soup."
    )
    parser.add_argument(
        "--url",
        help="Fee page URL (default: try binance.info then binance.com).",
    )
    parser.add_argument(
        "--format",
        choices=("table", "json", "csv"),
        default="table",
        help="Output format (default: table).",
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Write output to this file instead of stdout.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=REQUEST_TIMEOUT,
        help="HTTP timeout in seconds.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        schedule = scrape_tradfi_fees(page_url=args.url, timeout=args.timeout)
    except ScrapeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.format == "json":
        payload = {
            "title": schedule.title,
            "source": schedule.source,
            "page_url": schedule.page_url,
            "rows": schedule_as_dicts(schedule),
        }
        text = json.dumps(payload, indent=2) + "\n"
    elif args.format == "csv":
        from io import StringIO

        buf = StringIO()
        write_csv(schedule, buf)
        text = buf.getvalue()
    else:
        text = render_table(schedule)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
