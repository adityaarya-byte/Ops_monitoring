/**
 * Slack rejection-alert parser (Node-testable core).
 * Keep in sync with apps-script/Code.gs parseSlackAlert / ParserUtils / AlertFilters.
 */

const CB_CHANNEL_NAME = 'cb-order-rejection';

const CB_VOLATILE_REASON =
  'the market is too volatile right now. please try again later';

const INSUFFICIENT_KEYWORDS = [
  'insufficient',
  'not enough balance',
  'balance_not_enough',
  'balance not enough',
  'insufficientfunds',
  'insufficient_funds',
  'no eligible account with sufficient balance',
  'balance insufficient'
];

const ParserUtils = {
  cleanSymbol: function (sym) {
    if (!sym) return '';
    return ParserUtils.cleanField(String(sym));
  },

  cleanNumber: function (str) {
    if (!str) return '';
    return str.toString().replace(/[^\d.\-E+]/g, '');
  },

  cleanField: function (val) {
    if (!val) return '';
    return String(val)
      .replace(/\*+/g, '')
      .replace(/`/g, '')
      .replace(/^['"\s]+|['"\s]+$/g, '')
      .trim();
  },

  stripMarkdown: function (str) {
    if (!str) return '';
    return str.replace(/[`*]/g, ' ').replace(/\s+/g, ' ').trim();
  },

  normalizeAlertText: function (text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/^[ \t]*[•\u2022\u2023\u25E6\u2043▪▸►*-]+\s*/gm, '')
      .replace(/[•\u2022\u2023]/g, '\n')
      .replace(/\*([A-Za-z0-9_/ ]+)\*/g, '$1')
      .replace(/\n+/g, '\n')
      .trim();
  },

  normalizeReason: function (reason) {
    return String(reason || '')
      .toLowerCase()
      .replace(/\*+/g, '')
      .replace(/[.`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  extractLabeledFields: function (text) {
    const fields = {};
    const normalized = ParserUtils.normalizeAlertText(text);
    normalized.split('\n').forEach(function (rawLine) {
      var line = String(rawLine || '').trim();
      if (!line) return;
      line = line.replace(/^[•\u2022\u2023*\-\s]+/, '');
      const m = line.match(
        /^\*?((?:Instrument\/Symbol)|Symbol|Exchange|Side|Qty|OrderId|Account|Env|Error)\*?\s*:\s*(.+)$/i
      );
      if (!m) return;
      const key = m[1].toLowerCase();
      var val = m[2].trim().replace(/^`(.+)`$/, '$1').trim();
      fields[key] = ParserUtils.cleanField(val);
    });
    return fields;
  },

  extractField: function (text, labels) {
    const map = ParserUtils.extractLabeledFields(text);
    const labelList = Array.isArray(labels) ? labels : [labels];
    for (var i = 0; i < labelList.length; i++) {
      const key = String(labelList[i]).toLowerCase();
      if (map[key]) return map[key];
    }

    const nextLabels =
      'Exchange|Instrument\\/Symbol|Symbol|Side|Qty|OrderId|Account|Env|Error|Details|Format|Channel';
    for (var j = 0; j < labelList.length; j++) {
      const label = labelList[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        '(?:^|[\\n\\r]|\\s)\\*?\\s*' + label + '\\*?\\s*:\\s*`?\\*?\\s*' +
          '([^\\n\\r`]+?)' +
          '\\s*`?\\*?\\s*' +
          '(?=\\s*(?:\\n|$|\\*?\\s*(?:' + nextLabels + ')\\*?\\s*:))',
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
    const map = ParserUtils.extractLabeledFields(text);
    if (map.error) {
      const full = map.error;
      const split = full.match(/^`?(-?\d+|[A-Za-z0-9_]+)?`?\s*[\u2014\-\u2013]+\s*(.+)$/);
      if (split) {
        return {
          code: split[1] ? ParserUtils.cleanField(split[1]) : '',
          response: ParserUtils.cleanField(full)
        };
      }
      return { code: '', response: ParserUtils.cleanField(full) };
    }

    const errMatch = text.match(
      /Error:\s*`?(-?\d+|[A-Za-z0-9_]+)?`?\s*([\u2014\-\u2013]+)\s*([^\n\r`{]*)/i
    );
    if (!errMatch) {
      return { code: '', response: '' };
    }
    const code = errMatch[1] ? ParserUtils.cleanField(errMatch[1]) : '';
    const msg = ParserUtils.cleanField(errMatch[3] || '');
    const response = code && msg ? (code + ' ' + errMatch[2] + ' ' + msg) : (msg || code);
    return { code: code, response: ParserUtils.cleanField(response) };
  },

  extractMsgFromDetails: function (text) {
    const msgM = text.match(/"msg"\s*(?:=>|=&gt;|:)\s*"([^"]+)"/i);
    return msgM ? msgM[1] : '';
  },

  extractInsufficientMessage: function (text) {
    const fromMsg = ParserUtils.extractMsgFromDetails(text);
    if (fromMsg) return fromMsg;

    const nested = text.match(
      /"message"\s*:\s*"(?:gate\s*)?\{[^"]*"message"\s*:\s*"([^"]+)"/i
    );
    if (nested) return nested[1];

    const plain = text.match(/"message"\s*:\s*"([^"]*(?:not enough balance|insufficient)[^"]*)"/i);
    if (plain) return plain[1];

    if (/BALANCE_NOT_ENOUGH|InsufficientFunds|Not enough balance/i.test(text)) {
      return 'Not enough balance';
    }
    return '';
  }
};

const AlertFilters = {
  isCbChannel: function (channelName) {
    const n = String(channelName || '').toLowerCase().trim();
    return (
      n === CB_CHANNEL_NAME ||
      n === 'cb-rejection' ||
      n === 'cb-order-rejection' ||
      n.indexOf('cb-order-rejection') !== -1 ||
      n.indexOf('cb-rejection') !== -1
    );
  },

  isVolatileReason: function (reason) {
    const r = ParserUtils.normalizeReason(reason);
    return r === CB_VOLATILE_REASON || r.indexOf(CB_VOLATILE_REASON) !== -1;
  },

  isInsufficientReason: function (item) {
    const hay = [
      item && item.Response,
      item && item.ErrorCode,
      item && item.RawText,
      item && item.reason
    ]
      .join(' ')
      .toLowerCase();
    for (var i = 0; i < INSUFFICIENT_KEYWORDS.length; i++) {
      if (hay.indexOf(INSUFFICIENT_KEYWORDS[i]) !== -1) return true;
    }
    return false;
  },

  shouldKeepAlert: function (item) {
    if (!item) return false;
    if (AlertFilters.isCbChannel(item.Channel) || item.Format === 'CB-Digest') {
      return AlertFilters.isVolatileReason(item.Response || item.reason);
    }
    return AlertFilters.isInsufficientReason(item);
  }
};

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

      var side = ParserUtils.cleanField(
        ParserUtils.extractField(normalized, ['Side']) ||
          ParserUtils.extractField(text, ['Side'])
      ).toLowerCase();

      var qtyRaw =
        ParserUtils.extractField(normalized, ['Qty']) ||
        ParserUtils.extractField(text, ['Qty']);
      const qty = qtyRaw ? ParserUtils.cleanNumber(qtyRaw) : '';

      var orderId = ParserUtils.cleanField(
        ParserUtils.extractField(normalized, ['OrderId']) ||
          ParserUtils.extractField(text, ['OrderId'])
      );

      var account = ParserUtils.cleanField(
        ParserUtils.extractField(normalized, ['Account']) ||
          ParserUtils.extractField(text, ['Account'])
      );

      const err = ParserUtils.extractError(text);
      var errCode = err.code;
      var response = err.response;

      if (exchange && token && orderId) {
        if (!response || response.trim() === '' || /^order rejected$/i.test(response)) {
          const fromDetails =
            ParserUtils.extractMsgFromDetails(text) ||
            ParserUtils.extractInsufficientMessage(text);
          if (fromDetails) response = fromDetails;
          else if (!response) response = 'Order rejected';
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

    {
      const inline = clean.match(
        /(?:Production|Mercury-Production)?\s*([A-Za-z0-9_.-]+)\s+([A-Za-z0-9_-]+)\s+(buy|sell)\s+([\d.]+)\s+order\s+([A-Za-z0-9-]+)/i
      );
      if (inline && /rejected:\s*response/i.test(text)) {
        const accountMatch = text.match(/Account:\s*`?([^\s,`]+)`?/i);
        const codeMatch = text.match(/"code"\s*(?:=>|=&gt;|:)\s*(-?\d+)/i);
        const response =
          ParserUtils.extractMsgFromDetails(text) ||
          ParserUtils.extractInsufficientMessage(text) ||
          'Order rejected';
        return [{
          Timestamp: timestamp,
          Exchange: ParserUtils.cleanField(inline[1]),
          Token: ParserUtils.cleanSymbol(inline[2]),
          Side: ParserUtils.cleanField(inline[3]).toLowerCase(),
          Qty: ParserUtils.cleanNumber(inline[4]),
          Account: accountMatch ? ParserUtils.cleanField(accountMatch[1]) : '',
          Response: response,
          ErrorCode: codeMatch ? codeMatch[1] : '',
          OrderId: ParserUtils.cleanField(inline[5]),
          Format: 'Inline-Production',
          Channel: channelName,
          RawText: text
        }];
      }
    }

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

      var response =
        ParserUtils.extractInsufficientMessage(text) ||
        errObj.Description ||
        errObj.Title ||
        '';
      var errCode = errObj.Code || '';
      if (!errCode) {
        if (/BALANCE_NOT_ENOUGH/i.test(text)) errCode = 'BALANCE_NOT_ENOUGH';
        else if (/InsufficientFunds/i.test(text)) errCode = 'InsufficientFunds';
      }
      if (!response) response = 'Order action failed';

      return [{
        Timestamp: timestamp,
        Exchange: exchangeMatch ? exchangeMatch[1] : '',
        Token: orderObj.instrument_id ? ('instrument_' + orderObj.instrument_id) : '',
        Side: orderObj.side ? String(orderObj.side).toLowerCase() : '',
        Qty: orderObj.ordered_quantity !== undefined ? String(orderObj.ordered_quantity) : '',
        Account: orderObj.exchange_account_id !== undefined ? String(orderObj.exchange_account_id) : '',
        Response: response,
        ErrorCode: errCode,
        OrderId: orderId,
        Format: 'JSON-Action',
        Channel: channelName,
        RawText: text
      }];
    }

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

    if (
      AlertFilters.isCbChannel(channelName) ||
      /Insta\s*\/\s*OTC Order Rejections/i.test(text) ||
      /Newly landed rejections/i.test(text) ||
      /Order Rejections/i.test(text)
    ) {
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
        if (!AlertFilters.isVolatileReason(reason)) return;
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
          Response: 'The market is too volatile right now. Please try again later',
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

  return null;
}

module.exports = {
  ParserUtils,
  parseSlackAlert,
  AlertFilters,
  CB_CHANNEL_NAME,
  CB_VOLATILE_REASON,
  INSUFFICIENT_KEYWORDS
};
