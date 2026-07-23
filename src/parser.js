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
  /** Keep full instrument symbols (e.g. B-S-HBAR_USDT). Do not strip B-S- prefixes. */
  cleanSymbol: function (sym) {
    if (!sym) return '';
    return ParserUtils.cleanField(String(sym));
  },

  cleanNumber: function (str) {
    if (!str) return '';
    return str.toString().replace(/[^\d.\-E+]/g, '');
  },

  /** Strip Slack bold/italic asterisks and backticks from field values. */
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
      // Drop leading bullets on each line: • Symbol: ... → Symbol: ...
      .replace(/^[ \t]*[•\u2022\u2023\u25E6\u2043▪▸►*-]+\s*/gm, '')
      // Mid-line bullets (single-line webhook payloads) → newlines
      .replace(/[•\u2022\u2023]/g, '\n')
      // Slack bold labels: *Symbol* → Symbol
      .replace(/\*([A-Za-z0-9_/ ]+)\*/g, '$1')
      .replace(/\n+/g, '\n')
      .trim();
  },

  /**
   * Line-oriented field map — ignores • / bullets / backticks / *bold*.
   * Keys lowercased without spaces: symbol, instrument/symbol, exchange, ...
   */
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
      var val = m[2].trim();
      // Strip wrapping backticks around the whole value
      val = val.replace(/^`(.+)`$/, '$1').trim();
      fields[key] = ParserUtils.cleanField(val);
    });
    return fields;
  },

  extractField: function (text, labels) {
    // Prefer line-map (handles • bullets reliably), then regex fallback
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

  normalizeReason: function (reason) {
    return String(reason || '')
      .toLowerCase()
      .replace(/\*+/g, '')
      .replace(/[.`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  extractError: function (text) {
    // Prefer line map value: "INSUFFICIENT_FUNDS — No eligible account..."
    const map = ParserUtils.extractLabeledFields(text);
    if (map.error) {
      const full = map.error;
      const split = full.match(/^`?(-?\d+|[A-Za-z0-9_]+)?`?\s*[\u2014\-\u2013]+\s*(.+)$/);
      if (split) {
        return {
          code: split[1] ? ParserUtils.cleanField(split[1]) : '',
          response: ParserUtils.cleanField(full) // keep full "CODE — message"
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

  /** Ruby hash :reason=>"Something went wrong" (INSTA ORDER_REJECTED Details) */
  extractRubyReason: function (text) {
    const m =
      text.match(/:reason\s*=>\s*"([^"]+)"/i) ||
      text.match(/["']reason["']\s*=>\s*"([^"]+)"/i) ||
      text.match(/"reason"\s*:\s*"([^"]+)"/i);
    return m ? ParserUtils.cleanField(m[1]) : '';
  },

  /**
   * Instrument like KC-S-RAIN_USDT / B-S-HBAR_USDT → token after exchange-side prefix.
   * SAFEUSDT (no prefix) returned as-is.
   */
  tokenFromPrefixedInstrument: function (sym) {
    const s = ParserUtils.cleanField(sym);
    const m = s.match(/^[A-Z0-9]+-[A-Z0-9]+-(.+)$/i);
    return m ? ParserUtils.cleanField(m[1]) : s;
  },

  extractInsufficientMessage: function (text) {
    const fromMsg = ParserUtils.extractMsgFromDetails(text);
    if (fromMsg) return fromMsg;

    // "message":"binance Account has insufficient balance for requested action."
    const plainFull = text.match(/"message"\s*:\s*"((?:binance|gate|kucoin|gateio)?[^"]*(?:insufficient|not enough balance|BALANCE_NOT_ENOUGH)[^"]*)"/i);
    if (plainFull) return ParserUtils.cleanField(plainFull[1]);

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

/** Per-channel keep-rules for which parsed rows become alerts */
const AlertFilters = {
  isCbChannel: function (channelName) {
    const n = String(channelName || '').toLowerCase().trim();
    return (
      n === CB_CHANNEL_NAME ||
      n === 'cb-rejection' ||
      n.indexOf('cb-order-rejection') !== -1 ||
      n.indexOf('cb-rejection') !== -1
    );
  },

  channelKey: function (channelName) {
    return String(channelName || '').toLowerCase().trim();
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

  /**
   * Channel rules:
   *  - cb-order-rejection → volatile only
   *  - insufficient-funds-rails-mercury-rejections → ALL parsed reasons
   *  - alerts-exchange-funds-mercury → ALL parsed
   *  - alerts-exchange-funds → Insta.InternalTpOrder only (drop Futures / unsettled conversion)
   *  - alerts-action-required-mercury → non-Coindcx action failures
   */
  shouldKeepAlert: function (item) {
    if (!item) return false;
    const ch = AlertFilters.channelKey(item.Channel);
    const raw = String(item.RawText || '');
    const ex = String(item.Exchange || '').toLowerCase();

    if (AlertFilters.isCbChannel(ch) || item.Format === 'CB-Digest') {
      return AlertFilters.isVolatileReason(item.Response || item.reason);
    }

    if (ch.indexOf('insufficient-funds-rails') !== -1) {
      return true; // all reasons from this channel
    }

    if (ch === 'alerts-exchange-funds-mercury') {
      return true; // all parsed alerts
    }

    if (ch === 'alerts-exchange-funds') {
      if (/Futures\s+Order rejected:/i.test(raw)) return false;
      if (/Total unsettled Conversion order Requests/i.test(raw)) return false;
      if (item.Format === 'Insta-InternalTp') return true;
      if (/Otc::Order did not succeeded/i.test(item.Response || '') || /Otc::Order did not succeeded/i.test(raw)) {
        return true;
      }
      return false;
    }

    if (ch === 'alerts-action-required-mercury') {
      if (/Could not \w+ order on\s+Coindcx/i.test(raw) || ex === 'coindcx') return false;
      if (item.Format === 'JSON-Action') return true;
      return AlertFilters.isInsufficientReason(item);
    }

    return AlertFilters.isInsufficientReason(item);
  }
};

/**
 * @param {string} rawText
 * @param {Date|string|number} timestamp
 * @param {string} channelName
 * @param {{ formatDate?: (d: Date) => string }} [helpers]
 */
function parseSlackAlert(rawText, timestamp, channelName, helpers) {
  if (!rawText || !String(rawText).trim()) return null;
  const text = String(rawText).trim();
  const normalized = ParserUtils.normalizeAlertText(text);
  const clean = ParserUtils.stripMarkdown(text);
  const ch = AlertFilters.channelKey(channelName);
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
    // Hard drops for alerts-exchange-funds (never stage)
    if (ch === 'alerts-exchange-funds') {
      if (/Futures\s+Order rejected:/i.test(text)) return null;
      if (/Total unsettled Conversion order Requests/i.test(text)) return null;
    }

    // FORMAT H: Insta.InternalTpOrder (alerts-exchange-funds)
    // Production For Insta.InternalTpOrder: Internal Exchange MYRIAINR sell Otc::Order did not succeeded, ...
    if (/Insta\.InternalTpOrder/i.test(text) && /Otc::Order did not succeeded/i.test(text)) {
      const m = text.match(
        /Internal Exchange\s+([A-Za-z0-9_]+)\s+(buy|sell)\s+(Otc::Order did not succeeded)/i
      );
      if (m) {
        const orderIdM = text.match(/"orderId"\s*=>\s*"([^"]+)"/i) || text.match(/order_id["']?\s*[:=]\s*["']([^"']+)/i);
        return [{
          Timestamp: timestamp,
          Exchange: 'Internal',
          Token: ParserUtils.cleanField(m[1]),
          Side: ParserUtils.cleanField(m[2]).toLowerCase(),
          Qty: '',
          Account: 'insta',
          Response: 'Otc::Order did not succeeded',
          ErrorCode: '',
          OrderId: orderIdM ? ParserUtils.cleanField(orderIdM[1]) : '',
          Format: 'Insta-InternalTp',
          Channel: channelName,
          RawText: text
        }];
      }
    }

    // FORMAT A/B: Key-Value / bullet / INSTA ORDER_REJECTED
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
      // Keep full symbol for rails bullet (B-S-HBAR_USDT); SAFEUSDT stays as-is
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
        // Prefer Details :reason=> when Error body blank (e.g. Error: 500000 —)
        const rubyReason = ParserUtils.extractRubyReason(text);
        const responseEmpty = !response ||
          !String(response).replace(/[\d\s\u2014\-\u2013]/g, '').trim() ||
          /^order rejected$/i.test(response);
        if (rubyReason && responseEmpty) {
          response = rubyReason;
        } else if (responseEmpty) {
          const fromDetails =
            ParserUtils.extractMsgFromDetails(text) ||
            ParserUtils.extractInsufficientMessage(text) ||
            rubyReason;
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
          Format: /\[INSTA\]/i.test(text) ? 'INSTA-Key-Value' : 'Key-Value',
          Channel: channelName,
          RawText: text
        }];
      }
    }

    // FORMAT G: Production Binance MANTAUSDT sell ... order <id>, rejected: response {...}
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

    // FORMAT C: Mercury-Production Insufficient balance for Kucoin accounts: all - 413779298 KC-S-RAIN_USDT SELL 27720
    if (/Insufficient balance for \S+ accounts:/i.test(clean)) {
      const m = clean.match(
        /Insufficient balance for (\S+) accounts:\s*(\S+)\s*-\s*(\d+)\s+([A-Za-z0-9_-]+)\s+(BUY|SELL)\s+([\d.]+)/i
      );
      if (m) {
        const exchangeName = ParserUtils.cleanField(m[1]); // Kucoin
        const instrument = ParserUtils.cleanField(m[4]);   // KC-S-RAIN_USDT
        const token = ParserUtils.tokenFromPrefixedInstrument(instrument); // RAIN_USDT
        const tsKey = formatDate(new Date(timestamp));
        return [{
          Timestamp: timestamp,
          Exchange: exchangeName,
          Token: token,
          Side: ParserUtils.cleanField(m[5]).toLowerCase(),
          Qty: ParserUtils.cleanNumber(m[6]),
          Account: ParserUtils.cleanField(m[3]),
          Response: 'Insufficient balance',
          ErrorCode: '',
          OrderId: token + '_' + exchangeName + '_' + tsKey + '_C',
          Format: 'Inline-Text',
          Channel: channelName,
          RawText: text
        }];
      }
    }

    // FORMAT D: Could not CREATE/CANCEL order on Binance|Gateio|Kucoin (skip Coindcx via filter)
    // Token = trace_id; reason = InsufficientFunds message
    if (/Could not \w+ order on/i.test(text)) {
      const exchangeMatch = text.match(/Could not \w+ order on (\w+)/i);
      const exchangeName = exchangeMatch ? exchangeMatch[1] : '';
      if (/^coindcx$/i.test(exchangeName)) return null;

      var orderObj = {};
      const orderJsonMatch = text.match(/\{"version"[\s\S]*?\}/);
      if (orderJsonMatch) { try { orderObj = JSON.parse(orderJsonMatch[0]); } catch (e) { /* ignore */ } }

      const traceId = orderObj.trace_id
        ? String(orderObj.trace_id)
        : (function () {
            const tm = text.match(/"trace_id"\s*:\s*"([^"]+)"/i);
            return tm ? tm[1] : '';
          })();
      const orderId = orderObj.client_order_id
        ? String(orderObj.client_order_id)
        : (orderObj.id ? String(orderObj.id) : '');

      var response = ParserUtils.extractInsufficientMessage(text);
      // Prefer full "binance Account has insufficient..." when present
      const msgBinance = text.match(/"message"\s*:\s*"(binance [^"]+)"/i);
      if (msgBinance) response = ParserUtils.cleanField(msgBinance[1]);
      var errCode = '';
      if (/BALANCE_NOT_ENOUGH/i.test(text)) errCode = 'BALANCE_NOT_ENOUGH';
      else if (/InsufficientFunds/i.test(text)) errCode = 'InsufficientFunds';
      if (!response) response = 'Order action failed';

      return [{
        Timestamp: timestamp,
        Exchange: exchangeName,
        Token: traceId || (orderObj.instrument_id ? ('instrument_' + orderObj.instrument_id) : ''),
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

    // FORMAT E: Futures / instrument JSON — only if NOT the blocked "Production Futures Order rejected"
    if (/Order rejected:/i.test(text) && /Instrument:/i.test(text) && !/Futures\s+Order rejected:/i.test(text)) {
      const orderIdMatch = text.match(/Order rejected:\s*(\S+)/i);
      const instrumentMatch = text.match(/Instrument:\s*(\S+)/i);
      const codeMatch = text.match(/"code"\s*(?:=>|=&gt;|:)\s*(-?\d+)/i);
      const msgMatch = text.match(/"msg"\s*(?:=>|=&gt;|:)\s*"([^"]+)"/i);
      return [{
        Timestamp: timestamp,
        Exchange: '',
        Token: instrumentMatch ? ParserUtils.cleanSymbol(instrumentMatch[1]) : '',
        Side: '', Qty: '', Account: '',
        Response: msgMatch ? msgMatch[1] : 'Order rejected',
        ErrorCode: codeMatch ? codeMatch[1] : '',
        OrderId: orderIdMatch ? orderIdMatch[1].trim() : '',
        Format: 'JSON-Futures',
        Channel: channelName,
        RawText: text
      }];
    }

    // FORMAT F: cb-order-rejection digest — ONLY volatile-market lines
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
