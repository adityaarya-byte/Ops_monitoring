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

run('subject includes severity and value', function () {
  const s = buildAlertSubject('RED', '4.20mm (4,200,000)');
  assert.ok(s.indexOf('[RED]') === 0);
  assert.ok(s.indexOf('4.20mm') !== -1);
});

run('cleared subject when back below amber', function () {
  const s = buildAlertSubject('NONE', '2.00mm (1,997,916)');
  assert.ok(s.indexOf('[CLEARED]') === 0);
});

if (!process.exitCode) {
  console.log('\nAll commodity bad-debt alert tests passed.');
}
