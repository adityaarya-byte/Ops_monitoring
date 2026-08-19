/**
 * LEVERAGE MONITORING — LIVE CHECKS + WEEKLY EMAIL REPORT
 * ---------------------------------------------------------
 * Reads the "Outcome" sheet, computes 4 checks per symbol, writes the
 * results to a "Live Checks" sheet, and emails a summary report.
 *
 * SETUP (one-time):
 *   1. Open this Google Sheet.
 *   2. Extensions > Apps Script.
 *   3. Delete any starter code, paste this whole file in.
 *   4. Edit CONFIG below (your email, source sheet name if different).
 *   5. Run the function `setupWeeklyTrigger` once from the toolbar
 *      (▶ button next to the function dropdown). Google will ask you
 *      to authorize — approve it (it's your own script on your own sheet).
 *   6. Done. It will now run automatically every Monday at 8am and
 *      email you. To test immediately without waiting, run
 *      `runLeverageCheckNow` instead.
 */

// ============================= CONFIG =============================
var CONFIG = {
  SOURCE_SHEET_NAME: 'Outcome',          // sheet to read data from
  OUTPUT_SHEET_NAME: 'Live Checks',      // sheet to write results to (recreated each run)
  EMAIL_TO: 'aditya.arya@coindcx.com',    // <-- CHANGE THIS to your email
  EMAIL_SUBJECT_PREFIX: 'Leverage Monitoring — Weekly Report',

  // Thresholds (edit these if you want to tune sensitivity)
  UTILIZATION_WARNING: 0.70,             // >=70% utilization -> WATCH
  UTILIZATION_CRITICAL: 1.00,            // >=100% utilization -> CRITICAL BREACH
  CONC_VS_DCX_BINANCE_THRESHOLD: 0.70,   // Highest Single User / DCX on Binance
  CONC_VS_MAX_NOTIONAL_THRESHOLD: 0.70,  // Highest Single User / Max Notional to Users
  UNDERUTIL_THRESHOLD: 0.001,            // 0.1% — both current & prior week must be below this

  // Tier / capacity actions only apply when Max Notional to Users is above this floor.
  // 1-CRITICAL (capacity breach) requires max notional > this value.
  // Underutilized 2 weeks + max notional > this value -> reduce tier on DCX.
  MAX_NOTIONAL_TIER_THRESHOLD: 450000,

  // Trigger schedule
  TRIGGER_WEEKDAY: ScriptApp.WeekDay.MONDAY,
  TRIGGER_HOUR: 8                        // 8am, in the spreadsheet's timezone
};
// =====================================================================

/**
 * Main entry point — run this manually to test, or it runs automatically
 * via the weekly trigger.
 */
function runLeverageCheckNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var srcSheet = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
  if (!srcSheet) {
    throw new Error('Could not find a sheet named "' + CONFIG.SOURCE_SHEET_NAME + '". Check CONFIG.SOURCE_SHEET_NAME.');
  }

  var data = srcSheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).filter(function (r) { return r[0] !== '' && r[0] !== null; });

  var colIndex = mapHeaders(headers);
  var results = rows.map(function (row) { return evaluateRow(row, colIndex); });

  writeLiveChecksSheet(ss, results);
  var summary = buildSummary(results);
  sendEmailReport(ss, summary, results);
}

/**
 * Finds the column index for each field we need by fuzzy-matching header
 * text, so the script keeps working even if column order changes or
 * headers get renamed slightly (e.g. "Updated" vs "Upodated").
 */
function mapHeaders(headers) {
  var norm = headers.map(function (h) { return String(h).toLowerCase().trim(); });

  function find(predicate, label) {
    for (var i = 0; i < norm.length; i++) {
      if (predicate(norm[i])) return i;
    }
    throw new Error('Could not find a column for: ' + label + '. Check your Outcome sheet headers.');
  }

  return {
    symbol: find(function (h) { return h === 'symbol'; }, 'symbol'),
    dcxOnBinance: find(function (h) { return h.indexOf('dcx on binance') !== -1; }, 'DCX on Binance'),
    volatilityType: find(function (h) { return h === 'volatility_type'; }, 'volatility_type'),
    maxNotional: find(function (h) { return h.indexOf('max notional to users') !== -1; }, 'Max Notional to Users'),
    userPosition: find(function (h) { return h === 'user position'; }, 'User Position (current week)'),
    userPositionPrior: find(function (h) { return h.indexOf('user position prior week') !== -1; }, 'User Position Prior Week'),
    highestSingleUser: find(function (h) { return h.indexOf('highest single user') !== -1; }, 'Highest Single User Position')
  };
}

/** Safe divide: returns null if denominator is 0/blank so we don't crash on #DIV/0!. */
function safeDiv(a, b) {
  a = toNumber(a);
  b = toNumber(b);
  if (!b) return null;
  return a / b;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return 0;
  var n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function isAboveNotionalFloor(maxNotional) {
  return toNumber(maxNotional) > CONFIG.MAX_NOTIONAL_TIER_THRESHOLD;
}

/** Runs all 4 checks for a single row and returns a result object. */
function evaluateRow(row, c) {
  var symbol = row[c.symbol];
  var dcxOnBinance = toNumber(row[c.dcxOnBinance]);
  var maxNotional = toNumber(row[c.maxNotional]);
  var userPosition = toNumber(row[c.userPosition]);
  var userPositionPrior = toNumber(row[c.userPositionPrior]);
  var highestSingleUser = toNumber(row[c.highestSingleUser]);
  var volatilityType = row[c.volatilityType];
  var aboveNotionalFloor = isAboveNotionalFloor(maxNotional);

  var utilizationPct = safeDiv(userPosition, maxNotional);
  var utilizationStatus = 'N/A';
  if (utilizationPct !== null) {
    if (utilizationPct >= CONFIG.UTILIZATION_CRITICAL) utilizationStatus = 'CRITICAL - BREACH';
    else if (utilizationPct >= CONFIG.UTILIZATION_WARNING) utilizationStatus = 'WARNING';
    else utilizationStatus = 'OK';
  }

  var concDcxPct = safeDiv(highestSingleUser, dcxOnBinance);
  var concDcxStatus = concDcxPct === null ? 'N/A' : (concDcxPct > CONFIG.CONC_VS_DCX_BINANCE_THRESHOLD ? 'BREACH' : 'OK');

  var concMaxPct = safeDiv(highestSingleUser, maxNotional);
  var concMaxStatus = concMaxPct === null ? 'N/A' : (concMaxPct >= CONFIG.CONC_VS_MAX_NOTIONAL_THRESHOLD ? 'BREACH' : 'OK');

  var underutilStatus = 'N/A';
  if (maxNotional > 0) {
    var curRatio = userPosition / maxNotional;
    var priorRatio = userPositionPrior / maxNotional;
    var underutilizedTwoWeeks = (curRatio < CONFIG.UNDERUTIL_THRESHOLD && priorRatio < CONFIG.UNDERUTIL_THRESHOLD);
    if (underutilizedTwoWeeks && aboveNotionalFloor) {
      underutilStatus = 'WARNING - Reduce Tier on DCX';
    } else {
      underutilStatus = 'OK';
    }
  }

  var master;
  if (utilizationStatus === 'CRITICAL - BREACH' && aboveNotionalFloor) {
    master = '1-CRITICAL: Capacity breach - reclass tier or add Binance capacity / cut leverage';
  } else if (concDcxStatus === 'BREACH') {
    master = '2-WARNING: Single-user concentration vs DCX Binance position - cap user / add DCX margin';
  } else if (concMaxStatus === 'BREACH') {
    master = '2-WARNING: Single-user concentration vs Max Notional - cap user position';
  } else if (utilizationStatus === 'WARNING' || utilizationStatus === 'CRITICAL - BREACH') {
    // CRITICAL with max notional ≤ 450k is still a utilization issue, but not a tier-capacity incident.
    master = '3-WATCH: Utilization >70% - monitor, pre-position capacity';
  } else if (underutilStatus === 'WARNING - Reduce Tier on DCX') {
    master = '4-ACTION: Underutilized 2wks - reduce tier on DCX';
  } else {
    master = 'OK';
  }

  return {
    symbol: symbol,
    volatilityType: volatilityType,
    dcxOnBinance: dcxOnBinance,
    maxNotional: maxNotional,
    userPosition: userPosition,
    userPositionPrior: userPositionPrior,
    highestSingleUser: highestSingleUser,
    utilizationPct: utilizationPct,
    utilizationStatus: utilizationStatus,
    concDcxPct: concDcxPct,
    concDcxStatus: concDcxStatus,
    concMaxPct: concMaxPct,
    concMaxStatus: concMaxStatus,
    underutilStatus: underutilStatus,
    master: master
  };
}

/** Clears/recreates the Live Checks sheet and writes all rows with color coding. */
function writeLiveChecksSheet(ss, results) {
  var sheet = ss.getSheetByName(CONFIG.OUTPUT_SHEET_NAME);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(CONFIG.OUTPUT_SHEET_NAME);

  var headers = ['Symbol', 'Volatility Type', 'DCX on Binance', 'Max Notional to Users',
    'User Position', 'User Position Prior Week', 'Highest Single User Position',
    'Utilization %', 'Utilization Status', 'Conc. vs DCX-Binance %', 'Conc. vs DCX-Binance Status',
    'Conc. vs Max Notional %', 'Conc. vs Max Notional Status', 'Underutilized Status', 'MASTER ACTION'];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#2E5F8A')
    .setWrap(true).setVerticalAlignment('top');
  sheet.setFrozenRows(1);

  var rows = results.map(function (r) {
    return [r.symbol, r.volatilityType, r.dcxOnBinance, r.maxNotional, r.userPosition,
      r.userPositionPrior, r.highestSingleUser, r.utilizationPct, r.utilizationStatus,
      r.concDcxPct, r.concDcxStatus, r.concMaxPct, r.concMaxStatus, r.underutilStatus, r.master];
  });

  if (rows.length > 0) {
    var range = sheet.getRange(2, 1, rows.length, headers.length);
    range.setValues(rows);
    sheet.getRange(2, 8, rows.length, 1).setNumberFormat('0.00%');  // Utilization %
    sheet.getRange(2, 10, rows.length, 1).setNumberFormat('0.00%'); // Conc vs DCX %
    sheet.getRange(2, 12, rows.length, 1).setNumberFormat('0.00%'); // Conc vs Max Notional %

    // Color-code each row by its MASTER ACTION priority
    for (var i = 0; i < rows.length; i++) {
      var rowRange = sheet.getRange(i + 2, 1, 1, headers.length);
      var master = rows[i][14];
      var color = '#FFFFFF';
      if (master.indexOf('1-CRITICAL') === 0) color = '#F8CBCB';
      else if (master.indexOf('2-WARNING') === 0 || master.indexOf('3-WATCH') === 0) color = '#FDE9C8';
      else if (master.indexOf('4-ACTION') === 0) color = '#EFEFEF';
      else if (master === 'OK') color = '#D9EAD3';
      rowRange.setBackground(color);
    }
  }

  sheet.autoResizeColumns(1, headers.length);
  sheet.getFilter() && sheet.getFilter().remove();
  sheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
}

/** Tallies counts per category for the email summary. */
function buildSummary(results) {
  var summary = { critical: [], concentration: [], watch: [], underutilized: [], ok: 0, total: results.length };
  results.forEach(function (r) {
    if (r.master.indexOf('1-CRITICAL') === 0) summary.critical.push(r);
    else if (r.master.indexOf('2-WARNING') === 0) summary.concentration.push(r);
    else if (r.master.indexOf('3-WATCH') === 0) summary.watch.push(r);
    else if (r.master.indexOf('4-ACTION') === 0) summary.underutilized.push(r);
    else summary.ok++;
  });
  return summary;
}

/** Builds and sends the HTML summary email. */
function sendEmailReport(ss, summary, results) {
  var sheetUrl = ss.getUrl() + '#gid=' + ss.getSheetByName(CONFIG.OUTPUT_SHEET_NAME).getSheetId();
  var today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'dd MMM yyyy');

  function rowsToHtml(list, pctField) {
    if (list.length === 0) return '<p style="color:#888;font-style:italic;">None</p>';
    var html = '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">';
    html += '<tr style="background:#2E5F8A;color:#fff;"><th style="padding:6px;text-align:left;">Symbol</th><th style="padding:6px;text-align:left;">Key %</th><th style="padding:6px;text-align:left;">Action</th></tr>';
    list.forEach(function (r, i) {
      var bg = i % 2 === 0 ? '#F7F7F7' : '#FFFFFF';
      var pctVal = r[pctField];
      var pctDisplay = (pctVal === null || pctVal === undefined) ? '-' : (pctVal * 100).toFixed(1) + '%';
      html += '<tr style="background:' + bg + ';"><td style="padding:6px;border-bottom:1px solid #eee;">' + r.symbol + '</td>' +
        '<td style="padding:6px;border-bottom:1px solid #eee;">' + pctDisplay + '</td>' +
        '<td style="padding:6px;border-bottom:1px solid #eee;">' + r.master.replace(/^\d-/, '') + '</td></tr>';
    });
    html += '</table>';
    return html;
  }

  var html = ''
    + '<div style="font-family:Arial,sans-serif;color:#333;">'
    + '<h2 style="color:#1F4E78;">Leverage Monitoring — Weekly Report (' + today + ')</h2>'
    + '<p>' + summary.total + ' symbols checked. '
    + '<b style="color:#B00020;">' + summary.critical.length + ' critical</b>, '
    + '<b style="color:#B8860B;">' + (summary.concentration.length + summary.watch.length) + ' warning/watch</b>, '
    + summary.underutilized.length + ' underutilized, '
    + summary.ok + ' OK.</p>'

    + '<h3 style="color:#B00020;">1. CRITICAL — Capacity Breach (' + summary.critical.length + ')</h3>'
    + '<p style="color:#555;font-size:13px;">Only when Max Notional to Users &gt; ' + CONFIG.MAX_NOTIONAL_TIER_THRESHOLD.toLocaleString() + ' and utilization ≥ 100%.</p>'
    + rowsToHtml(summary.critical, 'utilizationPct')

    + '<h3 style="color:#B8860B;">2. Concentration Warnings (' + summary.concentration.length + ')</h3>'
    + rowsToHtml(summary.concentration, 'concDcxPct')

    + '<h3 style="color:#B8860B;">3. Watch — Utilization 70-100% (' + summary.watch.length + ')</h3>'
    + rowsToHtml(summary.watch, 'utilizationPct')

    + '<h3 style="color:#555;">4. Underutilized — Reduce Tier on DCX (' + summary.underutilized.length + ')</h3>'
    + '<p style="color:#555;font-size:13px;">Only when Max Notional to Users &gt; ' + CONFIG.MAX_NOTIONAL_TIER_THRESHOLD.toLocaleString() + ' and both weeks are below the underutil threshold.</p>'
    + rowsToHtml(summary.underutilized, 'utilizationPct')

    + '<p style="margin-top:20px;"><a href="' + sheetUrl + '" style="color:#1F4E78;">Open full Live Checks sheet →</a></p>'
    + '</div>';

  MailApp.sendEmail({
    to: CONFIG.EMAIL_TO,
    subject: CONFIG.EMAIL_SUBJECT_PREFIX + ' - ' + today,
    htmlBody: html
  });
}

/**
 * Run this ONCE to schedule the weekly automatic run + email.
 * Safe to re-run — it removes any existing trigger for this function first.
 */
function setupWeeklyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'runLeverageCheckNow') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('runLeverageCheckNow')
    .timeBased()
    .onWeekDay(CONFIG.TRIGGER_WEEKDAY)
    .atHour(CONFIG.TRIGGER_HOUR)
    .create();

  Logger.log('Weekly trigger created: every ' + CONFIG.TRIGGER_WEEKDAY + ' at ' + CONFIG.TRIGGER_HOUR + ':00.');
}
