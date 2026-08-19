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
    Utilities: {},
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
    buildSummary: sandbox.buildSummary
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
