/**
 * Token Health — main entry point.
 * Sheets required: HEALTH, CHAIN, ALERTS, Monitoring
 */
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
    return t.startsWith('#') || t === '' ? '' : t.toUpperCase();
  });
  var idValues = idRange.map(function (row) {
    return row[0] && !isNaN(row[0]) && row[0] !== '' ? row[0] : '';
  });

  var targetTokens = new Set(tokenValues.filter(function (t) { return t !== ''; }));
  var validIds = idValues.filter(function (id) { return id !== ''; });

  if (targetTokens.size === 0) {
    Logger.log('⚠️ Target tokens matrix empty or still loading.');
    return;
  }

  // Snapshot existing Binance volumes BEFORE overwrite (fallback if live fetch fails)
  var previousBinanceVolumes = readPreviousBinanceVolumes_(healthSheet, tokenValues);

  // =========================================================
  // PHASE 3: FETCH TICKERS AND CHAIN MATRICES
  // =========================================================
  Logger.log('🔄 Running synchronized endpoint queries...');
  var snap = fetchExchangeSnapshots_(targetTokens);

  var binanceVolMap = snap.binanceVolMap || {};
  var kucoinVolMap = snap.kucoinVolMap || {};
  var gateVolMap = snap.gateVolMap || {};
  var binanceListedSet = snap.binanceListedSet || new Set();
  var kucoinListedSet = snap.kucoinListedSet || new Set();
  var gateListedSet = snap.gateListedSet || new Set();
  var masterChainMap = snap.masterChainMap || {};
  var kucoinGlobalStatus = snap.kucoinGlobalStatus || {};

  if (!snap.binanceOk) {
    Logger.log(
      '⚠️ Binance ticker unavailable — preserving previous HEALTH Binance volumes where present. Detail: ' +
      (snap.binanceError || 'unknown')
    );
  }

  // =========================================================
  // PHASE 4: FETCH COINMARKETCAP QUOTES
  // =========================================================
  var cmcCoinData = fetchCmcQuotes_(validIds);

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

    // Volume resolution:
    // 1) live Binance map when fetch succeeded
    // 2) if fetch failed, keep previous sheet value (avoid wiping to 0)
    // 3) else 0
    var binanceVol = 0.0;
    if (snap.binanceOk) {
      binanceVol = binanceVolMap.hasOwnProperty(rawToken) ? binanceVolMap[rawToken] : 0.0;
    } else if (previousBinanceVolumes.hasOwnProperty(rawToken)) {
      binanceVol = previousBinanceVolumes[rawToken];
      // If we preserved volume from a prior successful run, treat as listed
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
      rawToken,
      rawEcode,
      rawCmcId,
      cmcRank,
      binanceListed,
      kucoinListed,
      gateListed
    ]);
  }

  healthSheet.getRange(2, 4, healthOutput.length, 9).setValues(healthOutput);
  Logger.log('📊 HEALTH Tab metrics compiled cleanly.' +
    (snap.binanceOk ? '' : ' (Binance volumes preserved from previous run)'));

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

        if (data.kucoin_deposit === 'NO' && data.kucoin_withdraw === 'Yes') {
          d1w1ExchangeMap[token].add('KuCoin');
        } else if (previousD1W1Chains[token + '_KUCOIN_' + chain]) {
          brokenD1W1Targets[token].push('KuCoin (' + chain + ')');
        }

        if (data.binance_deposit === 'NO' && data.binance_withdraw === 'Yes') {
          d1w1ExchangeMap[token].add('Binance');
        } else if (previousD1W1Chains[token + '_BINANCE_' + chain]) {
          brokenD1W1Targets[token].push('Binance (' + chain + ')');
        }

        if (data.gate_deposit === 'NO' && data.gate_withdraw === 'Yes') {
          d1w1ExchangeMap[token].add('Gate');
        } else if (previousD1W1Chains[token + '_GATE_' + chain]) {
          brokenD1W1Targets[token].push('Gate (' + chain + ')');
        }

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

      if (kcData.deposit === 'NO' && kcData.withdraw === 'Yes') {
        d1w1ExchangeMap[token].add('KuCoin');
      } else if (previousD1W1Chains[token + '_KUCOIN_' + mainnetStr]) {
        brokenD1W1Targets[token].push('KuCoin (' + mainnetStr + ')');
      }

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
  var timestampString = Utilities.formatDate(new Date(), CONFIG.TIMEZONE || 'Asia/Kolkata', 'yyyy-MM-dd HH:mm');

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
        sendDegradationEmail_(token, timestampString, alertSubject, alertBodyDetails);
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
  appendAlerts_(alertsSheet, incomingAlertsList);
  Logger.log('✅ runAllCryptoTrackers finished.');
}
