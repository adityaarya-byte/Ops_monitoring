/**
 * Pure helpers for Gold OI > 20x (Q37) commodity bad-debt alerts.
 * Keep in sync with the matching functions in
 * commodity-bad-debt-alert/Code.gs
 */

const THRESHOLDS = {
  AMBER: 3500000,
  RED: 4000000,
  BLACK: 5500000
};

const SEVERITY_RANK = {
  NONE: 0,
  AMBER: 1,
  RED: 2,
  BLACK: 3
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

const SAMPLE_ALERTS = [
  {
    key: 'amber',
    severity: 'AMBER',
    previousSeverity: 'NONE',
    value: 3720000
  },
  {
    key: 'red',
    severity: 'RED',
    previousSeverity: 'AMBER',
    value: 4450000
  },
  {
    key: 'black',
    severity: 'BLACK',
    previousSeverity: 'RED',
    value: 5820000
  },
  {
    key: 'cleared',
    severity: 'NONE',
    previousSeverity: 'AMBER',
    value: 1997916
  }
];

function classifySeverity(value, thresholds) {
  const t = thresholds || THRESHOLDS;
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

/**
 * Data refreshes :25–:32. Fire once in [checkMinute, checkMinute + window).
 */
function isInCheckWindow(minute, checkMinute, windowMinutes) {
  const m = Number(minute);
  const start = Number(checkMinute);
  const win = Number(windowMinutes);
  if (!isFinite(m) || !isFinite(start) || !isFinite(win) || win < 1) return false;
  return m >= start && m < start + win;
}

function hourKey(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  if (timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d);
    const get = function (type) {
      return parts.find(function (p) { return p.type === type; }).value;
    };
    return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour');
  }
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return y + '-' + mo + '-' + day + 'T' + h;
}

/**
 * Notify when severity changes, or hourly while still in an alert.
 * Recovery (BLACK/RED/AMBER → NONE) also notifies.
 */
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
  lines.push(opts.metricLabel || 'Gold OI greater than 20x (Bad Debt)');
  lines.push('Sheet: ' + (opts.sheetName || 'Commodity Bad debt') + '!' + (opts.cell || 'Q37'));
  lines.push('Value: ' + opts.formattedValue);
  lines.push('Severity: ' + opts.severity);
  lines.push('Thresholds: Amber > 3.5mm | Red > 4.0mm | Black > 5.5mm');
  if (opts.checkedAt) lines.push('Checked at: ' + opts.checkedAt);
  if (opts.spreadsheetUrl) lines.push('Sheet: ' + opts.spreadsheetUrl);
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSamplePayload(spec) {
  const formattedValue = formatMillions(spec.value);
  return {
    key: spec.key,
    metricLabel: 'Gold OI greater than 20x (Bad Debt)',
    sheetName: 'Commodity Bad debt',
    cell: 'Q37',
    value: spec.value,
    formattedValue: formattedValue,
    severity: spec.severity,
    previousSeverity: spec.previousSeverity,
    checkedAt: spec.checkedAt || '13 Aug 2026, 14:33 IST',
    spreadsheetUrl: spec.spreadsheetUrl || 'https://docs.google.com/spreadsheets',
    sample: true
  };
}

function getSamplePayloads() {
  return SAMPLE_ALERTS.map(buildSamplePayload);
}

/**
 * Gmail-safe HTML (tables + inline CSS) used by Apps Script MailApp.sendEmail.
 */
function buildEmailHtml(payload) {
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
          escapeHtml(b.label) +
        '</td>' +
        '<td style="padding:8px 10px;background:' + bg + ';color:' + fg + ';border-bottom:1px solid #E8EAED">' +
          escapeHtml(b.condition) + escapeHtml(mark) +
        '</td>' +
      '</tr>';
  }

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse">' +
      '<tr><td style="background:' + theme.color + ';color:' + theme.text + ';padding:20px 24px">' +
        '<div style="font-size:11px;letter-spacing:1.4px;font-weight:bold">COMMODITY BAD DEBT · Q37</div>' +
        '<div style="font-size:26px;font-weight:bold;margin-top:6px">' + escapeHtml(theme.badge) + '</div>' +
        '<div style="font-size:13px;margin-top:6px;opacity:0.92">' + escapeHtml(payload.metricLabel) + '</div>' +
      '</td></tr>' +
      '<tr><td style="padding:20px 24px;border:1px solid #E8EAED;border-top:0">' +
        '<div style="font-size:12px;color:#5F6368;text-transform:uppercase;letter-spacing:0.6px">Current value</div>' +
        '<div style="font-size:28px;font-weight:bold;color:#202124;margin:4px 0 2px">' + escapeHtml(payload.formattedValue) + '</div>' +
        '<p style="margin:12px 0 18px;font-size:14px;line-height:1.45;color:#3C4043">' + escapeHtml(theme.meaning) + '</p>' +
        '<div style="font-size:12px;color:#5F6368;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px">Threshold bands</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:16px">' +
          ladder +
        '</table>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#3C4043">' +
          emailRow('Sheet', payload.sheetName + '!' + payload.cell) +
          emailRow('Severity', change) +
          emailRow('Checked at', payload.checkedAt) +
        '</table>' +
        '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>' +
          '<td style="background:' + theme.color + ';border-radius:4px">' +
            '<a href="' + escapeHtml(payload.spreadsheetUrl) + '" style="display:inline-block;padding:10px 16px;color:' + theme.text + ';text-decoration:none;font-size:13px;font-weight:bold">Open spreadsheet</a>' +
          '</td>' +
        '</tr></table>' +
      '</td></tr>' +
    '</table>'
  );
}

function emailRow(label, value) {
  return (
    '<tr>' +
      '<td style="padding:3px 18px 3px 0;color:#5F6368;white-space:nowrap">' + escapeHtml(label) + '</td>' +
      '<td style="padding:3px 0;font-weight:bold">' + escapeHtml(String(value)) + '</td>' +
    '</tr>'
  );
}

module.exports = {
  THRESHOLDS,
  SEVERITY_RANK,
  SEVERITY_COLOR,
  SEVERITY_THEME,
  SAMPLE_ALERTS,
  classifySeverity,
  formatMillions,
  isInCheckWindow,
  hourKey,
  shouldNotify,
  buildAlertSubject,
  buildAlertText,
  escapeHtml,
  buildSamplePayload,
  getSamplePayloads,
  buildEmailHtml
};
