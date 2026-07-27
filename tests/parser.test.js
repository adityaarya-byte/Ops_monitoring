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
const EXCHANGE_FUNDS = 'alerts-exchange-funds';
const ACTION_MERCURY = 'alerts-action-required-mercury';
const FUNDS_MERCURY = 'alerts-exchange-funds-mercury';
const TS = new Date('2026-07-23T10:00:00Z');

function formatDateLocal(d) {
  const dt = new Date(d);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return (
    dt.getFullYear() +
    pad(dt.getMonth() + 1) +
    pad(dt.getDate()) +
    pad(dt.getHours()) +
    pad(dt.getMinutes()) +
    pad(dt.getSeconds())
  );
}

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

run('parses Gateio Could not CREATE with InsufficientFunds → Token=instrument map', function () {
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

  const helpers = {
    resolveInstrumentToken: function (id) {
      return String(id) === '3904' ? '3904_SOMEINR' : String(id || '');
    }
  };
  const r = parseSlackAlert(text, TS, ACTION_MERCURY, helpers)[0];
  assert.strictEqual(r.Exchange, 'Gateio');
  assert.strictEqual(r.Format, 'JSON-Action');
  assert.strictEqual(r.Token, '3904_SOMEINR');
  assert.strictEqual(r.Side, 'buy');
  assert.strictEqual(r.Qty, '800');
  assert.strictEqual(String(r.OrderId), '387518130');
  assert.ok(
    /not enough balance|insufficient/i.test(r.Response),
    'expected insufficient reason, got: ' + r.Response
  );
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('INSTA ORDER_REJECTED with Error: 500000 — uses ruby :reason', function () {
  const text =
    '[INSTA] ORDER_REJECTED on KC\n' +
    'Exchange: KC\n' +
    'Instrument/Symbol: SAFEUSDT\n' +
    'Side: BUY\n' +
    'Qty: 10\n' +
    'OrderId: ord-safe-1\n' +
    'Account: insta\n' +
    'Error: 500000 —\n' +
    'Details:\n{:reason=>"Something went wrong", :code=>500000}';

  const r = parseSlackAlert(text, TS, FUNDS_MERCURY)[0];
  assert.strictEqual(r.Format, 'INSTA-Key-Value');
  assert.strictEqual(r.Response, 'Something went wrong');
  assert.strictEqual(r.Token, 'SAFEUSDT');
  assert.strictEqual(r.Exchange, 'KC');
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('Insta.InternalTpOrder MYRIAINR → Insta-InternalTp', function () {
  const text =
    'Production For Insta.InternalTpOrder: Internal Exchange MYRIAINR sell Otc::Order did not succeeded, ' +
    '{"orderId"=>"otp-123"}';

  const rows = parseSlackAlert(text, TS, EXCHANGE_FUNDS);
  assert.ok(rows && rows.length === 1);
  const r = rows[0];
  assert.strictEqual(r.Format, 'Insta-InternalTp');
  assert.strictEqual(r.Token, 'MYRIAINR');
  assert.strictEqual(r.Exchange, 'Internal');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Response, 'Otc::Order did not succeeded');
  assert.strictEqual(r.OrderId, 'otp-123');
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('Format C: Kucoin RAIN_USDT strips KC-S- prefix via tokenFromPrefixedInstrument', function () {
  const text =
    'Mercury-Production Insufficient balance for Kucoin accounts: all - 413779298 KC-S-RAIN_USDT SELL 27720';

  const r = parseSlackAlert(text, TS, FUNDS_MERCURY)[0];
  assert.strictEqual(r.Format, 'Inline-Text');
  assert.strictEqual(r.Token, 'RAIN_USDT');
  assert.strictEqual(r.Exchange, 'Kucoin');
  assert.strictEqual(r.Side, 'sell');
  assert.strictEqual(r.Qty, '27720');
  assert.strictEqual(r.Account, '413779298');
  const tsKey = formatDateLocal(TS);
  assert.strictEqual(r.OrderId, 'RAIN_USDT_Kucoin_' + tsKey + '_C');
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('Format D: Binance CREATE uses instrument_id token + insufficient message', function () {
  const text =
    'Could not CREATE order on Binance - ' +
    '{"version":1,"trace_id":"trace-binance-abc","id":99,"client_order_id":"co-1",' +
    '"instrument_id":12,"side":"SELL","ordered_quantity":5,"exchange_account_id":3}. ' +
    '{"message":"binance Account has insufficient balance for requested action."}';

  const helpers = {
    resolveInstrumentToken: function (id) {
      return String(id) === '12' ? '12_BTCINR' : String(id || '');
    }
  };
  const r = parseSlackAlert(text, TS, ACTION_MERCURY, helpers)[0];
  assert.strictEqual(r.Format, 'JSON-Action');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Token, '12_BTCINR');
  assert.ok(r.Response.toLowerCase().indexOf('insufficient balance') !== -1);
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('Format D: Binance InvalidOrder PERCENT_PRICE maps instrument_id', function () {
  const text =
    'Mercury-Production Could not CREATE order on Binance - ' +
    '{"version":1,"is_deleted":false,"created_at":1784804866570,"updated_at":1784804866570,' +
    '"created_by":0,"updated_by":0,"trace_id":"6f67ee23d21a4fd297a75703e1a39925","id":825756489,' +
    '"client_id":0,"client_order_id":1120689853,"latest_event_id":2,' +
    '"client_order_version_type":"CREATE","client_order_version_status":"IN_PROGRESS",' +
    '"instrument_id":1343,"conversion_instrument_id":0,"order_type":"LIMIT","side":"SELL",' +
    '"ordered_quantity":280,"ordered_price":0.61,"converted_ordered_price":null,' +
    '"internal_metadata":null,"exchange_account_id":0,"exchange_order_id":"",' +
    '"exchange_order_status":"OPEN","executed_quantity":0,"time_in_force":"TIME_IN_FORCE_GTC",' +
    '"valid_till":1784804866526,"client_user_id":10070925}. ' +
    '{ description : rpc error: code = Unknown desc = {"name":"InvalidOrder",' +
    '"message":"binance Filter failure: PERCENT_PRICE_BY_SIDE"} }';

  const helpers = {
    resolveInstrumentToken: function (id) {
      return String(id) === '1343' ? '1343_XYZINR' : String(id || '');
    }
  };
  const r = parseSlackAlert(text, TS, ACTION_MERCURY, helpers)[0];
  assert.strictEqual(r.Format, 'JSON-Action');
  assert.strictEqual(r.Exchange, 'Binance');
  assert.strictEqual(r.Token, '1343_XYZINR');
  assert.strictEqual(r.ErrorCode, 'InvalidOrder');
  assert.ok(/PERCENT_PRICE_BY_SIDE/i.test(r.Response), 'got: ' + r.Response);
  assert.ok(AlertFilters.shouldKeepAlert(r));
});

run('Format D: without helper falls back to bare instrument_id', function () {
  const text =
    'Could not CREATE order on Binance - ' +
    '{"version":1,"trace_id":"t1","client_order_id":"c1","instrument_id":1212,"side":"BUY","ordered_quantity":1}. ' +
    '{"message":"binance Filter failure: PERCENT_PRICE_BY_SIDE"}';
  const r = parseSlackAlert(text, TS, ACTION_MERCURY)[0];
  assert.strictEqual(r.Token, '1212');
});

run('Format D: Coindcx CREATE returns null', function () {
  const text =
    'Could not CREATE order on Coindcx - ' +
    '{"version":1,"trace_id":"trace-cdc","client_order_id":"x","side":"BUY","ordered_quantity":1}';
  assert.strictEqual(parseSlackAlert(text, TS, ACTION_MERCURY), null);
});

run('Futures Order rejected on alerts-exchange-funds → null', function () {
  const text =
    'Production Futures Order rejected: abc123 Instrument: BTCUSDT ' +
    '{"code"=>-2010, "msg"=>"Account has insufficient balance for requested action."}';
  assert.strictEqual(parseSlackAlert(text, TS, EXCHANGE_FUNDS), null);
});

run('CB digest keeps volatile + something went wrong; drops insufficient funds', function () {
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
  assert.strictEqual(rows.length, 3);
  const tokens = rows.map(function (r) { return r.Token; }).sort();
  assert.deepStrictEqual(tokens, ['ETH', 'FLT', 'FLT']);
  const sww = rows.filter(function (r) { return /something went wrong/i.test(r.Response); });
  assert.strictEqual(sww.length, 1);
  assert.strictEqual(sww[0].Token, 'ETH');
  assert.strictEqual(sww[0].Response, 'Something went wrong');
  rows.forEach(function (r) {
    assert.ok(AlertFilters.isCbKeepReason(r.Response));
    assert.ok(AlertFilters.shouldKeepAlert(r));
  });
});

run('allowlist: per-channel keep rules', function () {
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: EXCHANGE_FUNDS,
      Response: 'Due to the order could not be filled immediately',
      ErrorCode: '',
      RawText: 'fill timeout'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: EXCHANGE_FUNDS,
      Format: 'Insta-InternalTp',
      Response: 'Otc::Order did not succeeded',
      RawText: 'Insta.InternalTpOrder Otc::Order did not succeeded'
    }),
    true
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: EXCHANGE_FUNDS,
      Response: 'x',
      RawText: 'Futures Order rejected: 1'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: EXCHANGE_FUNDS,
      Response: 'x',
      RawText: 'Total unsettled Conversion order Requests: 3'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: FUNDS_MERCURY,
      Response: 'Something went wrong',
      RawText: 'ORDER_REJECTED'
    }),
    true
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: ACTION_MERCURY,
      Format: 'JSON-Action',
      Exchange: 'Binance',
      Response: 'Order action failed',
      RawText: 'Could not CREATE order on Binance'
    }),
    true
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: ACTION_MERCURY,
      Format: 'JSON-Action',
      Exchange: 'Coindcx',
      Response: 'Order action failed',
      RawText: 'Could not CREATE order on Coindcx'
    }),
    false
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: ACTION_MERCURY,
      Response: 'Order action failed',
      ErrorCode: '',
      RawText: 'Could not CREATE order'
    }),
    true // non-Coindcx action-required keeps all parsed
  );
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: EXCHANGE_FUNDS,
      Response: 'Account has insufficient balance for requested action.',
      ErrorCode: '-2010',
      RawText: 'INSUFFICIENT_FUNDS Order rejected'
    }),
    true // balance keywords still kept on alerts-exchange-funds
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
  assert.strictEqual(
    AlertFilters.shouldKeepAlert({
      Channel: IF_CHANNEL,
      Response: 'Something went wrong',
      ErrorCode: '500000',
      RawText: 'ORDER_REJECTED'
    }),
    true
  );
});

run('allowlist: CB keeps volatile + something went wrong', function () {
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
    true
  );
});

run('cleanSymbol keeps B-S- prefix; tokenFromPrefixedInstrument strips for Format C', function () {
  assert.strictEqual(ParserUtils.cleanSymbol('B-S-HBAR_USDT'), 'B-S-HBAR_USDT');
  assert.strictEqual(ParserUtils.cleanSymbol('*B-S-HBAR_USDT*'), 'B-S-HBAR_USDT');
  assert.strictEqual(ParserUtils.tokenFromPrefixedInstrument('KC-S-RAIN_USDT'), 'RAIN_USDT');
  assert.strictEqual(ParserUtils.tokenFromPrefixedInstrument('B-S-HBAR_USDT'), 'HBAR_USDT');
  assert.strictEqual(ParserUtils.tokenFromPrefixedInstrument('SAFEUSDT'), 'SAFEUSDT');
});

run('unmatched non-alert text returns null (not UNMATCHED junk)', function () {
  assert.strictEqual(parseSlackAlert('hello world nothing useful', TS, IF_CHANNEL), null);
});

if (!process.exitCode) {
  console.log('\nAll parser tests passed.');
}
