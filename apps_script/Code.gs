/**
 * SPOT listing metrics — paste into Extensions > Apps Script on the
 * "New Listing metrics" spreadsheet and set a daily time-driven trigger.
 *
 * You type Token (pair) in column A and listing date/time in column F.
 * This script fills Current Price (CoinDCX) and days since listing.
 * Volume, avg buy price, and rejection % stay empty until the Python job
 * is connected to the warehouse queries.
 */
const SPOT_TAB = "SPOT";
const TICKER_URL = "https://api.coindcx.com/exchange/ticker";
const TRACKING_DELAY_HOURS = 24;

function updateSpotListingMetrics() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SPOT_TAB);
  if (!sheet) {
    throw new Error("Missing SPOT tab");
  }
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return;
  }
  const tickers = fetchTickers_();
  const now = new Date();
  for (let i = 1; i < values.length; i++) {
    const token = String(values[i][0] || "").trim();
    const listing = values[i][5];
    if (!token || !listing) {
      continue;
    }
    const listingDate = listing instanceof Date ? listing : new Date(listing);
    if (isNaN(listingDate.getTime())) {
      continue;
    }
    const market = normalize_(token);
    const ticker = tickers[market];
    if (ticker && ticker.last_price) {
      sheet.getRange(i + 1, 4).setValue(Number(ticker.last_price));
    }
    const days = (now.getTime() - listingDate.getTime()) / 86400000;
    sheet.getRange(i + 1, 7).setValue(Math.round(days * 10000) / 10000);
    const readyAt = new Date(listingDate.getTime() + TRACKING_DELAY_HOURS * 3600 * 1000);
    if (now < readyAt) {
      sheet.getRange(i + 1, 2).clearContent();
      sheet.getRange(i + 1, 3).clearContent();
      sheet.getRange(i + 1, 5).clearContent();
    }
  }
}

function fetchTickers_() {
  const response = UrlFetchApp.fetch(TICKER_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error("CoinDCX ticker HTTP " + response.getResponseCode());
  }
  const rows = JSON.parse(response.getContentText());
  const byMarket = {};
  rows.forEach(function (row) {
    byMarket[normalize_(row.market)] = row;
  });
  return byMarket;
}

function normalize_(token) {
  return String(token || "").toUpperCase().replace(/[\s/_-]+/g, "");
}
