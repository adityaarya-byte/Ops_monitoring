/**
 * ============================================================
 *  Rejection Dashboard — sheet tab builders (V2.3 compatible)
 *
 *  Works with Code.gs alerts columns:
 *    A Token | B Exchange | C Account | D Side | E Channel
 *    F First Alert Time | G Latest Alert Time | H Duration (mins)
 *    I Status | J Session Date | K Occurrence | L Reason
 *    M Reason Category | N Rejection Type
 *
 *  Paste as a separate file in the same Apps Script project as Code.gs.
 * ============================================================
 */

var SH_DASHBOARD = 'dashboard';
var SH_ALERTS = 'alerts';
var SH_SUMMARY = 'alerts_summary';
var HIGH_OCCURRENCE_THRESHOLD = 100;
var DURATION_THRESHOLD = 30;

// Keyword map — first match wins (most specific first)
var CLASSIFY_RULES = [
  { kw: 'the market is too volatile right now', category: 'Market Volatility', type: 'CB Rejection', severity: 'High' },
  { kw: 'too volatile', category: 'Market Volatility', type: 'CB Rejection', severity: 'High' },
  { kw: 'try again later', category: 'Market Volatility', type: 'CB Rejection', severity: 'High' },
  { kw: 'not placeable', category: 'Order Not Placeable', type: 'CB Rejection', severity: 'High' },
  { kw: 'circuit breaker', category: 'Circuit Breaker', type: 'CB Rejection', severity: 'High' },
  { kw: 'price protection', category: 'Price Protection', type: 'CB Rejection', severity: 'High' },
  { kw: 'price band', category: 'Price Band', type: 'CB Rejection', severity: 'High' },

  { kw: 'recvwindow', category: 'Timestamp/RecvWindow', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'timestamp for this', category: 'Timestamp/RecvWindow', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'rate limit', category: 'Rate Limited', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'percent_price', category: 'Price Filter', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'filter failure', category: 'Exchange Filter', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'invalidorder', category: 'Invalid Order', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'invalid order', category: 'Invalid Order', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'min notional', category: 'Min Notional', type: 'Exchange Rejection', severity: 'Low' },
  { kw: 'lot size', category: 'Lot Size', type: 'Exchange Rejection', severity: 'Low' },
  { kw: 'too small', category: 'Order Too Small', type: 'Exchange Rejection', severity: 'Low' },

  { kw: 'no eligible account', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'balance insufficient', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'insufficient balance', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'account has insufficient', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'insufficientfunds', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'insufficient funds', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'insufficient_funds', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'balance_not_enough', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'not enough balance', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },
  { kw: 'insufficient', category: 'Insufficient Balance', type: 'Balance Rejection', severity: 'Medium' },

  { kw: 'something went wrong', category: 'System/Unknown Error', type: 'Insta Rejection', severity: 'Medium' },
  { kw: 'otc::order did not succeeded', category: 'OTC Order Failed', type: 'Insta Rejection', severity: 'Medium' },
  { kw: 'did not succeeded', category: 'OTC Order Failed', type: 'Insta Rejection', severity: 'Medium' },
  { kw: 'network error', category: 'Network Error', type: 'Exchange Rejection', severity: 'Medium' },
  { kw: 'internal error', category: 'Exchange Internal Error', type: 'Exchange Rejection', severity: 'Medium' }
];

function getSS_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function tz_() {
  return Session.getScriptTimeZone();
}

function fmtDate_(d) {
  return Utilities.formatDate(new Date(d), tz_(), 'yyyy-MM-dd');
}

function fmtDisplay_(d) {
  return Utilities.formatDate(new Date(d), tz_(), 'MMM d, yyyy');
}

function getOrCreate_(sheetName, headers) {
  if (typeof SheetService !== 'undefined' && SheetService.ensureSheetWithHeaders) {
    return SheetService.ensureSheetWithHeaders(sheetName, headers);
  }
  var ss = getSS_();
  var sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  return sh;
}

/**
 * Classify reason → { rejectionType, reasonCategory, severity }
 * Compatible with channel name `cb-order-rejection` (V2.3).
 */
function classifyReason_(reason, format, channel) {
  var r = String(reason || '').toLowerCase();
  var ch = String(channel || '').toLowerCase();
  var isCbCh =
    ch === 'cb-order-rejection' ||
    ch === 'cb-rejection' ||
    ch.indexOf('cb-order-rejection') !== -1 ||
    ch.indexOf('cb-rejection') !== -1;

  // Market volatility (CB) — reason wins regardless of channel
  if (r.indexOf('too volatile') !== -1 || r.indexOf('try again later') !== -1) {
    return {
      rejectionType: 'CB Rejection',
      reasonCategory: 'Market Volatility',
      severity: 'High'
    };
  }

  // Keyword rules next (e.g. "something went wrong" → Insta / System)
  for (var i = 0; i < CLASSIFY_RULES.length; i++) {
    if (r && r.indexOf(CLASSIFY_RULES[i].kw) !== -1) {
      return {
        rejectionType: CLASSIFY_RULES[i].type,
        reasonCategory: CLASSIFY_RULES[i].category,
        severity: CLASSIFY_RULES[i].severity
      };
    }
  }

  // CB channel / digest fallback → treat as CB Rejection
  if (isCbCh || format === 'CB-Digest') {
    return {
      rejectionType: 'CB Rejection',
      reasonCategory: 'Market Volatility',
      severity: 'High'
    };
  }

  if (format === 'B') {
    return {
      rejectionType: 'Insta Rejection',
      reasonCategory: 'OTC Order Failed',
      severity: 'Medium'
    };
  }

  return { rejectionType: 'Uncategorized', reasonCategory: 'Other', severity: 'Low' };
}

function topN_(obj, n) {
  return Object.keys(obj)
    .map(function (k) { return [k, obj[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, n);
}

/** Live `dashboard` sheet tab from `alerts` data. */
function buildDashboard() {
  var ss = getSS_();
  var dash = ss.getSheetByName(SH_DASHBOARD);
  if (!dash) dash = ss.insertSheet(SH_DASHBOARD);

  var alertsSheet = ss.getSheetByName(SH_ALERTS);
  if (!alertsSheet) {
    Logger.log('⚠️ alerts sheet missing — dashboard skipped.');
    return;
  }
  var aLast = alertsSheet.getLastRow();
  if (aLast < 2) {
    Logger.log('⚠️ no alerts data — dashboard skipped.');
    return;
  }

  // getRange(row, column, numRows, numColumns)
  var numData = aLast - 1;
  var data = alertsSheet.getRange(2, 1, numData, 14).getValues();

  var tz = tz_();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var yday = Utilities.formatDate(new Date(Date.now() - 86400000), tz, 'yyyy-MM-dd');

  var agg = {
    today: { total: 0, cb: 0, insta: 0, balance: 0, exchange: 0, uncat: 0, active: 0 },
    yday: { total: 0, cb: 0, insta: 0, balance: 0, exchange: 0, uncat: 0, active: 0 }
  };
  var byType = {};
  var byCategory = {};
  var byExchange = {};
  var byToken = {};
  var bySide = { buy: 0, sell: 0 };
  var byHour = {};
  var durSum = 0;
  var durCount = 0;
  var durMax = 0;
  var highOcc = [];

  data.forEach(function (row) {
    var status = row[8];
    var sessDate = row[9];
    var occurrence = Number(row[10]) || 1;
    var reasonCat = row[12] || 'Other';
    var rejType = row[13] || 'Uncategorized';
    var token = row[0];
    var exchange = row[1];
    var side = String(row[3] || '').toLowerCase();
    var durationM = Number(row[7]) || 0;

    if (!sessDate) return;
    var dKey = Utilities.formatDate(new Date(sessDate), tz, 'yyyy-MM-dd');
    var bucket = dKey === today ? agg.today : (dKey === yday ? agg.yday : null);
    if (!bucket) return;

    bucket.total++;
    if (rejType === 'CB Rejection') bucket.cb++;
    else if (rejType === 'Insta Rejection') bucket.insta++;
    else if (rejType === 'Balance Rejection') bucket.balance++;
    else if (rejType === 'Exchange Rejection') bucket.exchange++;
    else bucket.uncat++;
    if (status === 'Live') bucket.active++;

    if (dKey === today) {
      byType[rejType] = (byType[rejType] || 0) + 1;
      byCategory[reasonCat] = (byCategory[reasonCat] || 0) + 1;
      byExchange[exchange] = (byExchange[exchange] || 0) + 1;
      byToken[token] = (byToken[token] || 0) + occurrence;
      if (side === 'buy' || side === 'sell') bySide[side]++;
      var hr = Utilities.formatDate(new Date(sessDate), tz, 'H');
      byHour[hr] = (byHour[hr] || 0) + 1;
      durSum += durationM;
      durCount++;
      if (durationM > durMax) durMax = durationM;
      if (occurrence > HIGH_OCCURRENCE_THRESHOLD) {
        highOcc.push([token, exchange, occurrence, status]);
      }
    }
  });

  highOcc.sort(function (a, b) { return b[2] - a[2]; });

  function delta(t, y) { return t - y; }
  var avgDur = durCount ? (durSum / durCount) : 0;
  var pctResolvedFast = agg.today.total
    ? (100 * (agg.today.total - agg.today.active) / agg.today.total)
    : 0;

  var NCOLS = 8;
  var grid = [];
  function pad() { return new Array(NCOLS).fill(''); }
  function put(rowArr) {
    var row = pad();
    rowArr.forEach(function (v, i) { row[i] = v; });
    grid.push(row);
  }

  put(['REJECTION DASHBOARD']);
  put(['Last updated: ' + Utilities.formatDate(new Date(), tz, 'MMM d, yyyy HH:mm')]);
  put([]);

  var cards = [
    ['Total (today)', agg.today.total, delta(agg.today.total, agg.yday.total)],
    ['CB Rejections', agg.today.cb, delta(agg.today.cb, agg.yday.cb)],
    ['Insta / OTC', agg.today.insta, delta(agg.today.insta, agg.yday.insta)],
    ['Balance', agg.today.balance, delta(agg.today.balance, agg.yday.balance)],
    ['Exchange', agg.today.exchange, delta(agg.today.exchange, agg.yday.exchange)],
    ['Active (Live)', agg.today.active, 'ACTIVE_FLAG'],
    ['High-Occ >' + HIGH_OCCURRENCE_THRESHOLD, highOcc.length, 'HIGHOCC_FLAG']
  ];
  var labelRow = pad();
  var valueRow = pad();
  var deltaRow = pad();
  cards.forEach(function (c, i) {
    labelRow[i] = c[0];
    valueRow[i] = c[1];
    if (c[2] === 'ACTIVE_FLAG') {
      deltaRow[i] = agg.today.active > 0 ? 'needs attention' : 'all clear';
    } else if (c[2] === 'HIGHOCC_FLAG') {
      deltaRow[i] = highOcc.length > 0 ? highOcc.length + ' token(s)' : 'none';
    } else {
      var arrow = c[2] > 0 ? '+ ' : (c[2] < 0 ? '- ' : '= ');
      deltaRow[i] = arrow + Math.abs(c[2]) + ' vs yday';
    }
  });
  grid.push(labelRow, valueRow, deltaRow);
  put([]);

  put(['% Resolved (not Live) today', pctResolvedFast.toFixed(1) + '%']);
  put(['Avg Duration (mins) today', Number(avgDur.toFixed(1))]);
  put(['Max Duration (mins) today', durMax]);
  put([]);

  var highOccTitleRow = grid.length + 1;
  put(['HIGH-OCCURRENCE TOKENS TODAY (occurrence > ' + HIGH_OCCURRENCE_THRESHOLD + ')']);
  put(['Token', 'Exchange', 'Occurrence', 'Status']);
  var highOccHeaderRow = grid.length;
  if (highOcc.length) {
    highOcc.forEach(function (r) { put([r[0], r[1], r[2], r[3]]); });
  } else {
    put(['(none today)']);
  }
  var highOccDataRows = highOcc.length;
  put([]);
  put([]);

  function addBlock(title, obj) {
    put([title]);
    var entries = Array.isArray(obj) ? obj : topN_(obj, 50);
    if (!entries.length) put(['(no data)']);
    else entries.forEach(function (e) { put([e[0], e[1]]); });
    put([]);
  }
  addBlock('By Rejection Type', byType);
  addBlock('By Reason Category', byCategory);
  addBlock('By Exchange', byExchange);
  addBlock('Top Tokens (occurrence-weighted)', topN_(byToken, 10));
  addBlock('By Side', bySide);
  addBlock('By Hour (today)', byHour);

  dash.clear();
  dash.getRange(1, 1, grid.length, NCOLS).setValues(grid);

  dash.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  dash.getRange(2, 1).setFontColor('#666666');
  dash.getRange(4, 1, 1, cards.length).setFontWeight('bold').setFontColor('#555555').setFontSize(9);
  dash.getRange(5, 1, 1, cards.length).setFontSize(20).setFontWeight('bold');
  dash.getRange(6, 1, 1, cards.length).setFontSize(9);
  dash.getRange(8, 1, 3, 1).setFontWeight('bold');

  dash.getRange(highOccTitleRow, 1, 1, 4).merge().setFontWeight('bold')
    .setBackground('#fce8b2').setFontColor('#7f4f00');
  dash.getRange(highOccHeaderRow, 1, 1, 4).setFontWeight('bold').setBackground('#fff2cc');
  if (highOccDataRows > 0) {
    dash.getRange(highOccHeaderRow + 1, 1, highOccDataRows, 4).setBackground('#fff9e6');
  }

  Logger.log('📈 dashboard tab rebuilt. High-occ tokens: ' + highOcc.length);
}

/** Optional daily summary with type breakdown. */
function buildAlertsSummaryV2() {
  var SUMM_HEADERS = [
    'Date', 'Total Alerts', 'Alerts Age <30 min', '% <30 min',
    'CB', 'Insta', 'Balance', 'Exchange', 'Uncategorized'
  ];
  var alertsSheet = getSS_().getSheetByName(SH_ALERTS);
  var summSheet = getOrCreate_(SH_SUMMARY, SUMM_HEADERS);
  if (!alertsSheet) return;
  var aLast = alertsSheet.getLastRow();
  if (aLast < 2) return;

  var data = alertsSheet.getRange(2, 1, aLast - 1, 14).getValues();
  var byDate = {};

  data.forEach(function (row) {
    var durationMins = Number(row[7]);
    var sessionDate = row[9];
    var rejType = row[13] || 'Uncategorized';
    if (!sessionDate) return;
    var dateKey = fmtDate_(sessionDate);
    if (!byDate[dateKey]) {
      byDate[dateKey] = {
        total: 0, age: 0, cb: 0, insta: 0, balance: 0, exchange: 0, uncat: 0,
        dateObj: new Date(sessionDate)
      };
    }
    var d = byDate[dateKey];
    d.total++;
    if (durationMins < DURATION_THRESHOLD) d.age++;
    if (rejType === 'CB Rejection') d.cb++;
    else if (rejType === 'Insta Rejection') d.insta++;
    else if (rejType === 'Balance Rejection') d.balance++;
    else if (rejType === 'Exchange Rejection') d.exchange++;
    else d.uncat++;
  });

  if (!Object.keys(byDate).length) return;

  if (typeof SheetService !== 'undefined' && SheetService.clearSheetDataRows) {
    SheetService.clearSheetDataRows(SH_SUMMARY);
  } else {
    var sLast = summSheet.getLastRow();
    if (sLast > 1) {
      summSheet.getRange(2, 1, sLast - 1, SUMM_HEADERS.length).clearContent();
    }
  }

  var sortedDates = Object.keys(byDate).sort(function (a, b) { return b.localeCompare(a); });
  var rows = sortedDates.map(function (k) {
    var d = byDate[k];
    var pct = d.total > 0 ? ((d.age / d.total) * 100).toFixed(1) + '%' : '0.0%';
    return [
      fmtDisplay_(d.dateObj), d.total, d.age, pct,
      d.cb, d.insta, d.balance, d.exchange, d.uncat
    ];
  });

  if (rows.length) {
    summSheet.getRange(2, 1, rows.length, SUMM_HEADERS.length).setValues(rows);
  }
  Logger.log('📅 alerts_summary (V2) updated: ' + rows.length + ' date(s).');
}
