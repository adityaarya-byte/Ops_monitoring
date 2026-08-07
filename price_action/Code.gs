/**
 * Token Health / Withdrawal Alerts — single-file Google Apps Script
 * Sheets required: HEALTH, CHAIN, ALERTS, Monitoring
 *
 * Alerts (replaces previous coverage / D1W1 email format):
 * - When withdrawal turns OFF for a token on a chain
 * - Binance: include withdrawDesc (red), classify TEMPORARY / PERMANENT / UNKNOWN
 * - KuCoin / Gate: state-only (no reason from API)
 *
 * Delivery: at most 2 emails per run
 *   1) Binance withdrawal-off digest (with reasons)
 *   2) KuCoin + Gate withdrawal-off digest
 */

var CONFIG = {
  CMC_API_KEY: 'd90ea812cc994bf4bfa11c7c2c7bebc7',
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
    'therese.joseph@coindcx.com',
    'pratik.gothankar@coindcx.com'
  ]
};

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
  // PHASE 1: SNAPSHOT PREVIOUS WITHDRAW STATUS FROM 'CHAIN'
  // key = TOKEN|EXCHANGE|CHAIN  →  "Yes" | "NO"
  // =========================================================
  var previousWithdrawState = {}; // TOKEN|EXCHANGE|CHAIN → Yes/NO
  var chainLastRow = chainSheet.getLastRow();

  if (chainLastRow >= 2) {
    var fullChainData = chainSheet.getRange(2, 1, chainLastRow - 1, 8).getValues();
    fullChainData.forEach(function (row) {
      var matrixTok = row[0] ? String(row[0]).trim().toUpperCase() : '';
      var chn = row[1] ? String(row[1]).trim().toUpperCase() : '';
      if (!matrixTok || !chn) return;

      // cols: token, chain, kucoin_dep, kucoin_wd, binance_dep, binance_wd, gate_dep, gate_wd
      previousWithdrawState[matrixTok + '|KUCOIN|' + chn] = normalizeYesNo_(row[3]);
      previousWithdrawState[matrixTok + '|BINANCE|' + chn] = normalizeYesNo_(row[5]);
      previousWithdrawState[matrixTok + '|GATE|' + chn] = normalizeYesNo_(row[7]);
    });
  }

  // =========================================================
  // PHASE 2: PARSE INPUT VALUES FROM 'HEALTH'
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

  var previousBinanceVolumes = {};
  try {
    var prevVols = healthSheet.getRange(2, 6, tokenValues.length, 1).getValues();
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
  var masterChainMap = {}; // token → chain → status object

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
        binance_deposit: 'NO',
        binance_withdraw: 'NO',
        binance_withdraw_desc: '',
        kucoin_deposit: 'NO',
        kucoin_withdraw: 'NO',
        gate_deposit: 'NO',
        gate_withdraw: 'NO'
      };
    }
    return masterChainMap[token][cleanChain];
  }

  // --- Binance chains (includes withdrawDesc) ---
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
              r.binance_withdraw_desc = net.withdrawDesc ? String(net.withdrawDesc).trim() : '';
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

  // --- Gate chains ---
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

  // --- KuCoin chains (per-chain when available; else MAINNET global) ---
  try {
    if (responses[2].getResponseCode() === 200) {
      var kChainJson = JSON.parse(responses[2].getContentText());
      if (kChainJson && kChainJson.data) {
        kChainJson.data.forEach(function (coin) {
          var token = String(coin.currency || '').toUpperCase();
          kucoinListedSet.add(token);
          if (!targetTokens.has(token)) return;

          var globalDep = coin.isDepositEnabled ? 'Yes' : 'NO';
          var globalWd = coin.isWithdrawEnabled ? 'Yes' : 'NO';

          if (coin.chains && Array.isArray(coin.chains) && coin.chains.length > 0) {
            coin.chains.forEach(function (c) {
              var chainName = c.chainName || c.chain || c.chainId || 'MAINNET';
              var r = initTokenChain(token, chainName);
              // Prefer chain-level flags when present; else fall back to global
              if (typeof c.isDepositEnabled === 'boolean') {
                r.kucoin_deposit = c.isDepositEnabled ? 'Yes' : 'NO';
              } else {
                r.kucoin_deposit = globalDep;
              }
              if (typeof c.isWithdrawEnabled === 'boolean') {
                r.kucoin_withdraw = c.isWithdrawEnabled ? 'Yes' : 'NO';
              } else {
                r.kucoin_withdraw = globalWd;
              }
            });
          } else {
            var rMain = initTokenChain(token, 'MAINNET');
            rMain.kucoin_deposit = globalDep;
            rMain.kucoin_withdraw = globalWd;
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
    Logger.log('⚠️ CMC API key missing — skip quotes.');
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
  // PHASE 5: HEALTH + MONITORING UPDATES
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
      price, marketCap, binanceVol,
      kucoinVolMap[rawToken] || 0.0,
      gateVolMap[rawToken] || 0.0,
      cmcRank, binanceListed, kucoinListed, gateListed
    ]);

    monitoringOutput.push([
      rawToken, rawEcode, rawCmcId, cmcRank, binanceListed, kucoinListed, gateListed
    ]);
  }

  healthSheet.getRange(2, 4, healthOutput.length, 9).setValues(healthOutput);
  Logger.log('📊 HEALTH Tab metrics compiled.');

  var monitoringMaxRows = monitoringSheet.getMaxRows();
  if (monitoringMaxRows > 1) {
    monitoringSheet.getRange(2, 1, monitoringMaxRows - 1, 7).clearContent();
  }
  monitoringSheet.getRange(2, 1, monitoringOutput.length, 7).setValues(monitoringOutput);

  // =========================================================
  // PHASE 6: CHAIN MATRIX + WITHDRAWAL-OFF ALERT DETECTION
  // =========================================================
  var chainHeaders = [[
    'token', 'chain',
    'kucoin_deposit', 'kucoin_withdraw',
    'binance_deposit', 'binance_withdraw',
    'gate_deposit', 'gate_withdraw'
  ]];
  var chainOutputRows = [];
  var sortedTokens = Array.from(targetTokens).sort();

  var binanceOffAlerts = [];
  var otherOffAlerts = [];
  var incomingAlertsList = [];
  var timestampString = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');

  var liveTokenExchangeMap = {};
  sortedTokens.forEach(function (token) {
    liveTokenExchangeMap[token] = new Set();
  });

  sortedTokens.forEach(function (token) {
    var hasChains = masterChainMap[token];

    if (!hasChains) {
      chainOutputRows.push([token, 'NOT FOUND', 'NO', 'NO', 'NO', 'NO', 'NO', 'NO']);
      return;
    }

    var chains = Object.keys(masterChainMap[token]).sort();
    chains.forEach(function (chain) {
      var data = masterChainMap[token][chain];

      if (data.kucoin_deposit === 'Yes' && data.kucoin_withdraw === 'Yes') liveTokenExchangeMap[token].add('KuCoin');
      if (data.binance_deposit === 'Yes' && data.binance_withdraw === 'Yes') liveTokenExchangeMap[token].add('Binance');
      if (data.gate_deposit === 'Yes' && data.gate_withdraw === 'Yes') liveTokenExchangeMap[token].add('Gate');

      // --- Detect withdrawal OFF transitions ---
      detectWithdrawOff_(
        previousWithdrawState, token, 'BINANCE', chain,
        data.binance_withdraw, data.binance_withdraw_desc,
        timestampString, binanceOffAlerts, otherOffAlerts, incomingAlertsList
      );
      detectWithdrawOff_(
        previousWithdrawState, token, 'KUCOIN', chain,
        data.kucoin_withdraw, '',
        timestampString, binanceOffAlerts, otherOffAlerts, incomingAlertsList
      );
      detectWithdrawOff_(
        previousWithdrawState, token, 'GATE', chain,
        data.gate_withdraw, '',
        timestampString, binanceOffAlerts, otherOffAlerts, incomingAlertsList
      );

      chainOutputRows.push([
        token, chain,
        data.kucoin_deposit, data.kucoin_withdraw,
        data.binance_deposit, data.binance_withdraw,
        data.gate_deposit, data.gate_withdraw
      ]);
    });
  });

  chainSheet.clearContents();
  chainSheet.getRange(1, 1, 1, chainHeaders[0].length).setValues(chainHeaders).setFontWeight('bold');
  if (chainOutputRows.length > 0) {
    chainSheet.getRange(2, 1, chainOutputRows.length, chainOutputRows[0].length).setValues(chainOutputRows);
  }

  // Summary block (sheet only — no longer emailed)
  chainSheet.getRange('J1:L1').setValues([['token', 'Live exchanges', 'Exchange no']]).setFontWeight('bold');
  var summaryOutput = sortedTokens.map(function (token) {
    var list = Array.from(liveTokenExchangeMap[token] || []).join(',');
    return [token, list || '', (liveTokenExchangeMap[token] || new Set()).size];
  });
  if (summaryOutput.length > 0) {
    chainSheet.getRange(2, 10, summaryOutput.length, 3).setValues(summaryOutput);
  }

  // =========================================================
  // PHASE 7: BATCHED WITHDRAWAL-OFF EMAILS (max 2)
  // =========================================================
  if (binanceOffAlerts.length > 0) {
    sendBinanceWithdrawOffEmail_(timestampString, binanceOffAlerts);
  }
  if (otherOffAlerts.length > 0) {
    sendOtherExchangesWithdrawOffEmail_(timestampString, otherOffAlerts);
  }

  // =========================================================
  // PHASE 8: ALERTS TAB
  // =========================================================
  ensureAlertsHeader_(alertsSheet);
  if (incomingAlertsList.length > 0) {
    alertsSheet
      .getRange(alertsSheet.getLastRow() + 1, 1, incomingAlertsList.length, 7)
      .setValues(incomingAlertsList);
  }

  Logger.log(
    '✅ Done. Withdrawal-off alerts — Binance: ' + binanceOffAlerts.length +
    ', KuCoin/Gate: ' + otherOffAlerts.length
  );
}

// =========================================================
// WITHDRAWAL-OFF DETECTION + REASON CLASSIFICATION
// =========================================================

function normalizeYesNo_(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  if (s === 'YES' || s === 'Y' || s === 'TRUE') return 'Yes';
  if (s === 'NO' || s === 'N' || s === 'FALSE') return 'NO';
  return s || '';
}

/**
 * Classify Binance withdrawDesc into TEMPORARY / PERMANENT / UNKNOWN.
 */
function classifyWithdrawReason_(desc) {
  var text = String(desc || '').toLowerCase();
  if (!text) return 'UNKNOWN';

  var temporaryHints = [
    'maintenance', 'undergoing', 'resumed shortly', 'resume shortly',
    'temporarily', 'temporary', 'upgrade', 'upgrading', 'will be resumed',
    'under maintenance', 'wallet upgrade', 'system upgrade'
  ];
  var permanentHints = [
    'not supported', 'please try other networks', 'unsupported',
    'delisted', 'no longer supported', 'permanently', 'disabled permanently'
  ];

  for (var i = 0; i < temporaryHints.length; i++) {
    if (text.indexOf(temporaryHints[i]) !== -1) return 'TEMPORARY';
  }
  for (var j = 0; j < permanentHints.length; j++) {
    if (text.indexOf(permanentHints[j]) !== -1) return 'PERMANENT';
  }
  return 'UNKNOWN';
}

/**
 * Alert only on Yes → NO transition (skip first-seen / already-off).
 */
function detectWithdrawOff_(
  previousWithdrawState, token, exchange, chain,
  liveWithdraw, withdrawDesc,
  timestampString, binanceOffAlerts, otherOffAlerts, incomingAlertsList
) {
  var key = token + '|' + exchange + '|' + chain;
  var prev = previousWithdrawState[key]; // undefined = no prior snapshot
  var live = normalizeYesNo_(liveWithdraw);

  if (!prev) return;           // first run / new chain — no alert
  if (prev !== 'Yes') return;  // was already off or unknown
  if (live !== 'NO') return;   // still on

  var reasonType = 'NONE';
  var reasonText = '';
  var exchangeLabel = exchange === 'BINANCE' ? 'Binance' : (exchange === 'KUCOIN' ? 'KuCoin' : 'Gate');

  if (exchange === 'BINANCE') {
    reasonText = withdrawDesc ? String(withdrawDesc).trim() : '';
    reasonType = classifyWithdrawReason_(reasonText);
    if (!reasonText) reasonText = 'No reason provided by Binance.';
  }

  var alertObj = {
    token: token,
    exchange: exchangeLabel,
    exchangeKey: exchange,
    chain: chain,
    reasonType: reasonType,
    reasonText: reasonText,
    message: buildWithdrawOffMessage_(exchangeLabel, token, chain, reasonType, reasonText)
  };

  if (exchange === 'BINANCE') {
    binanceOffAlerts.push(alertObj);
  } else {
    otherOffAlerts.push(alertObj);
  }

  // ALERTS sheet row: Date | Token | Exchange | Chain | Event | Reason Type | Reason Text
  incomingAlertsList.push([
    timestampString,
    token,
    exchangeLabel,
    chain,
    'Withdrawal OFF',
    reasonType,
    reasonText || (exchangeLabel + ' does not provide a reason.')
  ]);
}

function buildWithdrawOffMessage_(exchangeLabel, token, chain, reasonType, reasonText) {
  if (exchangeLabel === 'Binance') {
    var tone = '';
    if (reasonType === 'TEMPORARY') {
      tone = 'This appears temporary (maintenance / short pause).';
    } else if (reasonType === 'PERMANENT') {
      tone = 'This may be permanent / unsupported on this network.';
    } else {
      tone = 'Please review the Binance reason below.';
    }
    return 'Binance has turned off withdrawals for ' + token + ' on ' + chain + '. ' +
      tone + ' Reason: ' + (reasonText || 'No reason provided.');
  }
  return exchangeLabel + ' has turned off withdrawals for ' + token +
    ' on ' + chain + '. No reason was provided by ' + exchangeLabel + '.';
}

function ensureAlertsHeader_(alertsSheet) {
  var headers = [
    'Date/Time Verified', 'Token Symbol', 'Exchange', 'Chain',
    'Event', 'Reason Type', 'Reason Text'
  ];
  if (alertsSheet.getLastRow() === 0) {
    alertsSheet.appendRow(headers);
    alertsSheet.getRange('A1:G1').setFontWeight('bold');
    return;
  }
  // Upgrade old header layout if needed
  var current = alertsSheet.getRange(1, 1, 1, 7).getValues()[0];
  if (String(current[2]).toLowerCase().indexOf('previous') !== -1 ||
      String(current[4]).toLowerCase().indexOf('detailed') !== -1) {
    alertsSheet.insertRowBefore(1);
    alertsSheet.getRange(1, 1, 1, 7).setValues([headers]).setFontWeight('bold');
  }
}

// =========================================================
// BATCHED EMAILS
// =========================================================

function sendBinanceWithdrawOffEmail_(timestampString, rows) {
  var tokenList = uniqueTokens_(rows).join(', ');
  var tableRows = '';

  rows.forEach(function (r, idx) {
    var typeColor = r.reasonType === 'TEMPORARY' ? '#fbbf24'
      : (r.reasonType === 'PERMANENT' ? '#ff4d4d' : '#94a3b8');
    var bg = idx % 2 === 0 ? '#111827' : '#0B1220';

    tableRows +=
      '<tr style="background-color:' + bg + ';">' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;font-weight:bold;color:#fb923c;">' + r.token + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;color:#e2e8f0;">' + r.chain + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;font-weight:bold;color:' + typeColor + ';text-align:center;">' + r.reasonType + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;color:#ff0000;font-weight:bold;line-height:1.4;">' +
      escapeHtml_(r.reasonText) + '</td>' +
      '</tr>';
  });

  var htmlBody =
    '<div style="font-family:\'Courier New\',Courier,monospace;max-width:960px;background-color:#0B1220;border:2px solid #ff4d4d;padding:20px;border-radius:4px;color:#ffffff;">' +
    '<h2 style="color:#ff4d4d;margin-top:0;font-size:20px;border-bottom:1px solid #ff4d4d;padding-bottom:10px;">' +
    'Binance Withdrawal Off — ' + rows.length + ' alert' + (rows.length > 1 ? 's' : '') + '</h2>' +
    '<p style="color:#94a3b8;font-size:13px;margin:8px 0 16px;">Verified: <span style="color:#38bdf8;font-weight:bold;">' +
    timestampString + '</span></p>' +
    '<p style="color:#cbd5e1;font-size:13px;line-height:1.5;margin:0 0 16px;">' +
    'Binance has turned off withdrawals for the tokens below. ' +
    'Official reason from Binance is shown in <span style="color:#ff0000;font-weight:bold;">red</span>. ' +
    '<b>TEMPORARY</b> usually means maintenance; <b>PERMANENT</b> usually means unsupported on that network.' +
    '</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;color:#e2e8f0;">' +
    '<thead><tr style="background-color:#1A202C;">' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Token</th>' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Chain</th>' +
    '<th style="padding:10px 8px;text-align:center;color:#94a3b8;">Type</th>' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Reason (Binance)</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table>' +
    '<hr style="border:0;border-top:1px solid #1A202C;margin:20px 0;">' +
    '<p style="font-size:11px;color:#4a5568;text-align:center;margin:0;">CoinDCX Operations // Token Health</p>' +
    '</div>';

  try {
    MailApp.sendEmail({
      to: CONFIG.ALERT_RECIPIENTS.join(','),
      subject: 'Binance withdrawal off — ' + rows.length + ' token/chain' +
        (rows.length > 1 ? 's' : '') + ' [' + tokenList + ']',
      htmlBody: htmlBody,
      name: 'Token Health Chain Metrix'
    });
    Logger.log('📧 Binance withdrawal-off email sent (' + rows.length + ').');
  } catch (e) {
    Logger.log('❌ Binance withdrawal-off email failed: ' + e);
  }
}

function sendOtherExchangesWithdrawOffEmail_(timestampString, rows) {
  var tokenList = uniqueTokens_(rows).join(', ');
  var tableRows = '';

  rows.forEach(function (r, idx) {
    var bg = idx % 2 === 0 ? '#111827' : '#0B1220';
    tableRows +=
      '<tr style="background-color:' + bg + ';">' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;font-weight:bold;color:#fb923c;">' + r.token + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;color:#38bdf8;">' + r.exchange + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;color:#e2e8f0;">' + r.chain + '</td>' +
      '<td style="padding:10px 8px;border-bottom:1px solid #1A202C;color:#fecdd3;">' +
      escapeHtml_(r.exchange + ' has turned off withdrawals for ' + r.token + ' on ' + r.chain +
        '. No reason was provided by ' + r.exchange + '.') +
      '</td>' +
      '</tr>';
  });

  var htmlBody =
    '<div style="font-family:\'Courier New\',Courier,monospace;max-width:900px;background-color:#0B1220;border:2px solid #fb923c;padding:20px;border-radius:4px;color:#ffffff;">' +
    '<h2 style="color:#fb923c;margin-top:0;font-size:20px;border-bottom:1px solid #fb923c;padding-bottom:10px;">' +
    'KuCoin / Gate Withdrawal Off — ' + rows.length + ' alert' + (rows.length > 1 ? 's' : '') + '</h2>' +
    '<p style="color:#94a3b8;font-size:13px;margin:8px 0 16px;">Verified: <span style="color:#38bdf8;font-weight:bold;">' +
    timestampString + '</span></p>' +
    '<p style="color:#cbd5e1;font-size:13px;margin:0 0 16px;">' +
    'These exchanges do not publish a withdrawal-off reason in their public API, so only the status change is reported.' +
    '</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;color:#e2e8f0;">' +
    '<thead><tr style="background-color:#1A202C;">' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Token</th>' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Exchange</th>' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Chain</th>' +
    '<th style="padding:10px 8px;text-align:left;color:#94a3b8;">Message</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table>' +
    '<hr style="border:0;border-top:1px solid #1A202C;margin:20px 0;">' +
    '<p style="font-size:11px;color:#4a5568;text-align:center;margin:0;">CoinDCX Operations // Token Health</p>' +
    '</div>';

  try {
    MailApp.sendEmail({
      to: CONFIG.ALERT_RECIPIENTS.join(','),
      subject: 'KuCoin/Gate withdrawal off — ' + rows.length + ' token/chain' +
        (rows.length > 1 ? 's' : '') + ' [' + tokenList + ']',
      htmlBody: htmlBody,
      name: 'Token Health Chain Metrix'
    });
    Logger.log('📧 KuCoin/Gate withdrawal-off email sent (' + rows.length + ').');
  } catch (e) {
    Logger.log('❌ KuCoin/Gate withdrawal-off email failed: ' + e);
  }
}

function uniqueTokens_(rows) {
  var seen = {};
  var out = [];
  rows.forEach(function (r) {
    if (!seen[r.token]) {
      seen[r.token] = true;
      out.push(r.token);
    }
  });
  return out;
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
        lastError = 'HTTP ' + code + ' from ' + url;
        Logger.log('❌ ' + lastError);
        Utilities.sleep(sleepMs * (attempt + 1));
        continue;
      }

      if (!text || text.charAt(0) !== '[') {
        lastError = 'Unexpected Binance ticker body from ' + url;
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

      Logger.log('✅ Binance ticker OK — listed=' + result.listedCount);
      return { ok: true, volMap: result.volMap, listedSet: result.listedSet, error: '' };
    } catch (e) {
      lastError = 'Exception on ' + url + ': ' + (e && e.message ? e.message : e);
      Logger.log('❌ ' + lastError);
      Utilities.sleep(sleepMs * (attempt + 1));
    }
  }

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
