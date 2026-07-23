/**
 * Slack rejection-alert parser (Node-testable core).
 * Keep in sync with apps-script/Code.gs parseSlackAlert / ParserUtils.
 */

const CB_CHANNEL_NAME = 'CB-Rejection';

const ParserUtils = {
  /** Keep full instrument symbols (e.g. B-S-HBAR_USDT). Do not strip prefixes. */
  cleanSymbol: function (sym) {
    if (!sym) return '';
    return ParserUtils.cleanField(String(sym));
  },

  cleanNumber: function (str) {
    if (!str) return '';
    return str.toString().replace(/[^\d.\-E+]/g, '');
  },

  /** Strip Slack bold/italic asterisks and surrounding whitespace. */
  cleanField: function (val) {
    if (!val) return '';
    return String(val)
      .replace(/\*+/g, '')
      .replace(/^[`'"\s]+|[`'"\s]+$/g, '')
      .trim();
  },

  stripMarkdown: function (str) {
    if (!str) return '';
    return str.replace(/[`*]/g, ' ').replace(/\s+/g, ' ').trim();
  },

  /**
   * Normalize Slack alert text so labeled fields are easier to extract:
   * - bullets become newlines
   * - collapse odd spacing around labels
   */
  normalizeAlertText: function (text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[•\u2022\u2023]/g, '\n')
      .replace(/\n+/g, '\n')
      .trim();
  },

  /**
   * Extract a labeled field value. Stops before the next known label, newline, or end.
   * Handles: Symbol: X | Symbol: `X` | *Symbol: X* | Symbol: *X*
   */
  extractField: function (text, labels) {
    const labelList = Array.isArray(labels) ? labels : [labels];
    const nextLabels =
      'Exchange|Instrument\\/Symbol|Symbol|Side|Qty|OrderId|Account|Env|Error|Details|Format|Channel';

    for (var i = 0; i < labelList.length; i++) {
      const label = labelList[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '(?:^|[\\n\\r*]|\\s)' + label + '\\s*:\\s*`?\\*?\\s*' +
          '([^\\n\\r`]+?)' +
          '\\s*`?\\*?\\s*' +
          '(?=\\s*(?:\\n|$|(?:' + nextLabels + ')\\s*:))',
        'i'
      );
      const m = text.match(re);
      if (m && m[1] != null && String(m[1]).trim() !== '') {
        return ParserUtils.cleanField(m[1]);
      }
    }
    return '';
  },

  extractError: function (text) {
    // Error: -2010 — message
    // Error: `INSUFFICIENT_FUNDS` — message
    // Error:  —  (empty code)
    const errMatch = text.match(
      /Error:\s*`?(-?\d+|[A-Za-z0-9_]+)?`?\s*[\u2014\-\u2013]+\s*([^\n\r`{]*)/i
    );
    if (!errMatch) {
      return { code: '', response: '' };
    }
    return {
      code: errMatch[1] ? ParserUtils.cleanField(errMatch[1]) : '',
      response: ParserUtils.cleanField(errMatch[2] || '')
    };
  }
};

/**
 * @param {string} rawText
 * @param {Date|string|number} timestamp
 * @param {string} channelName
 * @param {{ formatDate?: Function }} [helpers] - optional GAS Utilities.formatDate shim
 */
function parseSlackAlert(rawText, timestamp, channelName, helpers) {
  if (!rawText || !String(rawText).trim()) return null;
  const text = String(rawText).trim();
  const normalized = ParserUtils.normalizeAlertText(text);
  const clean = ParserUtils.stripMarkdown(text);
  const formatDate =
    (helpers && helpers.formatDate) ||
    function (d) {
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
    };

  try {
    // FORMAT A/B: Key-Value / bullet-list (OrderId present or "Order rejected on")
    if (/OrderId\s*:/i.test(text) || /Order rejected on/i.test(text)) {
      var exchange =
        ParserUtils.extractField(normalized, ['Exchange']) ||
        ParserUtils.extractField(text, ['Exchange']);
      if (!exchange) {
        const rejectedOn = text.match(/Order rejected on\s+`?\*?([A-Za-z0-9_.-]+)\*?`?/i);
        if (rejectedOn) exchange = ParserUtils.cleanField(rejectedOn[1]);
      }

      var token =
        ParserUtils.extractField(normalized, ['Instrument/Symbol', 'Symbol']) ||
        ParserUtils.extractField(text, ['Instrument/Symbol', 'Symbol']);
      token = ParserUtils.cleanSymbol(token);

      var side =
        ParserUtils.extractField(normalized, ['Side']) ||
        ParserUtils.extractField(text, ['Side']);
      side = ParserUtils.cleanField(side).toLowerCase();

      var qtyRaw =
        ParserUtils.extractField(normalized, ['Qty']) ||
        ParserUtils.extractField(text, ['Qty']);
      const qty = qtyRaw ? ParserUtils.cleanNumber(qtyRaw) : '';

      var orderId =
        ParserUtils.extractField(normalized, ['OrderId']) ||
        ParserUtils.extractField(text, ['OrderId']);
      orderId = ParserUtils.cleanField(orderId);

      var account =
        ParserUtils.extractField(normalized, ['Account']) ||
        ParserUtils.extractField(text, ['Account']);
      account = ParserUtils.cleanField(account);

      const err = ParserUtils.extractError(text);
      var errCode = err.code;
      var response = err.response;

      if (exchange && token && orderId) {
        if (!response || response.trim() === '') {
          const msgM = text.match(/"msg"\s*(?:=>|=&gt;|:)\s*"([^"]+)"/i);
          if (msgM) {
            response = msgM[1];
          } else {
            const statusM = text.match(/status:\s*:([A-Z_]+)/i);
            response = statusM ? ('Order status: ' + statusM[1]) : 'Order rejected';
          }
        }

        return [{
          Timestamp: timestamp,
          Exchange: exchange,
          Token: token,
          Side: side,
          Qty: qty,
          Account: account,
          Response: response,
          ErrorCode: errCode,
          OrderId: orderId,
          Format: 'Key-Value',
          Channel: channelName,
          RawText: text
        }];
      }
    }

    // FORMAT C: Inline Insufficient Balance
    if (/Insufficient balance for \S+ accounts:/i.test(clean)) {
      const m = clean.match(
        /Insufficient balance for \S+ accounts:\s*(\S+)\s*-\s*(\d+)\s+([A-Z0-9_]+)-[A-Z0-9]+-([A-Z0-9_]+)\s+(BUY|SELL)\s+([\d.]+)/i
      );
      if (m) {
        const tsKey = formatDate(new Date(timestamp));
        return [{
          Timestamp: timestamp,
          Exchange: ParserUtils.cleanField(m[3]),
          Token: ParserUtils.cleanField(m[4]),
          Side: ParserUtils.cleanField(m[5]).toLowerCase(),
          Qty: m[6],
          Account: m[2],
          Response: 'Insufficient balance',
          ErrorCode: '',
          OrderId: m[4] + '_' + m[3] + '_' + tsKey + '_C',
          Format: 'Inline-Text',
          Channel: channelName,
          RawText: text
        }];
      }
    }

    // FORMAT D: Mercury-Action JSON Failure
    if (/Could not \w+ order on/i.test(text)) {
      const exchangeMatch = text.match(/Could not \w+ order on (\w+)/i);
      var orderObj = {};
      var errObj = {};
      const orderJsonMatch = text.match(/\{"version"[\s\S]*?\}/) || text.match(/\{[\s\S]*?\}/);
      if (orderJsonMatch) {
        try { orderObj = JSON.parse(orderJsonMatch[0]); } catch (e) { /* ignore */ }
      }
      const errJsonMatch = text.match(/\{"Code"[\s\S]*?\}/);
      if (errJsonMatch) {
        try { errObj = JSON.parse(errJsonMatch[0]); } catch (e) { /* ignore */ }
      }
      const orderId = orderObj.client_order_id
        ? String(orderObj.client_order_id)
        : (orderObj.id ? String(orderObj.id) : '');
      return [{
        Timestamp: timestamp,
        Exchange: exchangeMatch ? exchangeMatch[1] : '',
        Token: orderObj.instrument_id ? ('instrument_' + orderObj.instrument_id) : '',
        Side: orderObj.side ? orderObj.side.toLowerCase() : '',
        Qty: orderObj.ordered_quantity !== undefined ? String(orderObj.ordered_quantity) : '',
        Account: orderObj.exchange_account_id !== undefined ? String(orderObj.exchange_account_id) : '',
        Response: errObj.Description || errObj.Title || 'Order action failed',
        ErrorCode: errObj.Code || '',
        OrderId: orderId,
        Format: 'JSON-Action',
        Channel: channelName,
        RawText: text
      }];
    }

    // FORMAT E: Exchange-Funds Futures JSON Rejection
    if (/Order rejected:/i.test(text) && /Instrument:/i.test(text)) {
      const orderIdMatch = text.match(/Order rejected:\s*(\S+)/i);
      const instrumentMatch = text.match(/Instrument:\s*(\S+)/i);
      const codeMatch = text.match(/"code"\s*(?:=>|=&gt;|:)\s*(-?\d+)/i);
      const msgMatch = text.match(/"msg"\s*(?:=>|=&gt;|:)\s*"([^"]+)"/i);
      return [{
        Timestamp: timestamp,
        Exchange: '',
        Token: instrumentMatch ? ParserUtils.cleanSymbol(instrumentMatch[1]) : '',
        Side: '',
        Qty: '',
        Account: '',
        Response: msgMatch ? msgMatch[1] : 'Order rejected',
        ErrorCode: codeMatch ? codeMatch[1] : '',
        OrderId: orderIdMatch ? orderIdMatch[1].trim() : '',
        Format: 'JSON-Futures',
        Channel: channelName,
        RawText: text
      }];
    }

    // FORMAT F: CB-Rejection Rollup Digest
    if (channelName === CB_CHANNEL_NAME || /Order Rejections/i.test(text)) {
      const VOLATILE_REASON = 'the market is too volatile right now. please try again later';
      const expandedRows = [];
      text.split('\n').forEach(function (line) {
        const stripped = line.replace(/`/g, '').trim();
        if (!stripped.startsWith('\u2022') && !stripped.startsWith('•')) return;
        const body = stripped.replace(/^[\u2022\u2023*]\s*/, '');
        const parts = body.split('|').map(function (p) { return p.trim(); });
        if (parts.length < 4) return;
        const tokenSide = parts[0].trim().split(/\s+/);
        if (tokenSide.length < 2) return;
        const token = tokenSide[0].toUpperCase();
        const side = tokenSide[1].toLowerCase();
        if (side !== 'buy' && side !== 'sell') return;
        const reason = parts[1].trim();
        if (reason.toLowerCase() !== VOLATILE_REASON) return;
        const userStr = parts[2].trim();
        const userId = userStr.startsWith('user ') ? userStr.substring(5).trim() : userStr;
        const tsStr = parts[3].trim();
        const alertTs = new Date(tsStr.replace(' ', 'T'));
        if (isNaN(alertTs.getTime())) return;
        const tsKey = formatDate(alertTs);
        const dedupKey = token + '_' + userId.substring(0, 8) + '_' + tsKey + '_F';
        expandedRows.push({
          Timestamp: alertTs,
          Exchange: 'CB',
          Token: token,
          Side: side,
          Qty: '',
          Account: userId,
          Response: reason,
          ErrorCode: '',
          OrderId: dedupKey,
          Format: 'CB-Digest',
          Channel: channelName,
          RawText: line
        });
      });
      if (expandedRows.length > 0) return expandedRows;
      return null;
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('Parser exception:', err && err.message ? err.message : err);
    }
  }

  return [{
    Timestamp: timestamp,
    Exchange: '',
    Token: '',
    Side: '',
    Qty: '',
    Account: '',
    Response: 'UNMATCHED FORMAT',
    ErrorCode: '',
    OrderId: '',
    Format: 'UNMATCHED',
    Channel: channelName,
    RawText: text
  }];
}

module.exports = { ParserUtils, parseSlackAlert, CB_CHANNEL_NAME };
