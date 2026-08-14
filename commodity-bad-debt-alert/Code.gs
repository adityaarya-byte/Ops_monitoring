/**
 * ============================================================================
 *  Commodity Bad Debt alert — Gold OI > 20x (sheet "Commodity Bad debt" Q37)
 *
 *  Data in Updated Auto-fund movement calculations refreshes every hour
 *  between :25 and :32. This script checks Q37 at ~:33 (one snap per hour).
 *    Snap 1 in breach → Amber / Red / Black email
 *    Snap 2+ still in breach → persist email with last 2 snaps + ↑/↓
 *    Later snap back ≤ 3.5mm → green CLEARED + change vs last snap
 *    Amber  > 3.5mm | Red > 4.0mm | Black > 5.5mm
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
const PROP_SNAP_STATE = 'Q37_SNAP_STATE';

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
 * Sends SAMPLE emails (first breach, persistent 2 snaps, Red, Black, Cleared)
 * using example Q37 values. Does not read the live sheet.
 */
function sendSampleAlertEmails() {
  const samples = getSamplePayloads_();
  for (let i = 0; i < samples.length; i++) {
    sendEmailAlert_(samples[i]);
  }
  Logger.log('Sent ' + samples.length + ' sample alert emails.');
  return samples.map(function (p) {
    return { severity: p.severity, subject: buildAlertSubject(p.severity, p.formattedValue, p.sample, p) };
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
  const checkedAt = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss z');
  const spreadsheetUrl = ss.getUrl();
  const prevState = loadSnapState_(props);
  const snap = applySnapshot(prevState, {
    value: isFinite(value) ? value : raw,
    severity: severity,
    checkedAt: checkedAt,
    hour: hour
  });
  const previousSeverity = snap.previousSeverity || 'NONE';

  const payload = Object.assign({
    metricLabel: CONFIG.METRIC_LABEL,
    sheetName: CONFIG.SHEET_NAME,
    cell: CONFIG.CELL,
    value: isFinite(value) ? value : raw,
    formattedValue: formattedValue,
    severity: severity,
    previousSeverity: previousSeverity,
    checkedAt: checkedAt,
    spreadsheetUrl: spreadsheetUrl
  }, snap);

  const notify = opts.alwaysNotify ||
    shouldNotify(previousSeverity, severity, CONFIG.NOTIFY_WHILE_UNCHANGED);

  if (!opts.dryRun) {
    props.setProperty(PROP_LAST_HOUR, hour);
    props.setProperty(PROP_LAST_SEVERITY, severity);
    props.setProperty(PROP_SNAP_STATE, JSON.stringify(snap.nextState));
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

  const subject = buildAlertSubject(payload.severity, payload.formattedValue, payload.sample, payload);
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
    text: buildAlertSubject(payload.severity, payload.formattedValue, payload.sample, payload),
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
        (payload.change && payload.change.label
          ? '<div style="font-size:15px;font-weight:bold;color:' + (
              payload.change.direction === 'INCREASE' ? '#D93025' :
              payload.change.direction === 'DECREASE' ? '#188038' : '#5F6368'
            ) + ';margin:0 0 10px">' +
              escapeHtml_((payload.change.short ? payload.change.short + ' · ' : '') + payload.change.label) +
            '</div>'
          : '') +
        '<p style="margin:0 0 14px;font-size:14px;line-height:1.45;color:#3C4043">' + escapeHtml_(theme.meaning) + '</p>' +
        buildSnapSectionHtml_(payload) +
        '<div style="font-size:12px;color:#5F6368;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">Threshold bands</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:16px">' +
          ladder +
        '</table>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#3C4043">' +
          rowHtml_('Sheet', payload.sheetName + '!' + payload.cell) +
          rowHtml_('Severity', change) +
          rowHtml_('Breach time', payload.durationLabel || '—') +
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
    'checked_at', 'value', 'formatted', 'severity', 'previous_severity',
    'change', 'breach_snaps', 'breach_time', 'notified'
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
    payload.change ? payload.change.label : '',
    payload.breachStreak || payload.recoveredAfterSnaps || 0,
    payload.durationLabel || '',
    notified ? 'yes' : 'no'
  ]);
}

function loadSnapState_(props) {
  const raw = props.getProperty(PROP_SNAP_STATE);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      Logger.log('Could not parse ' + PROP_SNAP_STATE + ': ' + err);
    }
  }
  return {
    value: null,
    severity: props.getProperty(PROP_LAST_SEVERITY) || 'NONE',
    checkedAt: '',
    breachStreak: 0,
    breachStartedAt: '',
    snaps: []
  };
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

function describeValueChange(previousValue, currentValue) {
  const prev = Number(previousValue);
  const curr = Number(currentValue);
  if (!isFinite(prev) || !isFinite(curr)) {
    return { direction: 'UNKNOWN', delta: null, label: 'No prior snap to compare', short: '' };
  }
  const delta = curr - prev;
  if (delta > 0) {
    return {
      direction: 'INCREASE',
      delta: delta,
      label: 'Increased vs last snap by ' + formatMillions(delta),
      short: '↑ +' + (delta / 1000000).toFixed(2) + 'mm'
    };
  }
  if (delta < 0) {
    return {
      direction: 'DECREASE',
      delta: delta,
      label: 'Decreased vs last snap by ' + formatMillions(Math.abs(delta)),
      short: '↓ −' + (Math.abs(delta) / 1000000).toFixed(2) + 'mm'
    };
  }
  return { direction: 'UNCHANGED', delta: 0, label: 'Unchanged vs last snap', short: '→ 0.00mm' };
}

function formatBreachDuration(streak, cleared) {
  const n = Number(streak) || 0;
  if (cleared) {
    if (n < 1) return 'Cleared — back at or below 3.5mm';
    return (
      'Cleared after ' + n + ' hourly snap' + (n === 1 ? '' : 's') +
      ' in breach (~' + n + ' hour' + (n === 1 ? '' : 's') + ')'
    );
  }
  if (n <= 1) return 'First hourly snap in breach';
  return 'Persistent — breaching across last ' + n + ' snaps (~' + n + ' hours)';
}

function applySnapshot(prevState, reading) {
  const prev = prevState || {};
  const change = describeValueChange(prev.value, reading.value);
  const prevSeverity = prev.severity || 'NONE';
  const currSeverity = reading.severity || 'NONE';
  const cleared = currSeverity === 'NONE' && prevSeverity !== 'NONE';

  let breachStreak = 0;
  let breachStartedAt = '';
  if (currSeverity !== 'NONE') {
    if (prevSeverity !== 'NONE') {
      breachStreak = (Number(prev.breachStreak) || 1) + 1;
      breachStartedAt = prev.breachStartedAt || prev.checkedAt || reading.checkedAt;
    } else {
      breachStreak = 1;
      breachStartedAt = reading.checkedAt;
    }
  }

  const snaps = (prev.snaps || []).slice(-4);
  snaps.push({
    checkedAt: reading.checkedAt,
    value: reading.value,
    severity: currSeverity
  });

  const recoveredAfterSnaps = cleared ? (Number(prev.breachStreak) || 1) : 0;
  const durationStreak = cleared ? recoveredAfterSnaps : breachStreak;

  return {
    change: change,
    breachStreak: breachStreak,
    breachStartedAt: breachStartedAt,
    previousValue: prev.value,
    previousSeverity: prevSeverity,
    previousCheckedAt: prev.checkedAt || '',
    lastSnaps: snaps.slice(-3),
    recoveredAfterSnaps: recoveredAfterSnaps,
    durationLabel: formatBreachDuration(durationStreak, currSeverity === 'NONE'),
    nextState: {
      value: reading.value,
      severity: currSeverity,
      checkedAt: reading.checkedAt,
      hour: reading.hour || '',
      breachStreak: breachStreak,
      breachStartedAt: breachStartedAt,
      snaps: snaps.slice(-5)
    }
  };
}

function buildAlertSubject(severity, formattedValue, sample, meta) {
  const prefix = sample ? '[SAMPLE] ' : '';
  meta = meta || {};
  const changeShort = meta.change && meta.change.short ? ' ' + meta.change.short : '';
  if (severity === 'NONE') {
    return prefix + '[CLEARED] Commodity bad debt Q37 back below 3.5mm — ' + formattedValue + changeShort;
  }
  const persist = meta.breachStreak >= 2
    ? ' Persistent ' + meta.breachStreak + ' snaps ·'
    : '';
  return prefix + '[' + severity + ']' + persist + ' Commodity bad debt Q37 = ' + formattedValue + changeShort;
}

function buildSnapSectionHtml_(payload) {
  const snaps = (payload.lastSnaps || []).slice(-2);
  if (snaps.length < 1) return '';
  let rows = '';
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const label = s.severity === 'NONE' ? 'OK' : s.severity;
    const isLast = i === snaps.length - 1;
    rows +=
      '<tr>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #E8EAED;color:#5F6368">' + escapeHtml_(s.checkedAt || '') + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #E8EAED;font-weight:bold">' + escapeHtml_(formatMillions(s.value)) + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid #E8EAED">' + escapeHtml_(label) + (isLast ? ' ← now' : '') + '</td>' +
      '</tr>';
  }
  const title = snaps.length >= 2 ? 'Last 2 snaps' : 'This snap';
  return (
    '<div style="font-size:12px;color:#5F6368;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">' + title + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:14px">' +
      '<tr>' +
        '<td style="padding:6px 10px;color:#5F6368;border-bottom:1px solid #E8EAED">Checked</td>' +
        '<td style="padding:6px 10px;color:#5F6368;border-bottom:1px solid #E8EAED">Q37</td>' +
        '<td style="padding:6px 10px;color:#5F6368;border-bottom:1px solid #E8EAED">Band</td>' +
      '</tr>' +
      rows +
    '</table>'
  );
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
  const url = SpreadsheetApp.getActiveSpreadsheet()
    ? SpreadsheetApp.getActiveSpreadsheet().getUrl()
    : 'https://docs.google.com/spreadsheets';
  const rows = [
    {
      key: 'amber',
      severity: 'AMBER',
      value: 3720000,
      checkedAt: '13 Aug 2026, 13:33 IST',
      prevState: { value: 1997916, severity: 'NONE', checkedAt: '13 Aug 2026, 12:33 IST', breachStreak: 0, snaps: [] }
    },
    {
      key: 'persist',
      severity: 'AMBER',
      value: 3910000,
      checkedAt: '13 Aug 2026, 14:33 IST',
      prevState: {
        value: 3720000,
        severity: 'AMBER',
        checkedAt: '13 Aug 2026, 13:33 IST',
        breachStreak: 1,
        breachStartedAt: '13 Aug 2026, 13:33 IST',
        snaps: [{ checkedAt: '13 Aug 2026, 13:33 IST', value: 3720000, severity: 'AMBER' }]
      }
    },
    {
      key: 'red',
      severity: 'RED',
      value: 4450000,
      checkedAt: '13 Aug 2026, 14:33 IST',
      prevState: {
        value: 3720000,
        severity: 'AMBER',
        checkedAt: '13 Aug 2026, 13:33 IST',
        breachStreak: 1,
        breachStartedAt: '13 Aug 2026, 13:33 IST',
        snaps: [{ checkedAt: '13 Aug 2026, 13:33 IST', value: 3720000, severity: 'AMBER' }]
      }
    },
    {
      key: 'black',
      severity: 'BLACK',
      value: 5820000,
      checkedAt: '13 Aug 2026, 15:33 IST',
      prevState: {
        value: 4450000,
        severity: 'RED',
        checkedAt: '13 Aug 2026, 14:33 IST',
        breachStreak: 2,
        breachStartedAt: '13 Aug 2026, 13:33 IST',
        snaps: [
          { checkedAt: '13 Aug 2026, 13:33 IST', value: 3720000, severity: 'AMBER' },
          { checkedAt: '13 Aug 2026, 14:33 IST', value: 4450000, severity: 'RED' }
        ]
      }
    },
    {
      key: 'cleared',
      severity: 'NONE',
      value: 1997916,
      checkedAt: '13 Aug 2026, 15:33 IST',
      prevState: {
        value: 3910000,
        severity: 'AMBER',
        checkedAt: '13 Aug 2026, 14:33 IST',
        breachStreak: 2,
        breachStartedAt: '13 Aug 2026, 13:33 IST',
        snaps: [
          { checkedAt: '13 Aug 2026, 13:33 IST', value: 3720000, severity: 'AMBER' },
          { checkedAt: '13 Aug 2026, 14:33 IST', value: 3910000, severity: 'AMBER' }
        ]
      }
    }
  ];
  return rows.map(function (spec) {
    const snap = applySnapshot(spec.prevState, {
      value: spec.value,
      severity: spec.severity,
      checkedAt: spec.checkedAt
    });
    return Object.assign({
      key: spec.key,
      metricLabel: CONFIG.METRIC_LABEL,
      sheetName: CONFIG.SHEET_NAME,
      cell: CONFIG.CELL,
      value: spec.value,
      formattedValue: formatMillions(spec.value),
      severity: spec.severity,
      checkedAt: spec.checkedAt,
      spreadsheetUrl: url,
      sample: true
    }, snap);
  });
}
