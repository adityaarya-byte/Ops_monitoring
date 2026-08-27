from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from listing_metrics.lake import CsvQueryExecutor, RenderedSqlSource, query_params, render_sql
from listing_metrics.models import SpotRow

IST = ZoneInfo("Asia/Kolkata")


def test_render_sql_injects_placeholders():
    row = SpotRow(
        row_number=2,
        token="BTCUSDT",
        listing_at=datetime(2026, 7, 15, 14, 0, tzinfo=IST),
    )
    now = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
    params = query_params(row, now, delay_hours=24, window_hours=24)
    sql = render_sql(
        "SELECT * FROM t WHERE market = '{{token}}' AND ts >= '{{tracking_start}}'",
        params,
    )
    assert "BTCUSDT" in sql
    assert "2026-07-16T14:00:00+05:30" in sql


def test_csv_executor_reads_sample_volume_file(tmp_path: Path):
    path = tmp_path / "spot_volume_daily.csv"
    path.write_text("token,avg_volume_per_day\nBTCUSDT,42.5\n", encoding="utf-8")
    source = RenderedSqlSource(
        executor=CsvQueryExecutor(tmp_path),
        volume_sql="SELECT avg_volume_per_day FROM spot_volume_daily",
        buy_price_sql=None,
        rejection_sql=None,
    )
    row = SpotRow(
        row_number=2,
        token="BTCUSDT",
        listing_at=datetime(2026, 7, 15, 14, 0, tzinfo=IST),
    )
    now = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
    assert source.avg_volume_per_day(row, now) == 42.5
    assert source.avg_buy_price(row, now) is None
