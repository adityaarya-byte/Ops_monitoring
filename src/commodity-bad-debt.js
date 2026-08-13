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
  NONE: '#34A853',
  AMBER: '#F9AB00',
  RED: '#D93025',
  BLACK: '#202124'
};

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

function buildAlertSubject(severity, formattedValue) {
  if (severity === 'NONE') {
    return '[CLEARED] Commodity bad debt Q37 back below 3.5mm — ' + formattedValue;
  }
  return '[' + severity + '] Commodity bad debt Q37 = ' + formattedValue;
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

module.exports = {
  THRESHOLDS,
  SEVERITY_RANK,
  SEVERITY_COLOR,
  classifySeverity,
  formatMillions,
  isInCheckWindow,
  hourKey,
  shouldNotify,
  buildAlertSubject,
  buildAlertText
};
