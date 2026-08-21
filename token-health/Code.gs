/**
 * Token Health — single-file Google Apps Script
 * Sheets: HEALTH, CHAIN, ALERTS, Monitoring, TPE withdrawal
 *
 * D1W1: per exchange, any chain with deposit=Yes AND withdraw=Yes → count 1.
 *
 * Alerts → Slack #token-health-alerts (one message per token, not batched).
 * Skip: 3→2, USDT, USDC.
 * Script Property: SLACK_WEBHOOK_URL = https://hooks.slack.com/services/...
 */

var CONFIG = {
  CMC_API_KEY: 'd90ea812cc994bf4bfa11c7c2c7bebc7', // prefer Script Property CMC_API_KEY via setCmcApiKey()
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
  TPE_WITHDRAWAL_SHEET: 'TPE withdrawal',
  // Slack Incoming Webhook — prefer Script Property SLACK_WEBHOOK_URL
  SLACK_WEBHOOK_URL: '',
  SLACK_CHANNEL_NAME: 'token-health-alerts',
  ALERT_IGNORE_TOKENS: ['USDT', 'USDC']
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

/** Run once: paste Incoming Webhook URL, then run setSlackWebhookUrl() from the editor. */
function setSlackWebhookUrl() {
  var url = 'PASTE_WEBHOOK_URL_HERE';
  if (!url || url.indexOf('PASTE_') === 0 || url.indexOf('hooks.slack.com') === -1) {
    throw new Error('Replace PASTE_WEBHOOK_URL_HERE with your Slack webhook URL (https://hooks.slack.com/services/...), then run setSlackWebhookUrl().');
  }
  PropertiesService.getScriptProperties().setProperty('SLACK_WEBHOOK_URL', url);
  Logger.log('SLACK_WEBHOOK_URL saved to Script Properties.');
}

function getSlackWebhookUrl_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (fromProps && String(fromProps).trim()) return String(fromProps).trim();
  return CONFIG.SLACK_WEBHOOK_URL || '';
}

/**
 * Run this alone to verify the webhook.
 * Success means the message posted to whatever channel THIS webhook was created for
 * (check Slack App → Incoming Webhooks → Post to Channel).
 */
function testSlackWebhook() {
  var webhookUrl = getSlackWebhookUrl_();
  if (!webhookUrl) {
    Logger.log('❌ No SLACK_WEBHOOK_URL set. Run setSlackWebhookUrl() first.');
    return;
  }
  var resp = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      text: 'Token Health test ✅\nIf you see this, webhook works.\nCheck which channel this Incoming Webhook is linked to in Slack App settings.'
    }),
    muteHttpExceptions: true
  });
  Logger.log('HTTP ' + resp.getResponseCode() + ' body=' + resp.getContentText());
  Logger.log('Tip: Incoming Webhooks post ONLY to the channel selected when the webhook was created — not necessarily #token-health-alerts.');
}

function runAllCryptoTrackers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var healthSheet = ss.getSheetByName('HEALTH');
  var chainSheet = ss.getSheetByName('CHAIN');
  var alertsSheet = ss.getSheetByName('ALERTS');
  var monitoringSheet = ss.getSheetByName('Monitoring');
  var tpeSheet = ss.getSheetByName(CONFIG.TPE_WITHDRAWAL_SHEET);

  if (!healthSheet || !chainSheet || !alertsSheet || !monitoringSheet) {
    Logger.log("❌ Configuration Error: Please ensure tabs named 'HEALTH', 'CHAIN', 'ALERTS', and 'Monitoring' all exist.");
    return;
  }
  if (!tpeSheet) {
    Logger.log("⚠️ Sheet '" + CONFIG.TPE_WITHDRAWAL_SHEET + "' not found — add/remove TPE actions will be skipped.");
  }

  var healthLastRow = healthSheet.getLastRow();
  if (healthLastRow < 2) {
    Logger.log("⚠️ No tokens found on the 'HEALTH' sheet.");
    return;
  }

  // =========================================================
  // PHASE 1: SNAPSHOT PREVIOUS D1W1 COUNTS FROM CHAIN SUMMARY
  // Summary cols J–L: token | D1W1 exchanges | count
  // =========================================================
  var chainLastRow = chainSheet.getLastRow();
  var previousD1W1Counts = {};

  if (chainLastRow >= 2) {
    var summarySnap = chainSheet.getRange(2, 10, chainLastRow - 1, 3).getValues(); // J–L
    summarySnap.forEach(function (row) {
      var summaryTok = row[0] ? String(row[0]).trim().toUpperCase() : '';
      if (!summaryTok) return;
      var cnt = row[2] !== '' && !isNaN(row[2]) ? parseInt(row[2], 10) : 0;
      previousD1W1Counts[summaryTok] = cnt;
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
          if (!targetTokens.has(token)) return;

          var globalDep = coin.isDepositEnabled ? 'Yes' : 'NO';
          var globalWd = coin.isWithdrawEnabled ? 'Yes' : 'NO';
          kucoinGlobalStatus[token] = { deposit: globalDep, withdraw: globalWd };

          // Prefer per-chain flags when KuCoin provides them
          if (coin.chains && Array.isArray(coin.chains) && coin.chains.length > 0) {
            coin.chains.forEach(function (c) {
              var chainName = c.chainName || c.chain || c.chainId || 'MAINNET';
              var r = initTokenChain(token, chainName);
              r.kucoin_deposit = (typeof c.isDepositEnabled === 'boolean')
                ? (c.isDepositEnabled ? 'Yes' : 'NO') : globalDep;
              r.kucoin_withdraw = (typeof c.isWithdrawEnabled === 'boolean')
                ? (c.isWithdrawEnabled ? 'Yes' : 'NO') : globalWd;
            });
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

  monitoringSheet.getRange('A1:J1').setValues([[
    'target_currency', 'ecode', 'cmc_id', 'cmc_rank',
    'Binance(Y/N)', 'KuCoin (Y/N)', 'Gate(Y/N)',
    'Active on TPE', 'Chain Exchange D1W1', 'Chain exchange D0W1'
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

    // H–J filled after chain D1W1 maps are built
    monitoringOutput.push([
      rawToken, rawEcode, rawCmcId, cmcRank, binanceListed, kucoinListed, gateListed
    ]);
  }

  healthSheet.getRange(2, 4, healthOutput.length, 9).setValues(healthOutput);
  Logger.log('📊 HEALTH Tab metrics compiled cleanly.' + (binanceOk ? '' : ' (Binance volumes preserved from previous run)'));

  var monitoringMaxRows = monitoringSheet.getMaxRows();
  if (monitoringMaxRows > 1) {
    monitoringSheet.getRange(2, 1, monitoringMaxRows - 1, 10).clearContent();
  }
  // A–G written now; H–J after Phase 6
  monitoringSheet.getRange(2, 1, monitoringOutput.length, 7).setValues(monitoringOutput);

  // =========================================================
  // PHASE 6: CHAIN MATRIX + TRUE D1W1 COUNT (any-chain D+W Yes)
  // =========================================================
  var chainHeaders = [['token', 'chain', 'kucoin_deposit', 'kucoin_withdraw', 'binance_deposit', 'binance_withdraw', 'gate_deposit', 'gate_withdraw']];
  var chainOutputRows = [];
  var sortedTokens = Array.from(targetTokens).sort();

  // D1W1 = deposit Yes AND withdraw Yes on at least one chain for that exchange
  var d1w1ExchangeMap = {};
  // D0W1 = deposit NO AND withdraw Yes (info only — does NOT alert)
  var d0w1ExchangeMap = {};

  sortedTokens.forEach(function (token) {
    d1w1ExchangeMap[token] = new Set();
    d0w1ExchangeMap[token] = new Set();
  });

  sortedTokens.forEach(function (token) {
    var hasChains = masterChainMap[token];
    var kcData = kucoinGlobalStatus[token];

    if (hasChains) {
      var chains = Object.keys(masterChainMap[token]).sort();
      chains.forEach(function (chain) {
        var data = masterChainMap[token][chain];

        // KuCoin: use per-chain flags if set by API; else paint global onto the row for display
        if (kcData && data.kucoin_deposit === 'NO' && data.kucoin_withdraw === 'NO') {
          data.kucoin_deposit = kcData.deposit;
          data.kucoin_withdraw = kcData.withdraw;
        }

        // TRUE D1W1: deposit Yes AND withdraw Yes on this chain → exchange counts as 1 for the token
        if (data.kucoin_deposit === 'Yes' && data.kucoin_withdraw === 'Yes') d1w1ExchangeMap[token].add('KuCoin');
        if (data.binance_deposit === 'Yes' && data.binance_withdraw === 'Yes') d1w1ExchangeMap[token].add('Binance');
        if (data.gate_deposit === 'Yes' && data.gate_withdraw === 'Yes') d1w1ExchangeMap[token].add('Gate');

        // D0W1 info only (does not drive alerts)
        if (data.kucoin_deposit === 'NO' && data.kucoin_withdraw === 'Yes') d0w1ExchangeMap[token].add('KuCoin');
        if (data.binance_deposit === 'NO' && data.binance_withdraw === 'Yes') d0w1ExchangeMap[token].add('Binance');
        if (data.gate_deposit === 'NO' && data.gate_withdraw === 'Yes') d0w1ExchangeMap[token].add('Gate');

        chainOutputRows.push([
          token, chain,
          data.kucoin_deposit, data.kucoin_withdraw,
          data.binance_deposit, data.binance_withdraw,
          data.gate_deposit, data.gate_withdraw
        ]);
      });
    } else if (kcData) {
      var mainnetStr = 'MAINNET';
      if (kcData.deposit === 'Yes' && kcData.withdraw === 'Yes') d1w1ExchangeMap[token].add('KuCoin');
      if (kcData.deposit === 'NO' && kcData.withdraw === 'Yes') d0w1ExchangeMap[token].add('KuCoin');
      chainOutputRows.push([token, mainnetStr, kcData.deposit, kcData.withdraw, 'NO', 'NO', 'NO', 'NO']);
    } else {
      chainOutputRows.push([token, 'NOT FOUND', 'NO', 'NO', 'NO', 'NO', 'NO', 'NO']);
    }
  });

  // Sort chain rows for stable output
  chainOutputRows.sort(function (a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  chainSheet.clearContents();
  chainSheet.getRange(1, 1, 1, chainHeaders[0].length).setValues(chainHeaders).setFontWeight('bold');
  if (chainOutputRows.length > 0) {
    chainSheet.getRange(2, 1, chainOutputRows.length, chainOutputRows[0].length).setValues(chainOutputRows);
  }

  // =========================================================
  // PHASE 7: D1W1 SUMMARY + ALERTS WITH ACTION + TPE SHEET
  // =========================================================
  chainSheet.getRange('J1:M1').setValues([[
    'token', 'D1W1 exchange', 'Exchange no', 'D0W1 exchange'
  ]]).setFontWeight('bold');

  var summaryOutput = [];
  var incomingAlertsList = [];
  var d1w1AlertRows = [];
  var timestampString = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  var monitoringHij = []; // Active on TPE | D1W1 list | D0W1 list — same order as tokenValues

  // Precompute maps for monitoring row order
  for (var mi = 0; mi < tokenValues.length; mi++) {
    var mt = tokenValues[mi];
    if (!mt) {
      monitoringHij.push(['', '', '']);
      continue;
    }
    var mSet = d1w1ExchangeMap[mt] || new Set();
    var m0 = d0w1ExchangeMap[mt] || new Set();
    monitoringHij.push([
      mSet.size,
      Array.from(mSet).join(',') || '',
      Array.from(m0).join(',') || ''
    ]);
  }
  if (monitoringHij.length > 0) {
    monitoringSheet.getRange(2, 8, monitoringHij.length, 3).setValues(monitoringHij);
  }
  Logger.log('📊 Monitoring H–J (Active on TPE / D1W1 / D0W1) updated.');

  sortedTokens.forEach(function (token) {
    if (!targetTokens.has(token)) return;

    var exchangeSet = d1w1ExchangeMap[token] || new Set();
    var liveExchangeList = Array.from(exchangeSet).join(',');
    var liveCount = exchangeSet.size;
    var d0List = Array.from(d0w1ExchangeMap[token] || []).join(',');

    summaryOutput.push([token, liveExchangeList || '', liveCount, d0List || '']);

    // Alert only when true D1W1 exchange-count changes
    if (!previousD1W1Counts.hasOwnProperty(token)) return;
    var pastCount = previousD1W1Counts[token];
    if (liveCount === pastCount) return;

    // Ignore USDT / USDC
    if (shouldIgnoreAlertToken_(token)) {
      Logger.log('Skip alert for ignored token: ' + token);
      return;
    }

    // Ignore 3 → 2 (no Slack, no ALERTS row)
    if (Number(pastCount) === 3 && Number(liveCount) === 2) {
      Logger.log('Skip 3→2 alert for ' + token);
      return;
    }

    var action = getD1W1Action_(pastCount, liveCount);
    var direction = liveCount < pastCount ? 'DROP' : 'INCREASE';
    var alertString = 'Token [' + token + '] D1W1 ' +
      (direction === 'DROP' ? 'dropped' : 'increased') +
      ' from ' + pastCount + ' to ' + liveCount +
      '. Active D1W1 exchanges: (' + (liveExchangeList || 'None') + ')';

    // ALERTS: one new row per alert
    incomingAlertsList.push([
      timestampString, token, pastCount, liveCount, alertString, action
    ]);

    d1w1AlertRows.push({
      token: token,
      direction: direction,
      pastCount: pastCount,
      liveCount: liveCount,
      liveExchangeList: liveExchangeList || 'None',
      action: action,
      message: alertString
    });

    applyTpeSheetAction_(tpeSheet, token, action, timestampString);
  });

  if (summaryOutput.length > 0) {
    chainSheet.getRange(2, 10, summaryOutput.length, 4).setValues(summaryOutput);
  }

  // One Slack message per alert (not combined)
  d1w1AlertRows.forEach(function (row) {
    sendD1W1SlackAlert_(timestampString, row);
  });

  // =========================================================
  // PHASE 8: ALERTS TAB (with Action column)
  // =========================================================
  ensureD1W1AlertsHeader_(alertsSheet);
  if (incomingAlertsList.length > 0) {
    alertsSheet
      .getRange(alertsSheet.getLastRow() + 1, 1, incomingAlertsList.length, 6)
      .setValues(incomingAlertsList);
  }

  Logger.log('✅ runAllCryptoTrackers finished. D1W1 alerts: ' + d1w1AlertRows.length);
}

// =========================================================
// D1W1 ACTION + TPE SHEET + SLACK HELPERS
// =========================================================

function shouldIgnoreAlertToken_(token) {
  var t = String(token || '').trim().toUpperCase();
  var ignore = CONFIG.ALERT_IGNORE_TOKENS || ['USDT', 'USDC'];
  for (var i = 0; i < ignore.length; i++) {
    if (t === String(ignore[i]).toUpperCase()) return true;
  }
  return false;
}

/**
 * Action rules:
 *  3 → 2 : ignored (no alert)
 *  2 → 1 : Ask MOC and Fund Ops; add to TPE withdrawal sheet
 *  1 → 0 : Check funds should be TPE
 *  1 → 2 : No action
 *  2 → 3 : Remove from TPE withdrawal sheet
 */
function getD1W1Action_(prev, curr) {
  prev = Number(prev);
  curr = Number(curr);
  if (prev === curr) return 'No action';

  if (curr < prev) {
    if (prev === 3 && curr === 2) return 'No action';
    if (curr === 1) return 'Ask MOC and Fund Ops; add to TPE withdrawal sheet';
    if (curr === 0) return 'Check funds should be TPE';
    return 'No action';
  }

  if (curr === 3 && prev === 2) return 'Remove from TPE withdrawal sheet';
  if (curr === 3 && prev < 3) return 'Remove from TPE withdrawal sheet';
  return 'No action';
}

function ensureD1W1AlertsHeader_(alertsSheet) {
  var headers = [
    'Date/Time Verified', 'Token Symbol', 'Previous Count', 'Current Count',
    'Detailed Status Alert Message', 'Action'
  ];
  if (alertsSheet.getLastRow() === 0) {
    alertsSheet.appendRow(headers);
    alertsSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    return;
  }
  var current = alertsSheet.getRange(1, 1, 1, 6).getValues()[0];
  if (String(current[5] || '').toLowerCase().indexOf('action') === -1) {
    alertsSheet.getRange(1, 6).setValue('Action').setFontWeight('bold');
    if (String(current[0]).indexOf('Date') === -1) {
      alertsSheet.insertRowBefore(1);
      alertsSheet.getRange(1, 1, 1, 6).setValues([headers]).setFontWeight('bold');
    }
  }
}

function applyTpeSheetAction_(tpeSheet, token, action, timestampString) {
  if (!tpeSheet || !token || !action) return;
  var a = String(action).toLowerCase();

  if (a.indexOf('add to tpe') !== -1) {
    addTokenToTpeSheet_(tpeSheet, token, timestampString);
  } else if (a.indexOf('remove from tpe') !== -1) {
    removeTokenFromTpeSheet_(tpeSheet, token);
  }
}

function addTokenToTpeSheet_(tpeSheet, token, timestampString) {
  var lastRow = tpeSheet.getLastRow();
  if (lastRow >= 1) {
    var colA = tpeSheet.getRange(1, 1, lastRow, 1).getValues();
    for (var i = 0; i < colA.length; i++) {
      if (String(colA[i][0]).trim().toUpperCase() === token) {
        Logger.log('TPE: ' + token + ' already on sheet — skip add.');
        return;
      }
    }
  }
  if (lastRow === 0) {
    tpeSheet.appendRow(['Token', 'Added At', 'Source']);
    tpeSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  tpeSheet.appendRow([token, timestampString, 'Token Health D1W1 alert']);
  Logger.log('TPE: added ' + token);
}

function removeTokenFromTpeSheet_(tpeSheet, token) {
  var lastRow = tpeSheet.getLastRow();
  if (lastRow < 1) return;
  var colA = tpeSheet.getRange(1, 1, lastRow, 1).getValues();
  for (var i = colA.length - 1; i >= 0; i--) {
    if (String(colA[i][0]).trim().toUpperCase() === token) {
      tpeSheet.deleteRow(i + 1);
      Logger.log('TPE: removed ' + token + ' from row ' + (i + 1));
    }
  }
}

/**
 * One Slack message per alert via Incoming Webhook.
 * Format:
 * GRT | D1W1 : 2→1 | Current Active: Gate
 * Action: Ask MOC and Fund Ops; add to TPE withdrawal sheet
 */
function sendD1W1SlackAlert_(timestampString, row) {
  var webhookUrl = getSlackWebhookUrl_();
  if (!webhookUrl) {
    Logger.log('❌ Slack webhook missing. Run setSlackWebhookUrl() or set Script Property SLACK_WEBHOOK_URL.');
    return;
  }

  var text =
    '*' + row.token + '* | D1W1 : ' + row.pastCount + '→' + row.liveCount +
    ' | Current Active: ' + (row.liveExchangeList || 'None') + '\n' +
    'Action: ' + row.action + '\n' +
    '_Verified: ' + timestampString + ' IST_';

  try {
    var resp = UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    var body = (resp.getContentText() || '').substring(0, 200);
    if (code !== 200) {
      Logger.log('❌ Slack webhook failed for ' + row.token + ': HTTP ' + code + ' ' + body);
    } else {
      Logger.log('✅ Slack alert sent for ' + row.token + ' → #' + (CONFIG.SLACK_CHANNEL_NAME || 'token-health-alerts'));
    }
  } catch (e) {
    Logger.log('❌ Slack exception for ' + row.token + ': ' + e);
  }
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
