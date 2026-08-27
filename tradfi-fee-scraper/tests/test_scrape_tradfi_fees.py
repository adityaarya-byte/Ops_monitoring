#!/usr/bin/env python3
"""Unit tests for the TradFi Futures fee scraper."""

from __future__ import annotations

import json
import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import scrape_tradfi_fees as scraper

RENDERED_TABLE_HTML = """
<html>
  <head><title>TradFi Futures Trading Fee Rate</title></head>
  <body>
    <table>
      <thead>
        <tr>
          <th>Level</th>
          <th>30D Trade Volume (USD)</th>
          <th>and/or</th>
          <th>BNB Balance</th>
          <th>Maker</th>
          <th>Taker</th>
          <th>Taker (BNB 10% off)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Regular User</td>
          <td>&lt; 5,000,000 USD</td>
          <td>or</td>
          <td>≥ 0 BNB</td>
          <td>0.0000%</td>
          <td>0.0400%</td>
          <td>0.0360%</td>
        </tr>
        <tr>
          <td>VIP 1</td>
          <td>≥ 5,000,000 USD</td>
          <td>and</td>
          <td>≥ 5 BNB</td>
          <td>0.0000%</td>
          <td>0.0400%</td>
          <td>0.0360%</td>
        </tr>
        <tr>
          <td>VIP 2</td>
          <td>≥ 10,000,000 USD</td>
          <td>and</td>
          <td>≥ 25 BNB</td>
          <td>0.0000%</td>
          <td>0.0320%</td>
          <td>0.0288%</td>
        </tr>
        <tr>
          <td>VIP 3</td>
          <td>≥ 50,000,000 USD</td>
          <td>and</td>
          <td>≥ 100 BNB</td>
          <td>0.0000%</td>
          <td>0.0256%</td>
          <td>0.0230%</td>
        </tr>
        <tr>
          <td>VIP 4</td>
          <td>≥ 600,000,000 USD</td>
          <td>and</td>
          <td>≥ 500 BNB</td>
          <td>0.0000%</td>
          <td>0.0150%</td>
          <td>0.0135%</td>
        </tr>
        <tr>
          <td>VIP 5</td>
          <td>≥ 1,000,000,000 USD</td>
          <td>and</td>
          <td>≥ 1,000 BNB</td>
          <td>0.0000%</td>
          <td>0.0135%</td>
          <td>0.0122%</td>
        </tr>
        <tr>
          <td>VIP 6</td>
          <td>≥ 2,500,000,000 USD</td>
          <td>and</td>
          <td>≥ 1,750 BNB</td>
          <td>0.0000%</td>
          <td>0.0125%</td>
          <td>0.0113%</td>
        </tr>
        <tr>
          <td>VIP 7</td>
          <td>≥ 5,000,000,000 USD</td>
          <td>and</td>
          <td>≥ 3,000 BNB</td>
          <td>0.0000%</td>
          <td>0.0110%</td>
          <td>0.0099%</td>
        </tr>
        <tr>
          <td>VIP 8</td>
          <td>≥ 12,500,000,000 USD</td>
          <td>and</td>
          <td>≥ 4,500 BNB</td>
          <td>0.0000%</td>
          <td>0.0100%</td>
          <td>0.0090%</td>
        </tr>
        <tr>
          <td>VIP 9</td>
          <td>≥ 25,000,000,000 USD</td>
          <td>and</td>
          <td>≥ 5,500 BNB</td>
          <td>0.0000%</td>
          <td>0.0085%</td>
          <td>0.0077%</td>
        </tr>
      </tbody>
    </table>
  </body>
</html>
"""

SPA_HTML = """
<html>
  <head><title>TradFi Futures Trading Fee Rate</title></head>
  <body>
    <div class="subtitle4">TradFi Futures</div>
    <script id="__APP_DATA" type="application/json">{"pageData":{"ssrStore":{"activeKey":"tradFiFee"}}}</script>
    <script src="https://bin.bnbstatic.com/static/chunks/biz-fee.cf0e5e4d.js"></script>
  </body>
</html>
"""

BIZ_FEE_SNIPPET = (
    "var I={0:{makerCommission:0,takerCommission:4e-4,takerCommissionBnb:36e-5},"
    "1:{makerCommission:0,takerCommission:4e-4,takerCommissionBnb:36e-5},"
    "2:{makerCommission:0,takerCommission:32e-5,takerCommissionBnb:288e-6},"
    "3:{makerCommission:0,takerCommission:256e-6,takerCommissionBnb:23e-5},"
    "4:{makerCommission:0,takerCommission:15e-5,takerCommissionBnb:135e-6},"
    "5:{makerCommission:0,takerCommission:135e-6,takerCommissionBnb:122e-6},"
    "6:{makerCommission:0,takerCommission:125e-6,takerCommissionBnb:113e-6},"
    "7:{makerCommission:0,takerCommission:11e-5,takerCommissionBnb:99e-6},"
    "8:{makerCommission:0,takerCommission:1e-4,takerCommissionBnb:9e-5},"
    "9:{makerCommission:0,takerCommission:85e-6,takerCommissionBnb:77e-6}};"
)

FUTURES_LEVELS = {
    "code": "000000",
    "data": [
        {"level": 0, "bnbFloor": 0, "btcBusdFloor": 0, "btcBusdCeil": 5_000_000},
        {"level": 1, "bnbFloor": 5, "btcBusdFloor": 5_000_000, "btcBusdCeil": 10_000_000},
        {"level": 2, "bnbFloor": 25, "btcBusdFloor": 10_000_000, "btcBusdCeil": 50_000_000},
        {"level": 3, "bnbFloor": 100, "btcBusdFloor": 50_000_000, "btcBusdCeil": 600_000_000},
        {"level": 4, "bnbFloor": 500, "btcBusdFloor": 600_000_000, "btcBusdCeil": 1_000_000_000},
        {"level": 5, "bnbFloor": 1000, "btcBusdFloor": 1_000_000_000, "btcBusdCeil": 2_500_000_000},
        {"level": 6, "bnbFloor": 1750, "btcBusdFloor": 2_500_000_000, "btcBusdCeil": 5_000_000_000},
        {"level": 7, "bnbFloor": 3000, "btcBusdFloor": 5_000_000_000, "btcBusdCeil": 12_500_000_000},
        {"level": 8, "bnbFloor": 4500, "btcBusdFloor": 12_500_000_000, "btcBusdCeil": 25_000_000_000},
        {"level": 9, "bnbFloor": 5500, "btcBusdFloor": 25_000_000_000, "btcBusdCeil": 100_000_000_000_000},
    ],
}


class FakeResponse:
    def __init__(self, text="", json_data=None, url="https://example.test"):
        self.text = text
        self._json = json_data
        self.url = url

    def json(self):
        if self._json is None:
            return json.loads(self.text)
        return self._json

    def raise_for_status(self):
        return None


class ParseTests(unittest.TestCase):
    def test_parse_html_table_matches_screenshot(self):
        soup = BeautifulSoup(RENDERED_TABLE_HTML, "html.parser")
        rows = scraper.parse_html_table(soup)
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows[0].level, "Regular User")
        self.assertEqual(rows[0].volume_30d_usd, "< 5,000,000 USD")
        self.assertEqual(rows[0].and_or, "or")
        self.assertEqual(rows[0].maker, "0.0000%")
        self.assertEqual(rows[0].taker, "0.0400%")
        self.assertEqual(rows[0].taker_bnb_10_off, "0.0360%")
        self.assertEqual(rows[2].level, "VIP 2")
        self.assertEqual(rows[2].taker, "0.0320%")
        self.assertEqual(rows[2].taker_bnb_10_off, "0.0288%")
        self.assertEqual(rows[9].level, "VIP 9")
        self.assertEqual(rows[9].volume_30d_usd, "≥ 25,000,000,000 USD")
        self.assertEqual(rows[9].bnb_balance, "≥ 5,500 BNB")
        self.assertEqual(rows[9].taker, "0.0085%")
        self.assertEqual(rows[9].taker_bnb_10_off, "0.0077%")

    def test_parse_tradfi_fee_map_from_js(self):
        fees = scraper.parse_tradfi_fee_map(BIZ_FEE_SNIPPET)
        self.assertEqual(fees[0]["taker"], 0.0004)
        self.assertEqual(fees[2]["taker"], 0.00032)
        self.assertAlmostEqual(fees[3]["taker_bnb"], 0.00023)
        self.assertAlmostEqual(fees[9]["taker"], 0.000085)
        self.assertAlmostEqual(fees[9]["taker_bnb"], 0.000077)

    def test_find_biz_fee_script(self):
        soup = BeautifulSoup(SPA_HTML, "html.parser")
        url = scraper.find_biz_fee_script(soup, "https://www.binance.info/en/fee/tradFiFee")
        self.assertEqual(url, "https://bin.bnbstatic.com/static/chunks/biz-fee.cf0e5e4d.js")

    def test_merge_levels_with_fees(self):
        fee_map = scraper.parse_tradfi_fee_map(BIZ_FEE_SNIPPET)
        rows = scraper.merge_levels_with_fees(FUTURES_LEVELS["data"], fee_map)
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows[0].level, "Regular User")
        self.assertEqual(rows[0].volume_30d_usd, "< 5,000,000 USD")
        self.assertEqual(rows[0].and_or, "or")
        self.assertEqual(rows[0].bnb_balance, "≥ 0 BNB")
        self.assertEqual(rows[0].maker, "0.0000%")
        self.assertEqual(rows[0].taker, "0.0400%")
        self.assertEqual(rows[0].taker_bnb_10_off, "0.0360%")
        self.assertEqual(rows[1].and_or, "and")
        self.assertEqual(rows[1].volume_30d_usd, "≥ 5,000,000 USD")
        self.assertEqual(rows[4].taker, "0.0150%")
        self.assertEqual(rows[9].taker, "0.0085%")
        self.assertEqual(rows[9].taker_bnb_10_off, "0.0077%")

    def test_scrape_uses_html_table_when_present(self):
        class FakeSession:
            def get(self, url, timeout=None):
                return FakeResponse(RENDERED_TABLE_HTML, url=url)

            def close(self):
                return None

        schedule = scraper.scrape_tradfi_fees(
            page_url="https://www.binance.info/en/fee/tradFiFee",
            session=FakeSession(),
        )
        self.assertEqual(schedule.source, "html-table")
        self.assertEqual(len(schedule.rows), 10)
        self.assertEqual(schedule.rows[0].taker, "0.0400%")

    def test_scrape_spa_uses_api_and_js(self):
        class FakeSession:
            def get(self, url, timeout=None):
                if "tradFiFee" in url:
                    return FakeResponse(SPA_HTML, url=url)
                if "futures-trade-level" in url:
                    return FakeResponse(json_data=FUTURES_LEVELS, url=url)
                if "biz-fee" in url:
                    return FakeResponse(BIZ_FEE_SNIPPET, url=url)
                raise AssertionError(f"unexpected url {url}")

            def close(self):
                return None

        schedule = scraper.scrape_tradfi_fees(
            page_url="https://www.binance.info/en/fee/tradFiFee",
            session=FakeSession(),
        )
        self.assertEqual(schedule.source, "api+js-bundle")
        self.assertEqual(len(schedule.rows), 10)
        self.assertEqual(schedule.rows[2].taker, "0.0320%")
        self.assertIn("VIP 9", scraper.render_table(schedule))

    def test_cli_json(self):
        schedule = scraper.FeeSchedule(
            source="html-table",
            page_url="https://example.test",
            rows=(
                scraper.FeeRow(
                    "Regular User",
                    "< 5,000,000 USD",
                    "or",
                    "≥ 0 BNB",
                    "0.0000%",
                    "0.0400%",
                    "0.0360%",
                ),
            ),
        )
        buf = StringIO()
        with patch.object(scraper, "scrape_tradfi_fees", return_value=schedule):
            with patch("sys.stdout", buf):
                code = scraper.main(["--format", "json"])
        self.assertEqual(code, 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["rows"][0]["taker"], "0.0400%")


if __name__ == "__main__":
    unittest.main()
