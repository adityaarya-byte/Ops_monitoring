/**
 * Parser unit tests for Slack insufficient-funds / rejection alerts.
 * Run: node tests/parser.test.js
 */

const assert = require('assert');
const { parseSlackAlert, ParserUtils } = require('../src/parser');

const CHANNEL = 'insufficient-funds-rails-mercury-rejections';
const TS = new Date('2026-07-23T10:00:00Z');

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

run('parses Production PROD inline Instrument/Symbol alert', function () {
  const text =
    '`Production` [SPOT][PROD][INSUFFICIENT_FUNDS] Order rejected on Binance ' +
    'Exchange: Binance Instrument/Symbol: SAPIENUSDT Side: SELL Qty: 6486.6 ' +
    'OrderId: 1a0d8936-8604-11f1-a984-9b16c54d56ff Account: account_1 Env: PROD ' +
    'Error: -2010 — Account has insufficient balance for requested action. Details:\n' +
    '```\n{"code"=>-2010, "msg"=>"Account has insufficient balance for requested action."}\n```';

  const rows = parseSlackAlert(text, TS, CHANNEL);
  assert.ok(rows && rows.length === 1);
  const r = rows[0];
  assert.strictEqual(r.Format, 'Key-Value');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Token, 'SAPIENUSDT');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Qty, '6486.6');
  assert.strictEqual(r.OrderId, '1a0d8936-8604-11f1-a984-9b16c54d56ff');
  assert.strictEqual(r.Account, 'account_1');
  assert.strictEqual(r.ErrorCode, '-2010');
  assert.ok(r.Response.toLowerCase().indexOf('insufficient balance') !== -1);
  assert.ok(r.Token.indexOf('*') === -1);
  assert.ok(r.Exchange.indexOf('*') === -1);
});

run('parses bullet PRODUCTION alert and keeps full B-S-HBAR_USDT symbol', function () {
  const text =
    '`[SPOT][PRODUCTION][INSUFFICIENT_FUNDS]` Order rejected on Binance ' +
    '• Exchange: `Binance` • Symbol: `B-S-HBAR_USDT` • Side: `SELL` • Qty: `212476` ' +
    '• OrderId: `1107579126` • Account: `all` • Env: `Mercury-Production` ' +
    '• Error: `INSUFFICIENT_FUNDS` — No eligible account with sufficient balance after routing';

  const rows = parseSlackAlert(text, TS, CHANNEL);
  assert.ok(rows && rows.length === 1);
  const r = rows[0];
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Token, 'B-S-HBAR_USDT'); // must NOT become HBAR_USDT
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Qty, '212476');
  assert.strictEqual(r.OrderId, '1107579126');
  assert.strictEqual(r.Account, 'all');
  assert.strictEqual(r.ErrorCode, 'INSUFFICIENT_FUNDS');
  assert.ok(r.Response.toLowerCase().indexOf('no eligible account') !== -1);
  assert.ok(!/\*/.test(r.Token + r.Exchange + r.Side + r.Account));
});

run('strips Slack bold asterisks from field values', function () {
  const text =
    'Order rejected on *Gateio* Exchange: *Gateio* Symbol: *BTC_USDT* Side: *SELL* ' +
    'Qty: *1.5* OrderId: *abc-123* Account: *acct* Error: `BALANCE` — *not enough*';

  const rows = parseSlackAlert(text, TS, CHANNEL);
  const r = rows[0];
  assert.strictEqual(r.Exchange, 'Gateio');
  assert.strictEqual(r.Token, 'BTC_USDT');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Qty, '1.5');
  assert.strictEqual(r.OrderId, 'abc-123');
  assert.strictEqual(r.Account, 'acct');
  assert.ok(r.Token.indexOf('*') === -1);
});

run('cleanSymbol keeps B-S- prefix', function () {
  assert.strictEqual(ParserUtils.cleanSymbol('B-S-HBAR_USDT'), 'B-S-HBAR_USDT');
  assert.strictEqual(ParserUtils.cleanSymbol('*B-S-HBAR_USDT*'), 'B-S-HBAR_USDT');
  assert.strictEqual(ParserUtils.cleanSymbol('`B-S-HBAR_USDT`'), 'B-S-HBAR_USDT');
});

run('multiline Instrument/Symbol format still parses', function () {
  const text = [
    'Order rejected on Binance',
    'Exchange: Binance',
    'Instrument/Symbol: SAPIENUSDT',
    'Side: SELL',
    'Qty: 6486.6',
    'OrderId: 1a0d8936-8604-11f1-a984-9b16c54d56ff',
    'Account: account_1',
    'Env: PROD',
    'Error: -2010 — Account has insufficient balance for requested action.'
  ].join('\n');

  const r = parseSlackAlert(text, TS, CHANNEL)[0];
  assert.strictEqual(r.Token, 'SAPIENUSDT');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.OrderId, '1a0d8936-8604-11f1-a984-9b16c54d56ff');
});

if (!process.exitCode) {
  console.log('\nAll parser tests passed.');
}
