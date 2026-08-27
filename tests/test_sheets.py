from listing_metrics.models import SPOT_HEADERS, SpotUpdate
from listing_metrics.sheets import apply_updates, parse_spot_rows


def test_parse_spot_rows_skips_blank_and_keeps_operator_inputs():
    values = [
        SPOT_HEADERS,
        ["BTCUSDT", "", "", "", "", "15/07/2026 14:00", ""],
        ["", "", "", "", "", "", ""],
        ["ETHUSDT", "1", "2", "3", "4", "01/08/2026 10:30", "5"],
    ]
    columns, rows = parse_spot_rows(values)
    assert columns.token == 0
    assert columns.listing_at == 5
    assert [row.token for row in rows] == ["BTCUSDT", "ETHUSDT"]
    assert rows[0].row_number == 2
    assert rows[1].row_number == 4
    assert rows[0].listing_at.hour == 14
    assert rows[1].avg_buy_price == 2


def test_apply_updates_never_overwrites_token_or_listing():
    values = [
        list(SPOT_HEADERS),
        ["BTCUSDT", "", "", "", "", "15/07/2026 14:00", ""],
    ]
    columns, _ = parse_spot_rows(values)
    updated = apply_updates(
        values,
        columns,
        [
            SpotUpdate(
                row_number=2,
                token="SHOULD_NOT_WRITE_TOKEN",
                avg_volume_per_day=10,
                avg_buy_price=20,
                current_price=30,
                liquidity_rejection_pct=1.5,
                days_since_listing=7,
                tracking_ready=True,
            )
        ],
    )
    assert updated[1][0] == "BTCUSDT"
    assert updated[1][5] == "15/07/2026 14:00"
    assert updated[1][1] == 10
    assert updated[1][2] == 20
    assert updated[1][3] == 30
    assert updated[1][4] == 1.5
    assert updated[1][6] == 7


def test_unready_rows_clear_query_backed_columns():
    values = [
        list(SPOT_HEADERS),
        ["BTCUSDT", "old-vol", "2", "", "old-rej", "15/07/2026 14:00", ""],
    ]
    columns, _ = parse_spot_rows(values)
    updated = apply_updates(
        values,
        columns,
        [
            SpotUpdate(
                row_number=2,
                token="BTCUSDT",
                current_price=30,
                days_since_listing=0.5,
                tracking_ready=False,
            )
        ],
    )
    assert updated[1][0] == "BTCUSDT"
    assert updated[1][1] == ""
    assert updated[1][2] == ""
    assert updated[1][3] == 30
    assert updated[1][4] == ""
    assert updated[1][5] == "15/07/2026 14:00"
