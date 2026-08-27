from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

TICKER_URL = "https://api.coindcx.com/exchange/ticker"
MARKETS_DETAILS_URL = "https://api.coindcx.com/exchange/v1/markets_details"

_SEPARATORS = re.compile(r"[\s/_-]+")


class CoinDCXError(RuntimeError):
    pass


@dataclass(frozen=True)
class SpotMarket:
    market: str
    pair: str
    last_price: float | None
    volume_24h: float | None
    quote_currency: str | None
    base_currency: str | None


def normalize_token(token: str) -> str:
    return _SEPARATORS.sub("", token.strip().upper())


def _request_json(url: str, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "ops-listing-metrics/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise CoinDCXError(f"Failed to fetch {url}: {exc}") from exc


class CoinDCXPublicClient:
    """Public CoinDCX spot market data (current price, optional 24h volume)."""

    def __init__(self, ticker_url: str = TICKER_URL, markets_url: str = MARKETS_DETAILS_URL):
        self.ticker_url = ticker_url
        self.markets_url = markets_url
        self._tickers: list[dict[str, Any]] | None = None
        self._markets: list[dict[str, Any]] | None = None

    def tickers(self) -> list[dict[str, Any]]:
        if self._tickers is None:
            payload = _request_json(self.ticker_url)
            if not isinstance(payload, list):
                raise CoinDCXError("Unexpected ticker payload")
            self._tickers = payload
        return self._tickers

    def markets_details(self) -> list[dict[str, Any]]:
        if self._markets is None:
            payload = _request_json(self.markets_url)
            if not isinstance(payload, list):
                raise CoinDCXError("Unexpected markets_details payload")
            self._markets = payload
        return self._markets

    def resolve_market(self, token: str) -> SpotMarket | None:
        wanted = normalize_token(token)
        if not wanted:
            return None

        details_by_name: dict[str, dict[str, Any]] = {}
        for item in self.markets_details():
            names = [
                item.get("coindcx_name"),
                item.get("symbol"),
                item.get("pair"),
            ]
            for name in names:
                if name:
                    details_by_name[normalize_token(str(name))] = item

        ticker_match: dict[str, Any] | None = None
        for ticker in self.tickers():
            market = str(ticker.get("market") or "")
            if normalize_token(market) == wanted:
                ticker_match = ticker
                break
        if ticker_match is None and wanted in details_by_name:
            detail = details_by_name[wanted]
            coindcx_name = str(detail.get("coindcx_name") or "")
            for ticker in self.tickers():
                if normalize_token(str(ticker.get("market") or "")) == normalize_token(coindcx_name):
                    ticker_match = ticker
                    break

        detail = details_by_name.get(wanted)
        if ticker_match is None and detail is None:
            return None

        market_name = str((ticker_match or {}).get("market") or (detail or {}).get("coindcx_name") or token)
        last_price = _to_float((ticker_match or {}).get("last_price"))
        volume = _to_float((ticker_match or {}).get("volume"))
        return SpotMarket(
            market=market_name,
            pair=str((detail or {}).get("pair") or market_name),
            last_price=last_price,
            volume_24h=volume,
            quote_currency=(detail or {}).get("base_currency_short_name"),
            base_currency=(detail or {}).get("target_currency_short_name"),
        )


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
