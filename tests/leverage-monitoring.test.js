'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function loadLogic() {
  var code = fs.readFileSync(path.join(__dirname, '..', 'leverage-monitoring', 'Code.gs'), 'utf8');
  var sandbox = {
    ScriptApp: { WeekDay: { MONDAY: 'MONDAY' } },
    SpreadsheetApp: {},
    MailApp: {},
    Utilities: { sleep: function () {} },
    Logger: { log: function () {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    CONFIG: sandbox.CONFIG,
    toNumber: sandbox.toNumber,
    safeDiv: sandbox.safeDiv,
    isAboveNotionalFloor: sandbox.isAboveNotionalFloor,
    mapHeaders: sandbox.mapHeaders,
    evaluateRow: sandbox.evaluateRow,
    buildSummary: sandbox.buildSummary,
    isIgnoredSymbol: sandbox.isIgnoredSymbol,
    masterActionColor: sandbox.masterActionColor,
    rowBackgrounds: sandbox.rowBackgrounds,
    isTransientSpreadsheetError: sandbox.isTransientSpreadsheetError,
    withSpreadsheetRetry: sandbox.withSpreadsheetRetry
  };
}

var logic = loadLogic();

var COLS = {
  symbol: 0,
  dcxOnBinance: 1,
  volatilityType: 2,
  maxNotional: 3,
  userPosition: 4,
  userPositionPrior: 5,
  highestSingleUser: 6
};

function row(overrides) {
  var base = {
    symbol: 'TESTUSDT',
    dcxOnBinance: 1000000,
    volatilityType: 'mid',
    maxNotional: 500000,
    userPosition: 100000,
    userPositionPrior: 100000,
    highestSingleUser: 50000
  };
  Object.keys(overrides || {}).forEach(function (k) { base[k] = overrides[k]; });
  return [
    base.symbol,
    base.dcxOnBinance,
    base.volatilityType,
    base.maxNotional,
    base.userPosition,
    base.userPositionPrior,
    base.highestSingleUser
  ];
}

function evalRow(overrides) {
  return logic.evaluateRow(row(overrides), COLS);
}

function assertIncludes(actual, expected, msg) {
  assert.ok(String(actual).indexOf(expected) !== -1, msg || (actual + ' should include ' + expected));
}

var passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

test('1-CRITICAL when utilization >= 100% and max notional > 450000', function () {
  var r = evalRow({ maxNotional: 500000, userPosition: 500000, userPositionPrior: 400000 });
  assert.strictEqual(r.utilizationStatus, 'CRITICAL - BREACH');
  assertIncludes(r.master, '1-CRITICAL');
});

test('not 1-CRITICAL when utilization >= 100% but max notional is 450000 or less', function () {
  var atFloor = evalRow({ maxNotional: 450000, userPosition: 450000, userPositionPrior: 400000, highestSingleUser: 1000 });
  assert.strictEqual(atFloor.utilizationStatus, 'CRITICAL - BREACH');
  assert.ok(atFloor.master.indexOf('1-CRITICAL') !== 0, atFloor.master);
  assertIncludes(atFloor.master, '3-WATCH');

  var below = evalRow({ maxNotional: 200000, userPosition: 250000, userPositionPrior: 180000, highestSingleUser: 1000 });
  assert.strictEqual(below.utilizationStatus, 'CRITICAL - BREACH');
  assertIncludes(below.master, '3-WATCH');
});

test('exactly 450001 max notional with 100% util is 1-CRITICAL', function () {
  var r = evalRow({ maxNotional: 450001, userPosition: 450001, userPositionPrior: 400000 });
  assertIncludes(r.master, '1-CRITICAL');
});

test('underutilized 2 weeks and max notional > 450000 -> reduce tier on DCX', function () {
  var r = evalRow({
    maxNotional: 800000,
    userPosition: 100,
    userPositionPrior: 200,
    highestSingleUser: 50,
    dcxOnBinance: 1000000
  });
  assert.strictEqual(r.underutilStatus, 'WARNING - Reduce Tier on DCX');
  assertIncludes(r.master, '4-ACTION');
  assertIncludes(r.master, 'reduce tier on DCX');
});

test('underutilized 2 weeks but max notional <= 450000 is not a reduce-tier action', function () {
  var r = evalRow({
    maxNotional: 400000,
    userPosition: 10,
    userPositionPrior: 10,
    highestSingleUser: 5,
    dcxOnBinance: 1000000
  });
  assert.strictEqual(r.underutilStatus, 'OK');
  assert.strictEqual(r.master, 'OK');
});

test('underutilized at exactly 450000 is not a reduce-tier action', function () {
  var r = evalRow({
    maxNotional: 450000,
    userPosition: 10,
    userPositionPrior: 10,
    highestSingleUser: 5,
    dcxOnBinance: 1000000
  });
  assert.strictEqual(r.underutilStatus, 'OK');
  assert.strictEqual(r.master, 'OK');
});

test('concentration vs DCX still wins over underutil', function () {
  var r = evalRow({
    maxNotional: 800000,
    userPosition: 100,
    userPositionPrior: 100,
    highestSingleUser: 800000,
    dcxOnBinance: 1000000
  });
  assertIncludes(r.master, '2-WARNING');
  assertIncludes(r.master, 'DCX Binance');
});

test('watch still fires for 70-100% utilization above the notional floor', function () {
  var r = evalRow({
    maxNotional: 800000,
    userPosition: 600000,
    userPositionPrior: 500000,
    highestSingleUser: 10000
  });
  assert.strictEqual(r.utilizationStatus, 'WARNING');
  assertIncludes(r.master, '3-WATCH');
});

test('buildSummary buckets the new reduce-tier action as underutilized', function () {
  var critical = evalRow({ maxNotional: 500000, userPosition: 500000, userPositionPrior: 400000 });
  var reduce = evalRow({
    symbol: 'LOWUSDT',
    maxNotional: 800000,
    userPosition: 100,
    userPositionPrior: 200,
    highestSingleUser: 50,
    dcxOnBinance: 1000000
  });
  var summary = logic.buildSummary([critical, reduce]);
  assert.strictEqual(summary.critical.length, 1);
  assert.strictEqual(summary.underutilized.length, 1);
  assert.strictEqual(summary.underutilized[0].symbol, 'LOWUSDT');
});

test('isIgnoredSymbol matches IGNORE_SYMBOLS case-insensitively', function () {
  var original = logic.CONFIG.IGNORE_SYMBOLS;
  logic.CONFIG.IGNORE_SYMBOLS = ['BTCUSDT', 'ethusdt'];
  try {
    assert.strictEqual(logic.isIgnoredSymbol('BTCUSDT'), true);
    assert.strictEqual(logic.isIgnoredSymbol('btcusdt'), true);
    assert.strictEqual(logic.isIgnoredSymbol(' ETHUSDT '), true);
    assert.strictEqual(logic.isIgnoredSymbol('SOLUSDT'), false);
    assert.strictEqual(logic.isIgnoredSymbol(''), false);
  } finally {
    logic.CONFIG.IGNORE_SYMBOLS = original;
  }
});

test('masterActionColor maps each priority to the Live Checks row color', function () {
  assert.strictEqual(logic.masterActionColor('1-CRITICAL: Capacity breach'), '#F8CBCB');
  assert.strictEqual(logic.masterActionColor('2-WARNING: cap user'), '#FDE9C8');
  assert.strictEqual(logic.masterActionColor('3-WATCH: Utilization >70%'), '#FDE9C8');
  assert.strictEqual(logic.masterActionColor('4-ACTION: Underutilized 2wks - reduce tier on DCX'), '#EFEFEF');
  assert.strictEqual(logic.masterActionColor('OK'), '#D9EAD3');
});

test('rowBackgrounds paints every cell in a row the same master color', function () {
  var rows = [
    ['A', '', '', '', '', '', '', '', '', '', '', '', '', '', '1-CRITICAL: x'],
    ['B', '', '', '', '', '', '', '', '', '', '', '', '', '', 'OK']
  ];
  var bg = logic.rowBackgrounds(rows, 3);
  assert.strictEqual(JSON.stringify(bg), JSON.stringify([
    ['#F8CBCB', '#F8CBCB', '#F8CBCB'],
    ['#D9EAD3', '#D9EAD3', '#D9EAD3']
  ]));
});

test('withSpreadsheetRetry retries timeouts then succeeds', function () {
  var calls = 0;
  var value = logic.withSpreadsheetRetry(function () {
    calls += 1;
    if (calls < 3) {
      throw new Error('Service Spreadsheets timed out while accessing document with id abc');
    }
    return 'ok';
  });
  assert.strictEqual(value, 'ok');
  assert.strictEqual(calls, 3);
});

test('isTransientSpreadsheetError matches the live timeout message', function () {
  assert.strictEqual(logic.isTransientSpreadsheetError(
    new Error('Service Spreadsheets timed out while accessing document with id 12VW3y_MEDK_zZy7zI5xumTahPc4lvyzfvf3ZTGex2cg.')
  ), true);
  assert.strictEqual(logic.isTransientSpreadsheetError(new Error('Could not find a column for: symbol')), false);
});

test('mapHeaders still finds Max Notional to Users', function () {
  var idx = logic.mapHeaders([
    'symbol',
    'DCX on Binance',
    'volatility_type',
    'Max Notional to Users',
    'User Position',
    'User Position Prior Week',
    'Highest Single User Position'
  ]);
  assert.strictEqual(idx.maxNotional, 3);
});

console.log('\n' + passed + ' tests passed');
