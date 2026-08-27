from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "settings.yaml"


@dataclass(frozen=True)
class Settings:
    spreadsheet_id: str
    spot_tab: str
    timezone: str
    tracking_delay_hours: int
    rolling_window_hours: int
    current_price_source: str
    avg_volume_source: str
    avg_buy_price_source: str
    liquidity_rejection_source: str
    sql_backend: str
    queries_dir: Path
    csv_dir: Path
    repo_root: Path

    @property
    def volume_query_path(self) -> Path:
        return self.queries_dir / "spot_avg_volume.sql"

    @property
    def buy_price_query_path(self) -> Path:
        return self.queries_dir / "spot_avg_buy_price.sql"

    @property
    def rejection_query_path(self) -> Path:
        return self.queries_dir / "spot_liquidity_rejection.sql"


def load_settings(path: str | Path | None = None) -> Settings:
    config_path = Path(path) if path else DEFAULT_CONFIG_PATH
    raw: dict[str, Any] = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text()) or {}
        if not isinstance(loaded, dict):
            raise ValueError(f"Config at {config_path} must be a mapping")
        raw = loaded

    repo_root = config_path.resolve().parents[1] if config_path.exists() else Path.cwd()
    sources = raw.get("sources") or {}
    sql = raw.get("sql") or {}
    queries_dir = Path(sql.get("queries_dir") or "queries")
    csv_dir = Path(sql.get("csv_dir") or "data")
    if not queries_dir.is_absolute():
        queries_dir = repo_root / queries_dir
    if not csv_dir.is_absolute():
        csv_dir = repo_root / csv_dir

    return Settings(
        spreadsheet_id=str(raw.get("spreadsheet_id") or ""),
        spot_tab=str(raw.get("spot_tab") or "SPOT"),
        timezone=str(raw.get("timezone") or "Asia/Kolkata"),
        tracking_delay_hours=int(raw.get("tracking_delay_hours") or 24),
        rolling_window_hours=int(raw.get("rolling_window_hours") or 24),
        current_price_source=str(sources.get("current_price") or "coindcx"),
        avg_volume_source=str(sources.get("avg_volume") or "none"),
        avg_buy_price_source=str(sources.get("avg_buy_price") or "none"),
        liquidity_rejection_source=str(sources.get("liquidity_rejection") or "none"),
        sql_backend=str(sql.get("backend") or "csv"),
        queries_dir=queries_dir,
        csv_dir=csv_dir,
        repo_root=repo_root,
    )
