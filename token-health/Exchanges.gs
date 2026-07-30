/**
 * Parallel exchange fetches for KuCoin / Gate / Binance chain matrix.
 * Binance ticker is handled separately in Binance.gs (retry + fallbacks).
 */

function fetchExchangeSnapshots_(targetTokens) {
  var parallelRequests = [
    { url: CONFIG.BINANCE_CHAIN_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.KUCOIN_TICKER_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.KUCOIN_CHAIN_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.GATE_TICKER_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.GATE_CHAIN_URL, method: 'get', muteHttpExceptions: true }
  ];

  // Binance tickers first (dedicated reliable path), then other endpoints in parallel.
  var binanceTicker = fetchBinanceTickersReliable_();
  var responses = UrlFetchApp.fetchAll(parallelRequests);

  var kucoinVolMap = {};
  var gateVolMap = {};
  var kucoinListedSet = new Set();
  var gateListedSet = new Set();
  var masterChainMap = {};
  var kucoinGlobalStatus = {};

  // --- KuCoin tickers ---
  try {
    var kCode = responses[1].getResponseCode();
    if (kCode !== 200) {
      Logger.log('❌ KuCoin ticker HTTP ' + kCode);
    } else {
      var kJson = JSON.parse(responses[1].getContentText());
      if (kJson.data && kJson.data.ticker) {
        kJson.data.ticker.forEach(function (t) {
          var symSplit = String(t.symbol || '').toUpperCase().split('-');
          if (symSplit.length > 0 && symSplit[0]) {
            var tok = symSplit[0];
            kucoinListedSet.add(tok);
            if (String(t.symbol).toUpperCase().endsWith('-USDT')) {
              kucoinVolMap[tok] = parseFloat(t.volValue) || 0.0;
            }
          }
        });
      }
    }
  } catch (e) {
    Logger.log('❌ KuCoin ticker parse failed: ' + e);
  }

  // --- Gate tickers ---
  try {
    var gCode = responses[3].getResponseCode();
    if (gCode !== 200) {
      Logger.log('❌ Gate ticker HTTP ' + gCode);
    } else {
      var gJson = JSON.parse(responses[3].getContentText());
      if (Array.isArray(gJson)) {
        gJson.forEach(function (t) {
          var symSplit = String(t.currency_pair || '').toUpperCase().split('_');
          if (symSplit.length > 0 && symSplit[0]) {
            var tok = symSplit[0];
            gateListedSet.add(tok);
            if (String(t.currency_pair).toUpperCase().endsWith('_USDT')) {
              gateVolMap[tok] = parseFloat(t.quote_volume) || 0.0;
            }
          }
        });
      }
    }
  } catch (e) {
    Logger.log('❌ Gate ticker parse failed: ' + e);
  }

  function initTokenChain(token, chain) {
    var cleanChain = String(chain).trim().toUpperCase();
    if (!masterChainMap[token]) masterChainMap[token] = {};
    if (!masterChainMap[token][cleanChain]) {
      masterChainMap[token][cleanChain] = {
        binance_deposit: 'NO',
        binance_withdraw: 'NO',
        kucoin_deposit: 'NO',
        kucoin_withdraw: 'NO',
        gate_deposit: 'NO',
        gate_withdraw: 'NO'
      };
    }
    return masterChainMap[token][cleanChain];
  }

  // --- Binance chains ---
  try {
    var bChainCode = responses[0].getResponseCode();
    if (bChainCode !== 200) {
      Logger.log('❌ Binance chain HTTP ' + bChainCode);
    } else {
      var bChainJson = JSON.parse(responses[0].getContentText());
      if (bChainJson && bChainJson.data) {
        bChainJson.data.forEach(function (coin) {
          var token = String(coin.coin || '').toUpperCase();
          if (targetTokens.has(token) && coin.networkList) {
            coin.networkList.forEach(function (net) {
              var r = initTokenChain(token, net.network);
              r.binance_deposit = net.depositEnable ? 'Yes' : 'NO';
              r.binance_withdraw = net.withdrawEnable ? 'Yes' : 'NO';
            });
          }
        });
      }
    }
  } catch (e) {
    Logger.log('❌ Binance chain parse failed: ' + e);
  }

  // --- Gate chains ---
  try {
    var gChainCode = responses[4].getResponseCode();
    if (gChainCode !== 200) {
      Logger.log('❌ Gate chain HTTP ' + gChainCode);
    } else {
      var gChainJson = JSON.parse(responses[4].getContentText());
      if (Array.isArray(gChainJson)) {
        gChainJson.forEach(function (coin) {
          var token = String(coin.currency || '').toUpperCase();
          gateListedSet.add(token);
          if (targetTokens.has(token) && coin.chains) {
            coin.chains.forEach(function (c) {
              var r = initTokenChain(token, c.name);
              r.gate_deposit = !c.deposit_disabled ? 'Yes' : 'NO';
              r.gate_withdraw = !c.withdraw_disabled ? 'Yes' : 'NO';
            });
          }
        });
      }
    }
  } catch (e) {
    Logger.log('❌ Gate chain parse failed: ' + e);
  }

  // --- KuCoin chains / global status ---
  try {
    var kChainCode = responses[2].getResponseCode();
    if (kChainCode !== 200) {
      Logger.log('❌ KuCoin chain HTTP ' + kChainCode);
    } else {
      var kChainJson = JSON.parse(responses[2].getContentText());
      if (kChainJson && kChainJson.data) {
        kChainJson.data.forEach(function (coin) {
          var token = String(coin.currency || '').toUpperCase();
          kucoinListedSet.add(token);
          if (targetTokens.has(token)) {
            kucoinGlobalStatus[token] = {
              deposit: coin.isDepositEnabled ? 'Yes' : 'NO',
              withdraw: coin.isWithdrawEnabled ? 'Yes' : 'NO'
            };
          }
        });
      }
    }
  } catch (e) {
    Logger.log('❌ KuCoin chain parse failed: ' + e);
  }

  return {
    binanceOk: binanceTicker.ok,
    binanceError: binanceTicker.error,
    binanceVolMap: binanceTicker.volMap,
    binanceListedSet: binanceTicker.listedSet,
    kucoinVolMap: kucoinVolMap,
    gateVolMap: gateVolMap,
    kucoinListedSet: kucoinListedSet,
    gateListedSet: gateListedSet,
    masterChainMap: masterChainMap,
    kucoinGlobalStatus: kucoinGlobalStatus
  };
}

/**
 * Fetch CMC quotes for numeric ids (chunked).
 */
function fetchCmcQuotes_(validIds) {
  var cmcCoinData = {};
  var apiKey = getCmcApiKey_();
  if (!apiKey) {
    Logger.log('⚠️ CMC API key missing — skip quotes. Set Script Property CMC_API_KEY.');
    return cmcCoinData;
  }
  if (!validIds || validIds.length === 0) return cmcCoinData;

  var chunkSize = CONFIG.CMC_CHUNK_SIZE || 60;
  for (var i = 0; i < validIds.length; i += chunkSize) {
    var chunk = validIds.slice(i, i + chunkSize);
    var url = 'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=' +
      chunk.join(',') + '&convert=USD';
    try {
      var response = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' },
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      if (code !== 200) {
        Logger.log('❌ CMC HTTP ' + code + ' for chunk starting at ' + i);
      } else {
        var json = JSON.parse(response.getContentText());
        if (json.data) cmcCoinData = Object.assign(cmcCoinData, json.data);
      }
    } catch (e) {
      Logger.log('❌ CMC fetch failed: ' + e);
    }
    Utilities.sleep(CONFIG.CMC_SLEEP_MS || 100);
  }
  return cmcCoinData;
}
