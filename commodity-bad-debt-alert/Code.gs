/**
 * ============================================================================
 *  Commodity Bad Debt alert — Gold OI > 20x (sheet "Commodity Bad debt" Q37)
 *
 *  Data in Updated Auto-fund movement calculations refreshes every hour
 *  between :25 and :32. This script checks Q37 at ~:33 and emails (and
 *  optionally posts to Slack) when the value crosses:
 *    Amber  > 3.5mm
 *    Red    > 4.0mm
 *    Black  > 5.5mm
 *
 *  Keep helper logic in sync with src/commodity-bad-debt.js
 * ============================================================================
 */

// ============================================================================
// SECTION 1: CONFIG — edit recipients / Slack before installing the trigger
// ============================================================================

const CONFIG = {
  // Leave empty if this project is bound to the Auto-fund spreadsheet.
  // If the live sheet is view-only, put its ID here on a standalone project
  // (you still need at least Viewer access), or point at a helper sheet
  // that IMPORTRANGEs Q37 — see README.
  SPREADSHEET_ID: '',

  SHEET_NAME: 'Commodity Bad debt',
  CELL: 'Q37',
  METRIC_LABEL: 'Gold OI greater than 20x (Bad Debt)',
  LOG_SHEET: 'Q37 Alert Log',

  THRESHOLDS: {
    AMBER: 3500000,
    RED: 4000000,
    BLACK: 5500000
  },

  // Data updates :25–:32. Trigger runs every 5 minutes; we only act in this window.
  CHECK_MINUTE: 33,
  CHECK_WINDOW_MINUTES: 5,
  TIMEZONE: 'Asia/Kolkata',

  // Hourly reminder while still Amber/Red/Black. Set false to only mail on
  // severity change (including recovery to below 3.5mm).
  NOTIFY_WHILE_UNCHANGED: true,

  EMAIL: {
    ENABLED: true,
    TO: [
      'aditya.arya@coindcx.com'
    ],
    CC: []
  },

  // Optional. Set ENABLED true and store the Incoming Webhook URL in
  // Script Properties as SLACK_WEBHOOK_URL (do not paste the URL in this file).
  SLACK: {
    ENABLED: false,
    WEBHOOK_PROP: 'SLACK_WEBHOOK_URL'
  }
};

const SEVERITY_COLOR = {
  NONE: '#34A853',
  AMBER: '#F9AB00',
  RED: '#D93025',
  BLACK: '#202124'
};

const PROP_LAST_HOUR = 'Q37_LAST_CHECK_HOUR';
const PROP_LAST_SEVERITY = 'Q37_LAST_SEVERITY';

// ============================================================================
// SECTION 2: ENTRY POINTS
// ============================================================================

/**
 * Time-driven entry. Install with installTrigger().
 */
function checkCommodityBadDebt() {
  runCheck_({ force: false, dryRun: false });
}

/**
 * Run once from the editor to verify read + email/Slack without waiting for :33.
 * Sends even if severity is NONE so you can confirm delivery.
 */
function testAlertNow() {
  const result = runCheck_({ force: true, dryRun: false, alwaysNotify: true });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Same as testAlertNow but does not send email/Slack. Logs the payload only.
 */
function dryRunCheck() {
  const result = runCheck_({ force: true, dryRun: true, alwaysNotify: true });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Creates a 5-minute clock trigger. The check itself only fires at :33–:37
 * so it lands after the :25–:32 data refresh.
 */
function installTrigger() {
  uninstallTriggers();
  ScriptApp.newTrigger('checkCommodityBadDebt')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Installed 5-minute trigger for checkCommodityBadDebt (acts at :33–:37).');
}

function uninstallTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkCommodityBadDebt') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' checkCommodityBadDebt trigger(s).');
}

// ============================================================================
// SECTION 3: CORE CHECK
// ============================================================================

function runCheck_(opts) {
  opts = opts || {};
  const now = new Date();
  const tz = CONFIG.TIMEZONE || Session.getScriptTimeZone();
  const minute = Number(
    Utilities.formatDate(now, tz, 'm')
  );

  if (!opts.force && !isInCheckWindow(minute, CONFIG.CHECK_MINUTE, CONFIG.CHECK_WINDOW_MINUTES)) {
    return { skipped: true, reason: 'outside-check-window', minute: minute };
  }

  const hour = hourKey(now, tz);
  const props = PropertiesService.getScriptProperties();
  if (!opts.force && props.getProperty(PROP_LAST_HOUR) === hour) {
    return { skipped: true, reason: 'already-ran-this-hour', hour: hour };
  }

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet not found: "' + CONFIG.SHEET_NAME + '"');
  }

  const raw = sheet.getRange(CONFIG.CELL).getValue();
  const value = Number(raw);
  const severity = classifySeverity(value, CONFIG.THRESHOLDS);
  const formattedValue = formatMillions(value);
  const previousSeverity = props.getProperty(PROP_LAST_SEVERITY) || 'NONE';
  const checkedAt = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss z');
  const spreadsheetUrl = ss.getUrl();

  const payload = {
    metricLabel: CONFIG.METRIC_LABEL,
    sheetName: CONFIG.SHEET_NAME,
    cell: CONFIG.CELL,
    value: isFinite(value) ? value : raw,
    formattedValue: formattedValue,
    severity: severity,
    previousSeverity: previousSeverity,
    checkedAt: checkedAt,
    spreadsheetUrl: spreadsheetUrl
  };

  const notify = opts.alwaysNotify ||
    shouldNotify(previousSeverity, severity, CONFIG.NOTIFY_WHILE_UNCHANGED);

  if (!opts.dryRun) {
    props.setProperty(PROP_LAST_HOUR, hour);
    props.setProperty(PROP_LAST_SEVERITY, severity);
    try {
      appendAlertLog_(ss, payload, notify);
    } catch (err) {
      Logger.log('Could not write ' + CONFIG.LOG_SHEET + ' (need edit access): ' + err);
    }
  }

  if (notify && !opts.dryRun) {
    if (CONFIG.EMAIL.ENABLED) sendEmailAlert_(payload);
    if (CONFIG.SLACK.ENABLED) sendSlackAlert_(payload);
  }

  payload.notified = !!(notify && !opts.dryRun);
  payload.dryRun = !!opts.dryRun;
  payload.hour = hour;
  return payload;
}

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error(
      'No active spreadsheet. Bind this script to the Auto-fund sheet, ' +
      'or set CONFIG.SPREADSHEET_ID.'
    );
  }
  return active;
}

// ============================================================================
// SECTION 4: EMAIL + SLACK
// ============================================================================

function sendEmailAlert_(payload) {
  const to = (CONFIG.EMAIL.TO || []).filter(Boolean);
  if (!to.length) {
    Logger.log('EMAIL.TO is empty — skipping email.');
    return;
  }

  const subject = buildAlertSubject(payload.severity, payload.formattedValue);
  const htmlBody = buildEmailHtml_(payload);
  const options = {
    to: to.join(','),
    subject: subject,
    htmlBody: htmlBody,
    name: 'Commodity Bad Debt Alert'
  };
  const cc = (CONFIG.EMAIL.CC || []).filter(Boolean);
  if (cc.length) options.cc = cc.join(',');

  MailApp.sendEmail(options);
  Logger.log('Emailed ' + options.to + ' — ' + subject);
}

function sendSlackAlert_(payload) {
  const url = PropertiesService.getScriptProperties().getProperty(CONFIG.SLACK.WEBHOOK_PROP);
  if (!url) {
    Logger.log('Missing Script Property ' + CONFIG.SLACK.WEBHOOK_PROP + ' — skipping Slack.');
    return;
  }

  const color = SEVERITY_COLOR[payload.severity] || SEVERITY_COLOR.AMBER;
  const title = payload.severity === 'NONE'
    ? 'CLEARED — Gold OI > 20x back below 3.5mm'
    : payload.severity + ' — Gold OI > 20x (Bad Debt)';

  const body = {
    text: buildAlertSubject(payload.severity, payload.formattedValue),
    attachments: [{
      color: color,
      title: title,
      title_link: payload.spreadsheetUrl,
      text: buildAlertText(payload),
      footer: 'Commodity Bad debt · Q37',
      ts: Math.floor(Date.now() / 1000)
    }]
  };

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  Logger.log('Slack webhook status ' + resp.getResponseCode() + ': ' + resp.getContentText());
}

function buildEmailHtml_(payload) {
  const color = SEVERITY_COLOR[payload.severity] || SEVERITY_COLOR.AMBER;
  const badge = payload.severity === 'NONE' ? 'CLEARED' : payload.severity;
  const change = payload.previousSeverity && payload.previousSeverity !== payload.severity
    ? escapeHtml_(payload.previousSeverity) + ' → ' + escapeHtml_(payload.severity)
    : escapeHtml_(payload.severity);

  return (
    '<div style="font-family:Arial,sans-serif;max-width:640px">' +
      '<div style="background:' + color + ';color:#fff;padding:12px 16px;border-radius:6px 6px 0 0">' +
        '<strong style="font-size:16px">' + escapeHtml_(badge) + '</strong>' +
        '<div style="opacity:0.9;font-size:13px;margin-top:4px">' +
          escapeHtml_(payload.metricLabel) +
        '</div>' +
      '</div>' +
      '<div style="border:1px solid #e0e0e0;border-top:0;padding:16px;border-radius:0 0 6px 6px">' +
        '<p style="margin:0 0 12px;font-size:22px;font-weight:bold">' +
          escapeHtml_(payload.formattedValue) +
        '</p>' +
        '<table style="border-collapse:collapse;font-size:14px">' +
          rowHtml_('Cell', payload.sheetName + '!' + payload.cell) +
          rowHtml_('Severity', change) +
          rowHtml_('Amber', '> 3.5mm') +
          rowHtml_('Red', '> 4.0mm') +
          rowHtml_('Black', '> 5.5mm') +
          rowHtml_('Checked at', payload.checkedAt) +
        '</table>' +
        '<p style="margin:16px 0 0">' +
          '<a href="' + escapeHtml_(payload.spreadsheetUrl) + '">Open spreadsheet</a>' +
        '</p>' +
      '</div>' +
    '</div>'
  );
}

function rowHtml_(label, value) {
  return (
    '<tr>' +
      '<td style="padding:4px 16px 4px 0;color:#5f6368">' + escapeHtml_(label) + '</td>' +
      '<td style="padding:4px 0">' + escapeHtml_(String(value)) + '</td>' +
    '</tr>'
  );
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// SECTION 5: ALERT LOG
// ============================================================================

function appendAlertLog_(ss, payload, notified) {
  const headers = [
    'checked_at', 'value', 'formatted', 'severity', 'previous_severity', 'notified'
  ];
  let log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(CONFIG.LOG_SHEET);
    log.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  log.appendRow([
    payload.checkedAt,
    payload.value,
    payload.formattedValue,
    payload.severity,
    payload.previousSeverity,
    notified ? 'yes' : 'no'
  ]);
}

// ============================================================================
// SECTION 6: HELPERS (keep in sync with src/commodity-bad-debt.js)
// ============================================================================

function classifySeverity(value, thresholds) {
  const t = thresholds || CONFIG.THRESHOLDS;
  const n = Number(value);
  if (!isFinite(n)) return 'NONE';
  if (n > t.BLACK) return 'BLACK';
  if (n > t.RED) return 'RED';
  if (n > t.AMBER) return 'AMBER';
  return 'NONE';
}

function formatMillions(value) {
  const n = Number(value);
  if (!isFinite(n)) return String(value);
  return (n / 1000000).toFixed(2) + 'mm (' + Math.round(n).toLocaleString('en-US') + ')';
}

function isInCheckWindow(minute, checkMinute, windowMinutes) {
  const m = Number(minute);
  const start = Number(checkMinute);
  const win = Number(windowMinutes);
  if (!isFinite(m) || !isFinite(start) || !isFinite(win) || win < 1) return false;
  return m >= start && m < start + win;
}

function hourKey(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  return Utilities.formatDate(d, timezone || CONFIG.TIMEZONE, 'yyyy-MM-dd\'T\'HH');
}

function shouldNotify(previousSeverity, currentSeverity, notifyWhileUnchanged) {
  const prev = previousSeverity || 'NONE';
  const curr = currentSeverity || 'NONE';
  if (prev !== curr) return true;
  if (curr === 'NONE') return false;
  return !!notifyWhileUnchanged;
}

function buildAlertSubject(severity, formattedValue) {
  if (severity === 'NONE') {
    return '[CLEARED] Commodity bad debt Q37 back below 3.5mm — ' + formattedValue;
  }
  return '[' + severity + '] Commodity bad debt Q37 = ' + formattedValue;
}

function buildAlertText(opts) {
  const lines = [];
  lines.push(opts.metricLabel || CONFIG.METRIC_LABEL);
  lines.push('Sheet: ' + (opts.sheetName || CONFIG.SHEET_NAME) + '!' + (opts.cell || CONFIG.CELL));
  lines.push('Value: ' + opts.formattedValue);
  lines.push('Severity: ' + opts.severity);
  lines.push('Amber > 3.5mm | Red > 4.0mm | Black > 5.5mm');
  if (opts.checkedAt) lines.push('Checked at: ' + opts.checkedAt);
  if (opts.spreadsheetUrl) lines.push('Sheet: ' + opts.spreadsheetUrl);
  return lines.join('\n');
}
