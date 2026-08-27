from listing_metrics.coindcx import CoinDCXPublicClient, normalize_token


class StaticClient(CoinDCXPublicClient):
    def tickers(self):
        return [
            {"market": "BTCUSDT", "last_price": "100.5", "volume": "10"},
            {"market": "SOLINR", "last_price": "14500", "volume": "20"},
        ]

    def markets_details(self):
        return [
            {
                "coindcx_name": "BTCUSDT",
                "symbol": "BTCUSDT",
                "pair": "B-BTC_USDT",
                "base_currency_short_name": "USDT",
                "target_currency_short_name": "BTC",
            },
            {
                "coindcx_name": "SOLINR",
                "symbol": "SOLINR",
                "pair": "I-SOL_INR",
                "base_currency_short_name": "INR",
                "target_currency_short_name": "SOL",
            },
        ]


def test_normalize_token_strips_separators():
    assert normalize_token("btc/usdt") == "BTCUSDT"
    assert normalize_token("BTC-USDT") == "BTCUSDT"
    assert normalize_token(" SOL INR ") == "SOLINR"


def test_resolve_market_matches_slash_pair_and_quote():
    client = StaticClient()
    btc = client.resolve_market("BTC/USDT")
    assert btc is not None
    assert btc.market == "BTCUSDT"
    assert btc.last_price == 100.5
    assert btc.quote_currency == "USDT"
    sol = client.resolve_market("SOLINR")
    assert sol is not None
    assert sol.last_price == 14500
    assert sol.quote_currency == "INR"


def test_unknown_market_returns_none():
    assert StaticClient().resolve_market("NOPEUSDT") is None
