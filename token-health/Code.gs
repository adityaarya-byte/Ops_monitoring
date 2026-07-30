/**
 * Token Health — single-file Google Apps Script
 * Sheets required: HEALTH, CHAIN, ALERTS, Monitoring
 *
 * Binance volume fix:
 * - Retries across multiple hosts with HTTP/JSON validation
 * - Preserves previous HEALTH Binance volumes if live ticker pull fails
 *   (avoids wiping good data to 0 on flaky responses)
 */

var CONFIG = {
  CMC_API_KEY: '', // prefer Script Property CMC_API_KEY via setCmcApiKey()
  CMC_CHUNK_SIZE: 60,
  CMC_SLEEP_MS: 100,
  TIMEZONE: 'Asia/Kolkata',
  BINANCE_TICKER_URLS: [
    'https://data-api.binance.vision/api/v3/ticker/24hr',
    'https://api.binance.com/api/v3/ticker/24hr',
    'https://api1.binance.com/api/v3/ticker/24hr',
    'https://api2.binance.com/api/v3/ticker/24hr',
    'https://api3.binance.com/api/v3/ticker/24hr'
  ],
  BINANCE_CHAIN_URL: 'https://www.binance.com/bapi/capital/v2/public/capital/getNetworkCoinAll',
  KUCOIN_TICKER_URL: 'https://api.kucoin.com/api/v1/market/allTickers',
  KUCOIN_CHAIN_URL: 'https://api.kucoin.com/api/v1/currencies',
  GATE_TICKER_URL: 'https://api.gateio.ws/api/v4/spot/tickers',
  GATE_CHAIN_URL: 'https://api.gateio.ws/api/v4/spot/currencies',
  BINANCE_MAX_ATTEMPTS: 3,
  BINANCE_RETRY_SLEEP_MS: 400,
  ALERT_RECIPIENTS: [
    'aditya.arya@coindcx.com',
    'abdul.khan@coindcx.com',
    'akash.naidu@coindcx.com',
    'ayush.agarwal@coindcx.com',
    'chitresh.kashyap@coindcx.com',
    'cletus.dias@coindcx.com',
    'harsh.pandey@coindcx.com',
    'harshit.gupta@coindcx.com',
    'jatin.bisht@coindcx.com',
    'jayadrath.rondal@coindcx.com',
    'mihir.sutariya@coindcx.com',
    'mohit.mittal@coindcx.com',
    'obaid.rehman@coindcx.com',
    'ronak.keny@coindcx.com',
    'sujay.patil@coindcx.com',
    'therese.joseph@coindcx.com'
  ]
};

/** Run once from the Apps Script editor to store the CMC key securely. */
function setCmcApiKey() {
  var key = 'PASTE_YOUR_CMC_KEY_HERE';
  if (!key || key.indexOf('PASTE_') === 0) {
    throw new Error('Replace PASTE_YOUR_CMC_KEY_HERE with your real CMC API key, then run setCmcApiKey().');
  }
  PropertiesService.getScriptProperties().setProperty('CMC_API_KEY', key);
  Logger.log('CMC_API_KEY saved to Script Properties.');
}

function getCmcApiKey_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('CMC_API_KEY');
  if (fromProps && String(fromProps).trim()) return String(fromProps).trim();
  return CONFIG.CMC_API_KEY || '';
}

function runAllCryptoTrackers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var healthSheet = ss.getSheetByName('HEALTH');
  var chainSheet = ss.getSheetByName('CHAIN');
  var alertsSheet = ss.getSheetByName('ALERTS');
  var monitoringSheet = ss.getSheetByName('Monitoring');

  if (!healthSheet || !chainSheet || !alertsSheet || !monitoringSheet) {
    Logger.log("❌ Configuration Error: Please ensure tabs named 'HEALTH', 'CHAIN', 'ALERTS', and 'Monitoring' all exist.");
    return;
  }

  var healthLastRow = healthSheet.getLastRow();
  if (healthLastRow < 2) {
    Logger.log("⚠️ No tokens found on the 'HEALTH' sheet.");
    return;
  }

  // =========================================================
  // PHASE 1: SNAPSHOT PREVIOUS DAY'S STATS FROM 'CHAIN' TAB
  // =========================================================
  var chainLastRow = chainSheet.getLastRow();
  var previousExchangeCounts = {};
  var previousD1W1Chains = {};
  var previousD1W1Counts = {};

  if (chainLastRow >= 2) {
    var fullChainData = chainSheet.getRange(2, 1, chainLastRow - 1, 13).getValues();

    fullChainData.forEach(function (row) {
      var summaryTok = row[9] ? String(row[9]).trim().toUpperCase() : '';
      if (!summaryTok) return;

      var cnt = row[11] !== '' ? parseInt(row[11], 10) : 0;
      previousExchangeCounts[summaryTok] = cnt;

      var d1w1String = row[12] ? String(row[12]).trim() : '';
      previousD1W1Counts[summaryTok] = d1w1String ? d1w1String.split(',').length : 0;
    });

    fullChainData.forEach(function (row) {
      var matrixTok = row[0] ? String(row[0]).trim().toUpperCase() : '';
      var chn = row[1] ? String(row[1]).trim().toUpperCase() : '';
      if (!matrixTok) return;

      if (row[2] === 'NO' && row[3] === 'Yes') previousD1W1Chains[matrixTok + '_KUCOIN_' + chn] = true;
      if (row[4] === 'NO' && row[5] === 'Yes') previousD1W1Chains[matrixTok + '_BINANCE_' + chn] = true;
      if (row[6] === 'NO' && row[7] === 'Yes') previousD1W1Chains[matrixTok + '_GATE_' + chn] = true;
    });
  }

  // =========================================================
  // PHASE 2: PARSE INPUT VALUES FROM 'HEALTH' DASHBOARD
  // =========================================================
  var healthABRange = healthSheet.getRange(2, 1, healthLastRow - 1, 2).getValues();
  var idRange = healthSheet.getRange(2, 3, healthLastRow - 1, 1).getValues();

  var tokenValues = healthABRange.map(function (row) {
    var t = row[0] ? row[0].toString().trim() : '';
    return (t.startsWith('#') || t === '') ? '' : t.toUpperCase();
  });
  var idValues = idRange.map(function (row) {
    return (row[0] && !isNaN(row[0]) && row[0] !== '') ? row[0] : '';
  });

  var targetTokens = new Set(tokenValues.filter(function (t) { return t !== ''; }));
  var validIds = idValues.filter(function (id) { return id !== ''; });

  if (targetTokens.size === 0) {
    Logger.log('⚠️ Target tokens matrix empty or still loading.');
    return;
  }

  // Snapshot existing Binance volumes BEFORE overwrite (fallback if live fetch fails)
  var previousBinanceVolumes = {};
  try {
    var prevVols = healthSheet.getRange(2, 6, tokenValues.length, 1).getValues(); // Col F
    for (var pi = 0; pi < tokenValues.length; pi++) {
      if (!tokenValues[pi]) continue;
      var pv = prevVols[pi][0];
      if (pv !== '' && pv !== null && !isNaN(pv)) previousBinanceVolumes[tokenValues[pi]] = parseFloat(pv);
    }
  } catch (ePrev) {
    Logger.log('⚠️ Could not snapshot previous Binance volumes: ' + ePrev);
  }

  // =========================================================
  // PHASE 3: FETCH TICKERS AND CHAIN MATRICES
  // =========================================================
  Logger.log('🔄 Running synchronized endpoint queries...');

  // --- Binance tickers (dedicated retry path) ---
  var binanceTicker = fetchBinanceTickersReliable_();
  var binanceVolMap = binanceTicker.volMap;
  var binanceListedSet = binanceTicker.listedSet;
  var binanceOk = binanceTicker.ok;

  if (!binanceOk) {
    Logger.log('⚠️ Binance ticker unavailable — preserving previous HEALTH Binance volumes. Detail: ' + binanceTicker.error);
  }

  var parallelRequests = [
    { url: CONFIG.BINANCE_CHAIN_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.KUCOIN_TICKER_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.KUCOIN_CHAIN_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.GATE_TICKER_URL, method: 'get', muteHttpExceptions: true },
    { url: CONFIG.GATE_CHAIN_URL, method: 'get', muteHttpExceptions: true }
  ];
  var responses = UrlFetchApp.fetchAll(parallelRequests);

  var kucoinVolMap = {};
  var gateVolMap = {};
  var kucoinListedSet = new Set();
  var gateListedSet = new Set();
  var masterChainMap = {};
  var kucoinGlobalStatus = {};

  try {
    if (responses[1].getResponseCode() === 200) {
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
    } else {
      Logger.log('❌ KuCoin ticker HTTP ' + responses[1].getResponseCode());
    }
  } catch (e) {
    Logger.log('❌ KuCoin ticker parse failed: ' + e);
  }

  try {
    if (responses[3].getResponseCode() === 200) {
      var gJson = JSON.parse(responses[3].getContentText());
      if (Array.isArray(gJson)) {
        gJson.forEach(function (t) {
          var symSplit = String(t.currency_pair || '').toUpperCase().split('_');
          if (symSplit.length > 0 && symSplit[0]) {
            var tokG = symSplit[0];
            gateListedSet.add(tokG);
            if (String(t.currency_pair).toUpperCase().endsWith('_USDT')) {
              gateVolMap[tokG] = parseFloat(t.quote_volume) || 0.0;
            }
          }
        });
      }
    } else {
      Logger.log('❌ Gate ticker HTTP ' + responses[3].getResponseCode());
    }
  } catch (e) {
    Logger.log('❌ Gate ticker parse failed: ' + e);
  }

  function initTokenChain(token, chain) {
    var cleanChain = String(chain).trim().toUpperCase();
    if (!masterChainMap[token]) masterChainMap[token] = {};
    if (!masterChainMap[token][cleanChain]) {
      masterChainMap[token][cleanChain] = {
        binance_deposit: 'NO', binance_withdraw: 'NO',
        kucoin_deposit: 'NO', kucoin_withdraw: 'NO',
        gate_deposit: 'NO', gate_withdraw: 'NO'
      };
    }
    return masterChainMap[token][cleanChain];
  }

  try {
    if (responses[0].getResponseCode() === 200) {
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
    } else {
      Logger.log('❌ Binance chain HTTP ' + responses[0].getResponseCode());
    }
  } catch (e) {
    Logger.log('❌ Binance chain parse failed: ' + e);
  }

  try {
    if (responses[4].getResponseCode() === 200) {
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
    } else {
      Logger.log('❌ Gate chain HTTP ' + responses[4].getResponseCode());
    }
  } catch (e) {
    Logger.log('❌ Gate chain parse failed: ' + e);
  }

  try {
    if (responses[2].getResponseCode() === 200) {
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
    } else {
      Logger.log('❌ KuCoin chain HTTP ' + responses[2].getResponseCode());
    }
  } catch (e) {
    Logger.log('❌ KuCoin chain parse failed: ' + e);
  }

  // =========================================================
  // PHASE 4: FETCH COINMARKETCAP QUOTES
  // =========================================================
  var apiKey = getCmcApiKey_();
  var chunkSize = CONFIG.CMC_CHUNK_SIZE;
  var cmcCoinData = {};

  if (!apiKey) {
    Logger.log('⚠️ CMC API key missing — skip quotes. Run setCmcApiKey() or set Script Property CMC_API_KEY.');
  } else if (validIds.length > 0) {
    for (var ci = 0; ci < validIds.length; ci += chunkSize) {
      var chunk = validIds.slice(ci, ci + chunkSize);
      var cmcUrl = 'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=' +
        chunk.join(',') + '&convert=USD';
      try {
        var cmcResp = UrlFetchApp.fetch(cmcUrl, {
          method: 'GET',
          headers: { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' },
          muteHttpExceptions: true
        });
        if (cmcResp.getResponseCode() === 200) {
          var cmcJson = JSON.parse(cmcResp.getContentText());
          if (cmcJson.data) cmcCoinData = Object.assign(cmcCoinData, cmcJson.data);
        } else {
          Logger.log('❌ CMC HTTP ' + cmcResp.getResponseCode() + ' for chunk starting at ' + ci);
        }
      } catch (e) {
        Logger.log('❌ CMC fetch failed: ' + e);
      }
      Utilities.sleep(CONFIG.CMC_SLEEP_MS);
    }
  }

  // =========================================================
  // PHASE 5: EXECUTE HEALTH MATRIX UPDATES
  // =========================================================
  healthSheet.getRange('D1:L1').setValues([[
    'Price (USD)', 'Market Cap', 'Binance Vol', 'KuCoin Vol', 'Gate Vol',
    'CMC Rank', 'Binance Listed', 'KuCoin Listed', 'Gate Listed'
  ]]).setFontWeight('bold');

  var healthOutput = [];
  var monitoringOutput = [];

  monitoringSheet.getRange('A1:G1').setValues([[
    'target_currency', 'ecode', 'cmc_id', 'cmc_rank', 'Binance(Y/N)', 'KuCoin (Y/N)', 'Gate(Y/N)'
  ]]).setFontWeight('bold');

  for (var i = 0; i < tokenValues.length; i++) {
    var rawToken = tokenValues[i];
    var rawEcode = healthABRange[i][1] || '';
    var rawCmcId = idValues[i];

    if (!rawToken) {
      healthOutput.push(['', '', 0.0, 0.0, 0.0, '', 'No', 'No', 'No']);
      monitoringOutput.push(['', '', '', '', 'No', 'No', 'No']);
      continue;
    }

    var price = '';
    var marketCap = '';
    var cmcRank = '';

    if (rawCmcId && cmcCoinData[rawCmcId]) {
      cmcRank = cmcCoinData[rawCmcId].cmc_rank || '';
      if (cmcCoinData[rawCmcId].quote && cmcCoinData[rawCmcId].quote.USD) {
        price = cmcCoinData[rawCmcId].quote.USD.price || '';
        marketCap = cmcCoinData[rawCmcId].quote.USD.market_cap || '';
      }
    }

    var binanceListed = binanceListedSet.has(rawToken) ? 'Yes' : 'No';
    var kucoinListed = kucoinListedSet.has(rawToken) ? 'Yes' : 'No';
    var gateListed = gateListedSet.has(rawToken) ? 'Yes' : 'No';

    var binanceVol = 0.0;
    if (binanceOk) {
      binanceVol = binanceVolMap.hasOwnProperty(rawToken) ? binanceVolMap[rawToken] : 0.0;
    } else if (previousBinanceVolumes.hasOwnProperty(rawToken)) {
      binanceVol = previousBinanceVolumes[rawToken];
      if (binanceListed === 'No' && binanceVol > 0) binanceListed = 'Yes';
    }

    healthOutput.push([
      price,
      marketCap,
      binanceVol,
      kucoinVolMap[rawToken] || 0.0,
      gateVolMap[rawToken] || 0.0,
      cmcRank,
      binanceListed,
      kucoinListed,
      gateListed
    ]);

    monitoringOutput.push([
      rawToken, rawEcode, rawCmcId, cmcRank, binanceListed, kucoinListed, gateListed
    ]);
  }

  healthSheet.getRange(2, 4, healthOutput.length, 9).setValues(healthOutput);
  Logger.log('📊 HEALTH Tab metrics compiled cleanly.' + (binanceOk ? '' : ' (Binance volumes preserved from previous run)'));

  var monitoringMaxRows = monitoringSheet.getMaxRows();
  if (monitoringMaxRows > 1) {
    monitoringSheet.getRange(2, 1, monitoringMaxRows - 1, 7).clearContent();
  }
  monitoringSheet.getRange(2, 1, monitoringOutput.length, 7).setValues(monitoringOutput);
  Logger.log('📊 Monitoring Columns A through G updated cleanly with active codes.');

  // =========================================================
  // PHASE 6: EXECUTE CHAIN PROCESSING
  // =========================================================
  var chainHeaders = [['token', 'chain', 'kucoin_deposit', 'kucoin_withdraw', 'binance_deposit', 'binance_withdraw', 'gate_deposit', 'gate_withdraw']];
  var chainOutputRows = [];
  var sortedTokens = Array.from(targetTokens).sort();

  var liveTokenExchangeMap = {};
  var d1w1ExchangeMap = {};
  var brokenD1W1Targets = {};

  sortedTokens.forEach(function (token) {
    liveTokenExchangeMap[token] = new Set();
    d1w1ExchangeMap[token] = new Set();
    brokenD1W1Targets[token] = [];
  });

  sortedTokens.forEach(function (token) {
    var hasChains = masterChainMap[token];
    var kcData = kucoinGlobalStatus[token];

    if (hasChains) {
      var chains = Object.keys(masterChainMap[token]).sort();
      chains.forEach(function (chain) {
        var data = masterChainMap[token][chain];
        if (kcData) {
          data.kucoin_deposit = kcData.deposit;
          data.kucoin_withdraw = kcData.withdraw;
        }

        if (data.kucoin_deposit === 'Yes' && data.kucoin_withdraw === 'Yes') liveTokenExchangeMap[token].add('KuCoin');
        if (data.binance_deposit === 'Yes' && data.binance_withdraw === 'Yes') liveTokenExchangeMap[token].add('Binance');
        if (data.gate_deposit === 'Yes' && data.gate_withdraw === 'Yes') liveTokenExchangeMap[token].add('Gate');

        if (data.kucoin_deposit === 'NO' && data.kucoin_withdraw === 'Yes') d1w1ExchangeMap[token].add('KuCoin');
        else if (previousD1W1Chains[token + '_KUCOIN_' + chain]) brokenD1W1Targets[token].push('KuCoin (' + chain + ')');

        if (data.binance_deposit === 'NO' && data.binance_withdraw === 'Yes') d1w1ExchangeMap[token].add('Binance');
        else if (previousD1W1Chains[token + '_BINANCE_' + chain]) brokenD1W1Targets[token].push('Binance (' + chain + ')');

        if (data.gate_deposit === 'NO' && data.gate_withdraw === 'Yes') d1w1ExchangeMap[token].add('Gate');
        else if (previousD1W1Chains[token + '_GATE_' + chain]) brokenD1W1Targets[token].push('Gate (' + chain + ')');

        chainOutputRows.push([
          token, chain,
          data.kucoin_deposit, data.kucoin_withdraw,
          data.binance_deposit, data.binance_withdraw,
          data.gate_deposit, data.gate_withdraw
        ]);
      });
    } else if (kcData) {
      var mainnetStr = 'MAINNET';
      if (kcData.deposit === 'Yes' && kcData.withdraw === 'Yes') liveTokenExchangeMap[token].add('KuCoin');

      if (kcData.deposit === 'NO' && kcData.withdraw === 'Yes') d1w1ExchangeMap[token].add('KuCoin');
      else if (previousD1W1Chains[token + '_KUCOIN_' + mainnetStr]) brokenD1W1Targets[token].push('KuCoin (' + mainnetStr + ')');

      chainOutputRows.push([token, mainnetStr, kcData.deposit, kcData.withdraw, 'NO', 'NO', 'NO', 'NO']);
    } else {
      chainOutputRows.push([token, 'NOT FOUND', 'NO', 'NO', 'NO', 'NO', 'NO', 'NO']);
    }
  });

  chainSheet.clearContents();
  chainSheet.getRange(1, 1, 1, chainHeaders[0].length).setValues(chainHeaders).setFontWeight('bold');
  if (chainOutputRows.length > 0) {
    chainSheet.getRange(2, 1, chainOutputRows.length, chainOutputRows[0].length).setValues(chainOutputRows);
  }

  // =========================================================
  // PHASE 7: HEADER CALCULATIONS & EXCLUSION ANOMALIES
  // =========================================================
  chainSheet.getRange('J1:M1').setValues([['token', 'D1W1 exchange', 'Exchange no', 'D1W1']]).setFontWeight('bold');

  var summaryOutput = [];
  var incomingAlertsList = [];
  var timestampString = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');

  sortedTokens.forEach(function (token) {
    if (!targetTokens.has(token)) return;

    var exchangeSet = liveTokenExchangeMap[token];
    var liveExchangeList = Array.from(exchangeSet).join(',');
    var liveCount = exchangeSet.size;

    var d1w1Set = d1w1ExchangeMap[token];
    var d1w1List = Array.from(d1w1Set).join(',');
    var liveD1w1Count = d1w1Set.size;

    summaryOutput.push([token, liveExchangeList || '', liveCount, d1w1List || '']);

    var triggerEmail = false;
    var alertSubject = '';
    var alertBodyDetails = '';

    if (previousExchangeCounts.hasOwnProperty(token)) {
      var pastCount = previousExchangeCounts[token];
      if (liveCount < pastCount) {
        var alertString = 'Token [' + token + '] coverage degraded from ' + pastCount +
          ' to ' + liveCount + '. Live Active: (' + (liveExchangeList || 'None') + ')';
        incomingAlertsList.push([timestampString, token, pastCount, liveCount, alertString]);

        triggerEmail = true;
        alertSubject = '🚨 CRITICAL: [' + token + '] Coverage Degraded';
        alertBodyDetails =
          '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Metric Category</td><td style="padding: 10px 5px; font-weight: bold; color: #ff4d4d;">TOTAL EXCHANGE COVERAGE DROP</td></tr>' +
          '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Previous Count</td><td style="padding: 10px 5px; font-weight: bold; color: #a855f7;">' + pastCount + '</td></tr>' +
          '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Current Count</td><td style="padding: 10px 5px; font-weight: bold; color: #ff4d4d;">' + liveCount + '</td></tr>' +
          '<tr><td style="padding: 10px 5px; color: #718096; vertical-align: top;">Alert Message</td><td style="padding: 10px 5px; color: #fecdd3; background-color: #1f1315; border-left: 3px solid #ff4d4d; padding-left: 10px; line-height: 1.4;">' + alertString + '</td></tr>';
      }
    }

    if (previousD1W1Counts.hasOwnProperty(token)) {
      var pastD1w1Count = previousD1W1Counts[token];

      if (liveD1w1Count !== pastD1w1Count) {
        var d1AlertString = '';

        if (liveD1w1Count < pastD1w1Count) {
          var targetString = brokenD1W1Targets[token].length > 0 ? brokenD1W1Targets[token].join(', ') : 'Unknown';
          d1AlertString = 'Token [' + token + '] (D1W1) dropped from ' + pastD1w1Count +
            ' to ' + liveD1w1Count + '. Disabled D1W1 Status ' + targetString +
            '. Current D1W1 Exchanges left active: (' + (d1w1List || 'None') + ')';

          triggerEmail = true;
          alertSubject = '🚨 NOTICE: [' + token + '] D1W1 Status Degraded';
          alertBodyDetails =
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Metric Category</td><td style="padding: 10px 5px; font-weight: bold; color: #fb923c;">D1W1 ASYMMETRIC WALLET DROP</td></tr>' +
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Degradation Target</td><td style="padding: 10px 5px; font-weight: bold; color: #f43f5e;">' + targetString + '</td></tr>' +
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Previous D1W1 Count</td><td style="padding: 10px 5px; font-weight: bold; color: #a855f7;">' + pastD1w1Count + '</td></tr>' +
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Current D1W1 Count</td><td style="padding: 10px 5px; font-weight: bold; color: #ff4d4d;">' + liveD1w1Count + '</td></tr>' +
            '<tr><td style="padding: 10px 5px; color: #718096; vertical-align: top;">Alert Message</td><td style="padding: 10px 5px; color: #fecdd3; background-color: #1f1315; border-left: 3px solid #fb923c; padding-left: 10px; line-height: 1.4;">' + d1AlertString + '</td></tr>';
        } else {
          d1AlertString = 'Token [' + token + '] (D1W1) increased from ' + pastD1w1Count +
            ' to ' + liveD1w1Count + '. New D1W1 Active Status verified. Current D1W1 Exchanges: (' +
            (d1w1List || 'None') + ')';

          triggerEmail = true;
          alertSubject = '🟢 NOTICE: [' + token + '] D1W1 Status Increased';
          alertBodyDetails =
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Metric Category</td><td style="padding: 10px 5px; font-weight: bold; color: #10b981;">D1W1 ASYMMETRIC WALLET INCREASE</td></tr>' +
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Active Environments</td><td style="padding: 10px 5px; font-weight: bold; color: #34d399;">(' + (d1w1List || 'None') + ')</td></tr>' +
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Previous D1W1 Count</td><td style="padding: 10px 5px; font-weight: bold; color: #a855f7;">' + pastD1w1Count + '</td></tr>' +
            '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Current D1W1 Count</td><td style="padding: 10px 5px; font-weight: bold; color: #10b981;">' + liveD1w1Count + '</td></tr>' +
            '<tr><td style="padding: 10px 5px; color: #718096; vertical-align: top;">Alert Message</td><td style="padding: 10px 5px; color: #e6f4ea; background-color: #0f1c14; border-left: 3px solid #10b981; padding-left: 10px; line-height: 1.4;">' + d1AlertString + '</td></tr>';
        }

        incomingAlertsList.push([timestampString, token, pastD1w1Count, liveD1w1Count, d1AlertString]);
      }
    }

    if (triggerEmail) {
      try {
        var htmlBody =
          '<div style="font-family: \'Courier New\', Courier, monospace; max-width: 650px; background-color: #0B1220; border: 2px solid #ff4d4d; padding: 20px; border-radius: 4px; color: #ffffff;">' +
          '<h2 style="color: #ff4d4d; margin-top: 0; font-size: 20px; border-bottom: 1px solid #ff4d4d; padding-bottom: 10px; letter-spacing: 1px;">🚨 OPERATIONAL DEGRADATION ALERT</h2>' +
          '<table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; color: #e2e8f0;">' +
          '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096; width: 45%;">Date/Time Verified</td><td style="padding: 10px 5px; font-weight: bold; color: #38bdf8;">' + timestampString + '</td></tr>' +
          '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Token Symbol</td><td style="padding: 10px 5px; font-weight: bold; color: #fb923c;">' + token + '</td></tr>' +
          alertBodyDetails +
          '</table>' +
          '<hr style="border: 0; border-top: 1px solid #1A202C; margin: 20px 0;">' +
          '<p style="font-size: 11px; color: #4a5568; text-align: center; margin-bottom: 0;">Automated Transmission // CoinDCX Operations Command Center Tracking Engine</p>' +
          '</div>';

        MailApp.sendEmail({
          to: CONFIG.ALERT_RECIPIENTS.join(','),
          subject: alertSubject,
          htmlBody: htmlBody,
          name: 'Token Health Chain Metrix'
        });
      } catch (mailErr) {
        Logger.log('❌ Mail send failed for ' + token + ': ' + mailErr);
      }
    }
  });

  if (summaryOutput.length > 0) {
    chainSheet.getRange(2, 10, summaryOutput.length, 4).setValues(summaryOutput);
  }

  // =========================================================
  // PHASE 8: COMMIT STRUCTURAL ANOMALIES TO "ALERTS" TAB
  // =========================================================
  if (alertsSheet.getLastRow() === 0) {
    alertsSheet.appendRow([
      'Date/Time Verified', 'Token Symbol', 'Previous Count', 'Current Count', 'Detailed Status Alert Message'
    ]);
    alertsSheet.getRange('A1:E1').setFontWeight('bold');
  }

  if (incomingAlertsList.length > 0) {
    alertsSheet.getRange(alertsSheet.getLastRow() + 1, 1, incomingAlertsList.length, 5).setValues(incomingAlertsList);
  }

  Logger.log('✅ runAllCryptoTrackers finished.');
}

// =========================================================
// BINANCE TICKER HELPERS
// =========================================================

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
        followRedirects: true
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

      Logger.log('✅ Binance ticker OK via ' + url +
        ' — listed=' + result.listedCount + ', usdtVolumes=' + result.usdtVolumeCount);
      return { ok: true, volMap: result.volMap, listedSet: result.listedSet, error: '' };
    } catch (e) {
      lastError = 'Exception on ' + url + ': ' + (e && e.message ? e.message : e);
      Logger.log('❌ ' + lastError);
      Utilities.sleep(sleepMs * (attempt + 1));
    }
  }

  Logger.log('❌ Binance ticker exhausted all retries. Last error: ' + lastError);
  return { ok: false, volMap: volMap, listedSet: listedSet, error: lastError };
}

function parseBinanceTickerArray_(tickers) {
  var volMap = {};
  var listedSet = new Set();
  var usdtVolumeCount = 0;
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
