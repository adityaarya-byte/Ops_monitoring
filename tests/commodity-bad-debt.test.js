/**
 * Unit tests for Gold OI > 20x (Q37) commodity bad-debt alert helpers.
 * Run: node tests/commodity-bad-debt.test.js
 */

const assert = require('assert');
const {
  classifySeverity,
  formatMillions,
  isInCheckWindow,
  hourKey,
  shouldNotify,
  buildAlertSubject,
  buildEmailHtml,
  getSamplePayloads,
  applySnapshot,
  describeValueChange,
  formatBreachDuration,
  decideSend,
  SEVERITY_THEME,
  THRESHOLDS
} = require('../src/commodity-bad-debt');

function run(name, fn) {
  try {
    fn();
    console.log('✓ ' + name);
  } catch (e) {
    console.error('✗ ' + name);
    console.error('  ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

run('NONE at current screenshot value ~1.99mm', function () {
  assert.strictEqual(classifySeverity(1997916), 'NONE');
});

run('NONE at exactly 3.5mm (alert is greater-than, not >=)', function () {
  assert.strictEqual(classifySeverity(THRESHOLDS.AMBER), 'NONE');
});

run('AMBER just above 3.5mm', function () {
  assert.strictEqual(classifySeverity(3500001), 'AMBER');
});

run('AMBER at 3.9mm', function () {
  assert.strictEqual(classifySeverity(3900000), 'AMBER');
});

run('AMBER at exactly 4mm (Red is greater-than 4mm)', function () {
  assert.strictEqual(classifySeverity(THRESHOLDS.RED), 'AMBER');
});

run('RED just above 4mm', function () {
  assert.strictEqual(classifySeverity(4000001), 'RED');
});

run('RED at 5.0mm', function () {
  assert.strictEqual(classifySeverity(5000000), 'RED');
});

run('RED at exactly 5.5mm (Black is greater-than 5.5mm)', function () {
  assert.strictEqual(classifySeverity(THRESHOLDS.BLACK), 'RED');
});

run('BLACK just above 5.5mm', function () {
  assert.strictEqual(classifySeverity(5500001), 'BLACK');
});

run('non-numeric value is NONE', function () {
  assert.strictEqual(classifySeverity('#N/A'), 'NONE');
  assert.strictEqual(classifySeverity(''), 'NONE');
  assert.strictEqual(classifySeverity(null), 'NONE');
});

run('formatMillions shows mm + raw', function () {
  assert.strictEqual(formatMillions(1997916), '2.00mm (1,997,916)');
  assert.strictEqual(formatMillions(3500001), '3.50mm (3,500,001)');
});

run('check window is [33, 38) so :33–:37 fire and :32 / :38 do not', function () {
  assert.strictEqual(isInCheckWindow(32, 33, 5), false);
  assert.strictEqual(isInCheckWindow(33, 33, 5), true);
  assert.strictEqual(isInCheckWindow(37, 33, 5), true);
  assert.strictEqual(isInCheckWindow(38, 33, 5), false);
  assert.strictEqual(isInCheckWindow(0, 33, 5), false);
});

run('hourKey is stable per hour', function () {
  const a = hourKey(new Date('2026-08-13T08:33:00+05:30'), 'Asia/Kolkata');
  const b = hourKey(new Date('2026-08-13T08:37:00+05:30'), 'Asia/Kolkata');
  const c = hourKey(new Date('2026-08-13T09:01:00+05:30'), 'Asia/Kolkata');
  assert.strictEqual(a, b);
  assert.strictEqual(a, '2026-08-13T08');
  assert.notStrictEqual(a, c);
});

run('notify on first breach and on escalation', function () {
  assert.strictEqual(shouldNotify('NONE', 'AMBER', false), true);
  assert.strictEqual(shouldNotify('AMBER', 'RED', false), true);
  assert.strictEqual(shouldNotify('RED', 'BLACK', false), true);
});

run('notify on recovery / de-escalation', function () {
  assert.strictEqual(shouldNotify('BLACK', 'RED', false), true);
  assert.strictEqual(shouldNotify('AMBER', 'NONE', false), true);
});

run('skip repeat NONE; optional hourly reminder while still alerting', function () {
  assert.strictEqual(shouldNotify('NONE', 'NONE', true), false);
  assert.strictEqual(shouldNotify('AMBER', 'AMBER', false), false);
  assert.strictEqual(shouldNotify('AMBER', 'AMBER', true), true);
});

run('no hourly green while under limit; one CLEARED after a breach', function () {
  assert.deepStrictEqual(decideSend('NONE', 'NONE', { isMorning: false }), { send: false, kind: 'SKIP' });
  assert.deepStrictEqual(decideSend('NONE', 'AMBER', { isMorning: false }), { send: true, kind: 'BREACH' });
  assert.deepStrictEqual(decideSend('AMBER', 'AMBER', { isMorning: false }), { send: false, kind: 'SKIP' });
  assert.deepStrictEqual(decideSend('AMBER', 'NONE', { isMorning: false }), { send: true, kind: 'CLEARED' });
});

run('9 AM always sends: green daily or still-breaching status', function () {
  assert.deepStrictEqual(decideSend('NONE', 'NONE', { isMorning: true }), { send: true, kind: 'DAILY' });
  assert.deepStrictEqual(decideSend('AMBER', 'AMBER', { isMorning: true }), { send: true, kind: 'DAILY_BREACH' });
  assert.deepStrictEqual(decideSend('AMBER', 'NONE', { isMorning: true }), { send: true, kind: 'CLEARED' });
});

run('subject includes severity and value', function () {
  const s = buildAlertSubject('RED', '4.20mm (4,200,000)');
  assert.ok(s.indexOf('[RED]') === 0);
  assert.ok(s.indexOf('4.20mm') !== -1);
});

run('cleared subject when back below amber', function () {
  const s = buildAlertSubject('NONE', '2.00mm (1,997,916)');
  assert.ok(s.indexOf('[CLEARED]') === 0);
});

run('sample subject is prefixed so it is not confused with live alerts', function () {
  const s = buildAlertSubject('AMBER', '3.72mm (3,720,000)', true);
  assert.ok(s.indexOf('[SAMPLE] [AMBER]') === 0);
});

run('increase / decrease vs last snap', function () {
  assert.strictEqual(describeValueChange(3720000, 3910000).direction, 'INCREASE');
  assert.strictEqual(describeValueChange(3910000, 1997916).direction, 'DECREASE');
  assert.strictEqual(describeValueChange(3720000, 3720000).direction, 'UNCHANGED');
  assert.ok(describeValueChange(3720000, 3910000).short.indexOf('+0.19mm') !== -1);
});

run('first breach is snap 1; second still-breaching snap is persistent 2 hours', function () {
  const first = applySnapshot(
    { value: 1997916, severity: 'NONE', checkedAt: '13:33', breachStreak: 0, snaps: [] },
    { value: 3720000, severity: 'AMBER', checkedAt: '14:33' }
  );
  assert.strictEqual(first.breachStreak, 1);
  assert.strictEqual(first.durationLabel, 'First hourly snap in breach');
  assert.strictEqual(first.change.direction, 'INCREASE');

  const second = applySnapshot(first.nextState, { value: 3910000, severity: 'AMBER', checkedAt: '15:33' });
  assert.strictEqual(second.breachStreak, 2);
  assert.ok(second.durationLabel.indexOf('last 2 snaps') !== -1);
  assert.strictEqual(second.change.direction, 'INCREASE');
  assert.strictEqual(second.lastSnaps.length, 2);
});

run('third snap back below 3.5mm is green cleared and shows decrease', function () {
  const persist = applySnapshot(
    { value: 3720000, severity: 'AMBER', checkedAt: '13:33', breachStreak: 1, snaps: [{ checkedAt: '13:33', value: 3720000, severity: 'AMBER' }] },
    { value: 3910000, severity: 'AMBER', checkedAt: '14:33' }
  );
  const cleared = applySnapshot(persist.nextState, { value: 1997916, severity: 'NONE', checkedAt: '15:33' });
  assert.strictEqual(cleared.breachStreak, 0);
  assert.strictEqual(cleared.recoveredAfterSnaps, 2);
  assert.ok(cleared.durationLabel.indexOf('Cleared after 2') !== -1);
  assert.strictEqual(cleared.change.direction, 'DECREASE');
});

run('persist duration copy', function () {
  assert.strictEqual(formatBreachDuration(1, false), 'First hourly snap in breach');
  assert.strictEqual(formatBreachDuration(2, false), 'Persistent — breaching across last 2 snaps (~2 hours)');
  assert.ok(formatBreachDuration(2, true).indexOf('Cleared after 2') === 0);
});

run('sample payloads cover daily / first / persist / red / black / cleared', function () {
  const samples = getSamplePayloads();
  assert.strictEqual(samples.length, 6);
  const byKey = {};
  samples.forEach(function (p) { byKey[p.key] = p; });

  const daily = buildEmailHtml(byKey.daily);
  assert.ok(daily.indexOf('9 AM STATUS') !== -1);
  assert.ok(buildAlertSubject(byKey.daily.severity, byKey.daily.formattedValue, false, byKey.daily).indexOf('[OK] 9 AM') === 0);

  const amber = buildEmailHtml(byKey.amber);
  assert.ok(amber.indexOf('AMBER ALERT') !== -1);
  assert.ok(amber.indexOf(SEVERITY_THEME.AMBER.color) !== -1);
  assert.ok(amber.indexOf('&gt; 3.5mm') !== -1);
  assert.ok(amber.indexOf('← current') !== -1);
  assert.ok(amber.indexOf('First hourly snap in breach') !== -1);

  const persist = buildEmailHtml(byKey.persist);
  assert.ok(persist.indexOf('Last 2 snaps') !== -1);
  assert.ok(persist.indexOf('Increased vs last snap') !== -1);
  assert.ok(persist.indexOf('9 AM') !== -1);

  const red = buildEmailHtml(byKey.red);
  assert.ok(red.indexOf('RED ALERT') !== -1);
  assert.ok(red.indexOf(SEVERITY_THEME.RED.color) !== -1);

  const black = buildEmailHtml(byKey.black);
  assert.ok(black.indexOf('BLACK ALERT') !== -1);
  assert.ok(black.indexOf(SEVERITY_THEME.BLACK.color) !== -1);
  assert.ok(black.indexOf('&gt; 5.5mm') !== -1);

  const cleared = buildEmailHtml(byKey.cleared);
  assert.ok(cleared.indexOf('CLEARED') !== -1);
  assert.ok(cleared.indexOf(SEVERITY_THEME.NONE.color) !== -1);
  assert.ok(cleared.indexOf('1,997,916') !== -1);
  assert.ok(cleared.indexOf('Decreased vs last snap') !== -1);
  assert.ok(cleared.indexOf('Cleared after 2') !== -1);
});

if (!process.exitCode) {
  console.log('\nAll commodity bad-debt alert tests passed.');
}
