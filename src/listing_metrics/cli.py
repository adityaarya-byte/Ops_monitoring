from __future__ import annotations

import argparse
import json
from pathlib import Path

from listing_metrics.coindcx import CoinDCXPublicClient
from listing_metrics.config import load_settings
from listing_metrics.lake import CsvQueryExecutor, NullMetricSource, RenderedSqlSource, load_sql
from listing_metrics.sheets import apply_updates, parse_spot_rows, read_csv_sheet, write_csv_sheet
from listing_metrics.spot_job import SpotJob
from listing_metrics.timeutil import utcnow


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fill SPOT listing metrics. You enter token + listing datetime; the job fills the rest."
    )
    parser.add_argument("--config", help="Path to config/settings.yaml")
    parser.add_argument(
        "--input-csv",
        help="Local CSV that mirrors the SPOT tab (for dry-run without Google credentials).",
    )
    parser.add_argument(
        "--output-csv",
        help="Where to write the updated SPOT snapshot. Defaults to --input-csv when set.",
    )
    parser.add_argument(
        "--sheet",
        action="store_true",
        help="Read/write the live Google Sheet (needs GOOGLE_APPLICATION_CREDENTIALS).",
    )
    parser.add_argument(
        "--print-json",
        action="store_true",
        help="Print computed updates as JSON.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings(args.config)
    values = _load_values(args, settings)
    columns, rows = parse_spot_rows(values, tz_name=settings.timezone)
    job = SpotJob(settings, coindcx=CoinDCXPublicClient(), lake=_lake(settings))
    updates = job.run(rows, now=utcnow())
    updated = apply_updates(values, columns, updates)

    if args.sheet:
        from listing_metrics.google_sheets import GoogleSheetStore

        GoogleSheetStore(settings).write(updated)
    else:
        output = Path(args.output_csv or args.input_csv or "data/spot_output.csv")
        write_csv_sheet(output, updated)

    if args.print_json or not args.sheet:
        print(json.dumps([u.as_public_dict() for u in updates], indent=2))
    return 0


def _load_values(args: argparse.Namespace, settings) -> list[list[object]]:
    if args.sheet:
        from listing_metrics.google_sheets import GoogleSheetStore

        return GoogleSheetStore(settings).read()
    if args.input_csv:
        return read_csv_sheet(Path(args.input_csv))
    default_input = settings.repo_root / "data" / "spot_input.csv"
    if default_input.exists():
        return read_csv_sheet(default_input)
    raise SystemExit("Provide --input-csv or --sheet")


def _lake(settings):
    sql_needed = {
        settings.avg_volume_source,
        settings.avg_buy_price_source,
        settings.liquidity_rejection_source,
    }
    if "sql" not in sql_needed:
        return NullMetricSource()
    if settings.sql_backend != "csv":
        raise SystemExit(
            f"SQL backend {settings.sql_backend!r} is not wired yet. "
            "Drop the query into queries/ and we will connect it to the lake next."
        )
    return RenderedSqlSource(
        executor=CsvQueryExecutor(settings.csv_dir),
        volume_sql=load_sql(settings.volume_query_path),
        buy_price_sql=load_sql(settings.buy_price_query_path),
        rejection_sql=load_sql(settings.rejection_query_path),
        delay_hours=settings.tracking_delay_hours,
        window_hours=settings.rolling_window_hours,
    )


if __name__ == "__main__":
    raise SystemExit(main())
