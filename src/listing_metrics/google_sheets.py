from __future__ import annotations

from typing import Any

from listing_metrics.config import Settings


class GoogleSheetStore:
    """Reads/writes the SPOT tab. Requires gspread + a service account."""

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self.settings = settings
        self._client = client

    def _worksheet(self):
        if self._client is None:
            try:
                import gspread
                from google.oauth2.service_account import Credentials
            except ImportError as exc:
                raise RuntimeError(
                    "Install extra deps: pip install 'listing-metrics[sheets]'"
                ) from exc
            scopes = [
                "https://www.googleapis.com/auth/spreadsheets",
                "https://www.googleapis.com/auth/drive.readonly",
            ]
            creds = Credentials.from_service_account_file(
                _service_account_file(), scopes=scopes
            )
            self._client = gspread.authorize(creds)
        sheet = self._client.open_by_key(self.settings.spreadsheet_id)
        return sheet.worksheet(self.settings.spot_tab)

    def read(self) -> list[list[object]]:
        return self._worksheet().get_all_values()

    def write(self, values: list[list[object]]) -> None:
        worksheet = self._worksheet()
        if not values:
            return
        end_col = _column_letter(max(len(row) for row in values))
        end_row = len(values)
        worksheet.update(f"A1:{end_col}{end_row}", values, value_input_option="USER_ENTERED")


def _service_account_file() -> str:
    import os
    from pathlib import Path

    path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get(
        "GOOGLE_SERVICE_ACCOUNT_FILE"
    )
    if not path:
        raise RuntimeError(
            "Set GOOGLE_APPLICATION_CREDENTIALS to the service-account JSON path"
        )
    if not Path(path).exists():
        raise RuntimeError(f"Service account file not found: {path}")
    return path


def _column_letter(index: int) -> str:
    # 1-based A, B, C...
    result = ""
    n = index
    while n:
        n, rem = divmod(n - 1, 26)
        result = chr(65 + rem) + result
    return result or "A"
