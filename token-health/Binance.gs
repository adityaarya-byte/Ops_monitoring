/**
 * Reliable Binance market data helpers.
 *
 * Root cause of intermittent volume=0:
 * - UrlFetchApp occasionally gets 418/429/5xx or truncated/non-JSON bodies
 * - Previous code swallowed parse errors in empty catch blocks
 * - A failed ticker parse left binanceVolMap empty → every token wrote 0
 */

/**
 * Fetch Binance 24h tickers with retries across multiple hosts.
 * @returns {{ ok: boolean, volMap: Object, listedSet: Set, error: string }}
 */
function fetchBinanceTickersReliable_() {
  var volMap = {};
  var listedSet = new Set();
  var urls = CONFIG.BINANCE_TICKER_URLS;
  var maxAttempts = CONFIG.BINANCE_MAX_ATTEMPTS || 3;
  var sleepMs = CONFIG.BINANCE_RETRY_SLEEP_MS || 400;
  var lastError = '';

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var url = urls[attempt % urls.length];
    try {
      Logger.log('Binance ticker attempt ' + (attempt + 1) + '/' + maxAttempts + ' → ' + url);
      var response = UrlFetchApp.fetch(url, {
        method: 'get',
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: true
      });

      var code = response.getResponseCode();
      var text = response.getContentText() || '';

      if (code !== 200) {
        lastError = 'HTTP ' + code + ' from ' + url + ' (body preview: ' + text.substring(0, 160) + ')';
        Logger.log('❌ ' + lastError);
        Utilities.sleep(sleepMs * (attempt + 1));
        continue;
      }

      if (!text || text.charAt(0) !== '[') {
        lastError = 'Unexpected Binance ticker body (not a JSON array) from ' + url +
          ' (preview: ' + text.substring(0, 160) + ')';
        Logger.log('❌ ' + lastError);
        Utilities.sleep(sleepMs * (attempt + 1));
        continue;
      }

      var parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        lastError = 'Binance ticker JSON empty/non-array from ' + url;
        Logger.log('❌ ' + lastError);
        Utilities.sleep(sleepMs * (attempt + 1));
        continue;
      }

      var result = parseBinanceTickerArray_(parsed);
      if (result.listedCount === 0) {
        lastError = 'Parsed 0 listed symbols from ' + url;
        Logger.log('❌ ' + lastError);
        Utilities.sleep(sleepMs * (attempt + 1));
        continue;
      }

      Logger.log(
        '✅ Binance ticker OK via ' + url +
        ' — listed=' + result.listedCount +
        ', usdtVolumes=' + result.usdtVolumeCount
      );
      return {
        ok: true,
        volMap: result.volMap,
        listedSet: result.listedSet,
        error: ''
      };
    } catch (e) {
      lastError = 'Exception on ' + url + ': ' + (e && e.message ? e.message : e);
      Logger.log('❌ ' + lastError);
      Utilities.sleep(sleepMs * (attempt + 1));
    }
  }

  Logger.log('❌ Binance ticker exhausted all retries. Last error: ' + lastError);
  return { ok: false, volMap: volMap, listedSet: listedSet, error: lastError };
}

/**
 * Parse Binance /api/v3/ticker/24hr array into volume + listed maps.
 * Uses anchored suffix stripping so symbols like "BTCUSDT" → "BTC".
 */
function parseBinanceTickerArray_(tickers) {
  var volMap = {};
  var listedSet = new Set();
  var usdtVolumeCount = 0;

  // Prefer USDT quote volume; fall back to USDC / FDUSD if USDT missing.
  var quotePriority = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC'];

  tickers.forEach(function (x) {
    if (!x || !x.symbol) return;
    var symbol = String(x.symbol).toUpperCase();
    var match = symbol.match(/^(.+)(USDT|USDC|FDUSD|BUSD|TUSD|BTC)$/);
    if (!match) return;

    var base = match[1];
    var quote = match[2];
    if (!base) return;

    listedSet.add(base);

    var quoteVol = parseFloat(x.quoteVolume);
    if (isNaN(quoteVol)) quoteVol = 0;

    var existing = volMap[base];
    if (!existing) {
      volMap[base] = { volume: quoteVol, quote: quote };
      if (quote === 'USDT' && quoteVol > 0) usdtVolumeCount++;
      return;
    }

    var prevIdx = quotePriority.indexOf(existing.quote);
    var nextIdx = quotePriority.indexOf(quote);
    if (nextIdx !== -1 && (prevIdx === -1 || nextIdx < prevIdx)) {
      volMap[base] = { volume: quoteVol, quote: quote };
      if (quote === 'USDT' && quoteVol > 0) usdtVolumeCount++;
    }
  });

  // Flatten to token → number for callers
  var flatVol = {};
  Object.keys(volMap).forEach(function (tok) {
    flatVol[tok] = volMap[tok].volume || 0;
  });

  return {
    volMap: flatVol,
    listedSet: listedSet,
    listedCount: listedSet.size,
    usdtVolumeCount: usdtVolumeCount
  };
}

/**
 * Read previously written Binance volumes from HEALTH column F (index 6).
 * Used as a safety net when a live Binance ticker pull fails.
 * @returns {Object} token → volume
 */
function readPreviousBinanceVolumes_(healthSheet, tokenValues) {
  var previous = {};
  var lastRow = healthSheet.getLastRow();
  if (lastRow < 2 || !tokenValues || tokenValues.length === 0) return previous;

  try {
    var vols = healthSheet.getRange(2, 6, tokenValues.length, 1).getValues(); // Col F = Binance Vol
    for (var i = 0; i < tokenValues.length; i++) {
      var tok = tokenValues[i];
      if (!tok) continue;
      var v = vols[i][0];
      if (v !== '' && v !== null && !isNaN(v)) {
        previous[tok] = parseFloat(v);
      }
    }
  } catch (e) {
    Logger.log('⚠️ Could not snapshot previous Binance volumes: ' + e);
  }
  return previous;
}
