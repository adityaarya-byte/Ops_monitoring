/**
 * Parser + allowlist unit tests for Slack rejection alerts.
 * Run: node tests/parser.test.js
 */

const assert = require('assert');
const {
  parseSlackAlert,
  ParserUtils,
  AlertFilters,
  CB_CHANNEL_NAME
} = require('../src/parser');

const IF_CHANNEL = 'insufficient-funds-rails-mercury-rejections';
const CB_CHANNEL = CB_CHANNEL_NAME;
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

run('parses Production PROD Instrument/Symbol → SAPIENUSDT + insufficient reason', function () {
  const text =
    '`Production` [SPOT][PROD][INSUFFICIENT_FUNDS] Order rejected on Binance\n' +
    'Exchange: Binance\n' +
    'Instrument/Symbol: SAPIENUSDT\n' +
    'Side: SELL\n' +
    'Qty: 6486.6\n' +
    'OrderId: 1a0d8936-8604-11f1-a984-9b16c54d56ff\n' +
    'Account: account_1\n' +
    'Env: PROD\n' +
    'Error: -2010 — Account has insufficient balance for requested action.\n' +
    'Details:\n```\n{"code"=>-2010, "msg"=>"Account has insufficient balance for requested action."}\n```';

  const r = parseSlackAlert(text, TS, IF_CHANNEL)[0];
  assert.strictEqual(r.Token, 'SAPIENUSDT');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.ErrorCode, '-2010');
  assert.ok(r.Response.toLowerCase().indexOf('insufficient balance') !== -1);
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('parses bullet PRODUCTION Symbol → full B-S-HBAR_USDT', function () {
  const text =
    '[SPOT][PRODUCTION][INSUFFICIENT_FUNDS] Order rejected on Binance\n' +
    '• Exchange: `Binance`\n' +
    '• Symbol: `B-S-HBAR_USDT`\n' +
    '• Side: `SELL`\n' +
    '• Qty: `212476`\n' +
    '• OrderId: `1107579126`\n' +
    '• Account: `all`\n' +
    '• Env: `Mercury-Production`\n' +
    '• Error: `INSUFFICIENT_FUNDS` — No eligible account with sufficient balance after routing';

  const rows = parseSlackAlert(text, TS, IF_CHANNEL);
  assert.ok(rows && rows.length === 1, 'expected parse rows');
  const r = rows[0];
  assert.strictEqual(r.Token, 'B-S-HBAR_USDT');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Qty, '212476');
  assert.strictEqual(r.OrderId, '1107579126');
  assert.strictEqual(r.Account, 'all');
  assert.strictEqual(r.ErrorCode, 'INSUFFICIENT_FUNDS');
  assert.ok(r.Response.indexOf('INSUFFICIENT_FUNDS') !== -1);
  assert.ok(r.Response.toLowerCase().indexOf('no eligible account') !== -1);
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('parses bullet lines without backticks / with bold labels', function () {
  const text = [
    '[SPOT][PRODUCTION][INSUFFICIENT_FUNDS] Order rejected on Binance',
    '• *Exchange*: Binance',
    '• *Symbol*: B-S-HBAR_USDT',
    '• *Side*: SELL',
    '• *Qty*: 212476',
    '• *OrderId*: 1107573262',
    '• *Account*: all',
    '• *Env*: Mercury-Production',
    '• *Error*: INSUFFICIENT_FUNDS — No eligible account with sufficient balance after routing'
  ].join('\n');

  const r = parseSlackAlert(text, TS, IF_CHANNEL)[0];
  assert.strictEqual(r.Token, 'B-S-HBAR_USDT');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.OrderId, '1107573262');
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('parses Production Binance MANTAUSDT inline rejection', function () {
  const text =
    'Production Binance MANTAUSDT sell 7743.5 order 335b21d2-73ee-11f1-ba4e-73cd18228814, ' +
    'Account: account_6, rejected: response {"code"=>-2010, "msg"=>"Account has insufficient balance for requested action."}';

  const rows = parseSlackAlert(text, TS, IF_CHANNEL);
  assert.ok(rows && rows.length === 1);
  const r = rows[0];
  assert.strictEqual(r.Format, 'Inline-Production');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Token, 'MANTAUSDT');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Qty, '7743.5');
  assert.strictEqual(r.OrderId, '335b21d2-73ee-11f1-ba4e-73cd18228814');
  assert.strictEqual(r.Account, 'account_6');
  assert.ok(r.Response.toLowerCase().indexOf('insufficient balance') !== -1);
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('parses Gateio Could not CREATE with InsufficientFunds', function () {
  const text =
    'Mercury-Production Could not CREATE order on Gateio - ' +
    '{"version":1,"is_deleted":false,"created_at":1781337153401,"updated_at":1781337153401,' +
    '"created_by":0,"updated_by":0,"trace_id":"a151b82a2ad446d2acd51c2d224df800","id":123324974,' +
    '"client_id":0,"client_order_id":387518130,"latest_event_id":2,' +
    '"client_order_version_type":"CREATE","client_order_version_status":"IN_PROGRESS",' +
    '"instrument_id":3904,"conversion_instrument_id":0,"order_type":"LIMIT","side":"BUY",' +
    '"ordered_quantity":800,"ordered_price":0.1519,"converted_ordered_price":null,' +
    '"internal_metadata":null,"exchange_account_id":0,"exchange_order_id":"",' +
    '"exchange_order_status":"OPEN","executed_quantity":0,"time_in_force":"TIME_IN_FORCE_GTC",' +
    '"valid_till":1781337153345,"client_user_id":18764269}. ' +
    '{ description : rpc error: code = Unknown desc = {"name":"InsufficientFunds",' +
    '"message":"gate {\\"label\\":\\"BALANCE_NOT_ENOUGH\\",\\"message\\":\\"Not enough balance\\"}"} }';

  const r = parseSlackAlert(text, TS, 'Mercury')[0];
  assert.strictEqual(r.Exchange, 'Gateio');
  assert.strictEqual(r.Side, 'buy');
  assert.strictEqual(r.Qty, '800');
  assert.strictEqual(String(r.OrderId), '387518130');
  assert.ok(
    /not enough balance|insufficient/i.test(r.Response),
    'expected insufficient reason, got: ' + r.Response
  );
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('CB digest keeps only volatile lines; drops insufficient funds / something went wrong', function () {
  const text = [
    ':rotating_light: Insta / OTC Order Rejections',
    'Newly landed rejections: 7',
    'The market is too volatile right now. Please try again later: 3  something went wrong: 3  insufficient funds: 1',
    '',
    '• BTC sell | insufficient funds | user 500470e6-fb8d-4cde-aece-1de01b7d245f | 2026-07-22 20:04:50',
    '• FLT buy | The market is too volatile right now. Please try again later | user 01654dcd-f8e8-4c1d-8cc8-35409b6cc14c | 2026-07-22 19:55:17',
    '• FLT buy | The market is too volatile right now. Please try again later | user 01654dcd-f8e8-4c1d-8cc8-35409b6cc14c | 2026-07-22 19:54:28',
    '• ETH sell | something went wrong | user aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee | 2026-07-22 19:50:00'
  ].join('\n');

  const rows = parseSlackAlert(text, TS, CB_CHANNEL);
  assert.ok(rows);
  assert.strictEqual(rows.length, 2);
  rows.forEach(function (r) {
    assert.strictEqual(r.Token, 'FLT');
    assert.ok(AlertFilters.isVolatileReason(r.Response));
    assert.ok(AlertFilters.shouldKeepAlert(r));
  });
});

run('allowlist: non-CB non-insufficient reasons are dropped', function () {
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: 'alerts-exchange-funds',
      Response: 'Due to the order could not be filled immediately',
      ErrorCode: '',
      RawText: 'fill timeout'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: 'alerts-action-required-mercury',
      Response: 'Order action failed',
      ErrorCode: '',
      RawText: 'Could not CREATE order'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: IF_CHANNEL,
      Response: 'Account has insufficient balance for requested action.',
      ErrorCode: '-2010',
      RawText: 'INSUFFICIENT_FUNDS'
    }),
    true
  );
});

run('allowlist: CB keeps volatile only', function () {
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: CB_CHANNEL,
      Response: 'The market is too volatile right now. Please try again later',
      Format: 'CB-Digest'
    }),
    true
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: CB_CHANNEL,
      Response: 'insufficient funds',
      Format: 'CB-Digest'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: 'CB-Rejection',
      Response: 'something went wrong',
      Format: 'CB-Digest'
    }),
    false
  );
});

run('cleanSymbol keeps B-S- prefix', function () {
  assert.strictEqual(ParserUtils.cleanSymbol('B-S-HBAR_USDT'), 'B-S-HBAR_USDT');
  assert.strictEqual(ParserUtils.cleanSymbol('*B-S-HBAR_USDT*'), 'B-S-HBAR_USDT');
});

run('unmatched non-alert text returns null (not UNMATCHED junk)', function () {
  assert.strictEqual(parseSlackAlert('hello world nothing useful', TS, IF_CHANNEL), null);
});

if (!process.exitCode) {
  console.log('\nAll parser tests passed.');
}
