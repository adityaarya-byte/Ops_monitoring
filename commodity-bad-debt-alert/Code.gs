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
  NONE: '#188038',
  AMBER: '#F9AB00',
  RED: '#D93025',
  BLACK: '#202124'
};

const SEVERITY_THEME = {
  NONE: {
    badge: 'CLEARED',
    color: '#188038',
    text: '#FFFFFF',
    meaning: 'Q37 is at or below 3.5mm. Gold OI > 20x bad debt is no longer in an alert band.'
  },
  AMBER: {
    badge: 'AMBER ALERT',
    color: '#F9AB00',
    text: '#3D2E00',
    meaning: 'Q37 is greater than 3.5mm and has not crossed 4.0mm (Red).'
  },
  RED: {
    badge: 'RED ALERT',
    color: '#D93025',
    text: '#FFFFFF',
    meaning: 'Q37 is greater than 4.0mm and has not crossed 5.5mm (Black).'
  },
  BLACK: {
    badge: 'BLACK ALERT',
    color: '#202124',
    text: '#F9AB00',
    meaning: 'Q37 is greater than 5.5mm. Highest Gold OI > 20x bad-debt band.'
  }
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
 * Sends four labelled SAMPLE emails (Amber / Red / Black / Cleared) using
 * example Q37 values so you can see color + format in Gmail. Does not read
 * the live sheet.
 */
function sendSampleAlertEmails() {
  const samples = getSamplePayloads_();
  for (let i = 0; i < samples.length; i++) {
    sendEmailAlert_(samples[i]);
  }
  Logger.log('Sent ' + samples.length + ' sample alert emails.');
  return samples.map(function (p) {
    return { severity: p.severity, subject: buildAlertSubject(p.severity, p.formattedValue, p.sample) };
  });
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

  const subject = buildAlertSubject(payload.severity, payload.formattedValue, payload.sample);
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
    text: buildAlertSubject(payload.severity, payload.formattedValue, payload.sample),
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
  const theme = SEVERITY_THEME[payload.severity] || SEVERITY_THEME.AMBER;
  const change = payload.previousSeverity && payload.previousSeverity !== payload.severity
    ? payload.previousSeverity + ' → ' + (payload.severity === 'NONE' ? 'CLEARED' : payload.severity)
    : (payload.severity === 'NONE' ? 'CLEARED' : payload.severity);
  const bands = [
    { id: 'NONE', label: 'OK', condition: '≤ 3.5mm', color: '#188038' },
    { id: 'AMBER', label: 'AMBER', condition: '> 3.5mm', color: '#F9AB00' },
    { id: 'RED', label: 'RED', condition: '> 4.0mm', color: '#D93025' },
    { id: 'BLACK', label: 'BLACK', condition: '> 5.5mm', color: '#202124' }
  ];

  let ladder = '';
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const active = b.id === payload.severity;
    const bg = active ? b.color : '#F8F9FA';
    const fg = active ? (b.id === 'AMBER' ? '#3D2E00' : '#FFFFFF') : '#3C4043';
    const mark = active ? ' ← current' : '';
    ladder +=
      '<tr>' +
        '<td style="padding:8px 10px;background:' + bg + ';color:' + fg + ';font-weight:' + (active ? 'bold' : 'normal') + ';border-bottom:1px solid #E8EAED;width:88px">' +
          escapeHtml_(b.label) +
        '</td>' +
        '<td style="padding:8px 10px;background:' + bg + ';color:' + fg + ';border-bottom:1px solid #E8EAED">' +
          escapeHtml_(b.condition) + escapeHtml_(mark) +
        '</td>' +
      '</tr>';
  }

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse">' +
      '<tr><td style="background:' + theme.color + ';color:' + theme.text + ';padding:20px 24px">' +
        '<div style="font-size:11px;letter-spacing:1.4px;font-weight:bold">COMMODITY BAD DEBT · Q37</div>' +
        '<div style="font-size:26px;font-weight:bold;margin-top:6px">' + escapeHtml_(theme.badge) + '</div>' +
        '<div style="font-size:13px;margin-top:6px;opacity:0.92">' + escapeHtml_(payload.metricLabel) + '</div>' +
      '</td></tr>' +
      '<tr><td style="padding:20px 24px;border:1px solid #E8EAED;border-top:0">' +
        '<div style="font-size:12px;color:#5F6368;text-transform:uppercase;letter-spacing:0.6px">Current value</div>' +
        '<div style="font-size:28px;font-weight:bold;color:#202124;margin:4px 0 2px">' + escapeHtml_(payload.formattedValue) + '</div>' +
        '<p style="margin:12px 0 18px;font-size:14px;line-height:1.45;color:#3C4043">' + escapeHtml_(theme.meaning) + '</p>' +
        '<div style="font-size:12px;color:#5F6368;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">Threshold bands</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:16px">' +
          ladder +
        '</table>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#3C4043">' +
          rowHtml_('Sheet', payload.sheetName + '!' + payload.cell) +
          rowHtml_('Severity', change) +
          rowHtml_('Checked at', payload.checkedAt) +
        '</table>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>' +
          '<td style="background:' + theme.color + ';border-radius:4px">' +
            '<a href="' + escapeHtml_(payload.spreadsheetUrl) + '" style="display:inline-block;padding:10px 16px;color:' + theme.text + ';text-decoration:none;font-size:13px;font-weight:bold">Open spreadsheet</a>' +
          '</td>' +
        '</tr></table>' +
      '</td></tr>' +
    '</table>'
  );
}

function rowHtml_(label, value) {
  return (
    '<tr>' +
      '<td style="padding:3px 18px 3px 0;color:#5F6368;white-space:nowrap">' + escapeHtml_(label) + '</td>' +
      '<td style="padding:3px 0;font-weight:bold">' + escapeHtml_(String(value)) + '</td>' +
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

function buildAlertSubject(severity, formattedValue, sample) {
  const prefix = sample ? '[SAMPLE] ' : '';
  if (severity === 'NONE') {
    return prefix + '[CLEARED] Commodity bad debt Q37 back below 3.5mm — ' + formattedValue;
  }
  return prefix + '[' + severity + '] Commodity bad debt Q37 = ' + formattedValue;
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

function getSamplePayloads_() {
  const rows = [
    { key: 'amber', severity: 'AMBER', previousSeverity: 'NONE', value: 3720000 },
    { key: 'red', severity: 'RED', previousSeverity: 'AMBER', value: 4450000 },
    { key: 'black', severity: 'BLACK', previousSeverity: 'RED', value: 5820000 },
    { key: 'cleared', severity: 'NONE', previousSeverity: 'AMBER', value: 1997916 }
  ];
  return rows.map(function (spec) {
    return {
      key: spec.key,
      metricLabel: CONFIG.METRIC_LABEL,
      sheetName: CONFIG.SHEET_NAME,
      cell: CONFIG.CELL,
      value: spec.value,
      formattedValue: formatMillions(spec.value),
      severity: spec.severity,
      previousSeverity: spec.previousSeverity,
      checkedAt: '13 Aug 2026, 14:33 IST',
      spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet()
        ? SpreadsheetApp.getActiveSpreadsheet().getUrl()
        : 'https://docs.google.com/spreadsheets',
      sample: true
    };
  });
}
