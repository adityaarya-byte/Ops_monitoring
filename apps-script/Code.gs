/**
 * ============================================================================
 *  Slack Rejection Alert Monitoring System — Production Pipeline (V2.3)
 *  FIXES (V2.1):
 *    1. Token property key changed to 'TOKEN' (matches existing Script Properties)
 *    2. ensureSheetWithHeaders always rewrites headers (handles stale old headers)
 *    3. setupSheets() forces raw sheet reset so old-format raw sheet is cleared
 *    4. Dedup in fetchSlackMessages prevents re-adding already-staged messages
 *  FIXES (V2.2):
 *    5. clearSheetDataRows uses clearContent (avoids "delete all non-frozen rows" error)
 *    6. Channel renamed/tracked as insufficient-funds-rails-mercury-rejections
 *    7. Parser keeps full symbols (e.g. B-S-HBAR_USDT) — no B-S- prefix strip
 *    8. Field extraction handles Slack *, backticks, bullets, and single-line labels
 *  FIXES (V2.3):
 *    9. Allowlist: non-CB channels keep ONLY insufficient/balance reasons
 *   10. cb-order-rejection keeps ONLY "market is too volatile..." (drops other CB reasons)
 *   11. Parse Production inline (MANTAUSDT) + Gateio InsufficientFunds CREATE failures
 *   12. Alerts rebuild also filters stale transform rows
 * ============================================================================
 */

// ============================================================================
// SECTION 1: CONFIG
// ============================================================================

const CONFIG = {
  SHEETS: {
    RAW: 'raw',
    TRANSFORM: 'transform',
    TRANSFORM_CB: 'transform_cb',
    ALERTS: 'alerts',
    SUMMARY: 'alerts_summary'
  },

  CHANNELS: [
    { id: 'C01R3QCR62Y', name: 'alerts-exchange-funds' },
    { id: 'C08TQHSSL73', name: 'alerts-action-required-mercury' },
    { id: 'C08T9KQGQ13', name: 'alerts-exchange-funds-mercury' },
    { id: 'C0BCN9QG679', name: 'cb-order-rejection' },
    { id: 'C0BDYE1RQTH', name: 'insufficient-funds-rails-mercury-rejections' }
  ],

  CB_CHANNEL_NAME: 'cb-order-rejection',
  CB_VOLATILE_REASON: 'the market is too volatile right now. please try again later',
  INSUFFICIENT_KEYWORDS: [
    'insufficient',
    'not enough balance',
    'balance_not_enough',
    'balance not enough',
    'insufficientfunds',
    'insufficient_funds',
    'no eligible account with sufficient balance',
    'balance insufficient'
  ],
  INCIDENT_WINDOW_MINUTES: 30,
  MAX_TRANSFORM_ROWS: 5000,
  MAX_TRANSFORM_CB_ROWS: 30000,

  // Backfill window when cursors are missing/stale (testing = 7 days)
  LOOKBACK_DAYS: 7,
  // Time-driven trigger interval (Apps Script supports 1, 5, 10, 15, 30)
  TRIGGER_MINUTES: 1,

  SLACK_API_BASE: 'https://slack.com/api/',

  // ✅ FIX 1: Use 'TOKEN' — matches the key already in your Script Properties
  SLACK_BOT_TOKEN_PROP: 'TOKEN'
};

const RAW_HEADERS = [
  'message_id', 'channel_id', 'channel_name', 'raw_text', 'posted_at',
  'fetched_at', 'status', 'error_message', 'retry_count'
];

const TX_HEADERS = [
  'Timestamp', 'Exchange', 'Token', 'Side', 'Qty',
  'Account', 'Response', 'ErrorCode', 'OrderId', 'Format', 'Channel', 'RawText'
];

const AL_HEADERS = [
  'Token', 'Exchange', 'Account', 'Side', 'Channel',
  'First Alert Time', 'Latest Alert Time', 'Duration (mins)',
  'Status', 'Session Date', 'Occurrence', 'Reason',
  'Reason Category', 'Rejection Type'
];


// ============================================================================
// SECTION 2: SHEET SERVICE
// ============================================================================

const SheetService = {
  getSS: function () {
    return SpreadsheetApp.getActiveSpreadsheet();
  },

  // ✅ FIX 2: Always write headers — never skip even if sheet already has rows.
  ensureSheetWithHeaders: function (sheetName, headers) {
    const ss = this.getSS();
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    if (sheet.getMaxRows() > 1) { sheet.setFrozenRows(1); }
    return sheet;
  },

  /**
   * ✅ FIX 5: Clear data rows without deleteRows().
   * Apps Script throws "Sorry, it is not possible to delete all non-frozen rows"
   * when row 1 is frozen and deleteRows(2, lastRow-1) removes every non-frozen row.
   */
  clearSheetDataRows: function (sheetName) {
    const sheet = this.getSS().getSheetByName(sheetName);
    if (!sheet) return 0;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const numRows = lastRow - 1; // data rows only (header is row 1)
    // getRange(row, column, numRows, numColumns) — NOT endRow/endCol
    sheet.getRange(2, 1, numRows, lastCol).clearContent();
    return numRows;
  },

  readAsObjects: function (sheetName, headers) {
    const h = headers || TX_HEADERS;
    const sheet = this.ensureSheetWithHeaders(sheetName, h);
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol === 0) return { headers: h, rows: [], sheet: sheet };

    const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const sheetHeaders = values[0];
    const rows = [];
    for (var i = 1; i < values.length; i++) {
      const obj = {};
      for (var c = 0; c < sheetHeaders.length; c++) {
        obj[sheetHeaders[c]] = values[i][c];
      }
      obj.__row = i + 1;
      rows.push(obj);
    }
    return { headers: sheetHeaders, rows: rows, sheet: sheet };
  },

  appendObjects: function (sheetName, objects, headers) {
    if (!objects || objects.length === 0) return;
    const sheet = this.getSS().getSheetByName(sheetName);
    if (!sheet) return;
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return;
    const hdrs = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

    const rows = objects.map(function (obj) {
      return hdrs.map(function (h) { return (obj[h] !== undefined) ? obj[h] : ''; });
    });

    const startRow = Math.max(sheet.getLastRow() + 1, 2);
    // getRange(row, column, numRows, numColumns)
    sheet.getRange(startRow, 1, rows.length, hdrs.length).setValues(rows);
  },

  updateRowsInPlace: function (sheetName, updates) {
    if (!updates || updates.length === 0) return;
    const sheet = this.getSS().getSheetByName(sheetName);
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return;
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const colIndex = {};
    headers.forEach(function (h, i) { colIndex[h] = i; });

    const firstRow = Math.min.apply(null, updates.map(function (u) { return u.row; }));
    const lastRow  = Math.max.apply(null, updates.map(function (u) { return u.row; }));
    const block = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, headers.length).getValues();

    updates.forEach(function (u) {
      const localRow = u.row - firstRow;
      Object.keys(u.values).forEach(function (col) {
        if (colIndex[col] === undefined) return;
        block[localRow][colIndex[col]] = u.values[col];
      });
    });
    sheet.getRange(firstRow, 1, lastRow - firstRow + 1, headers.length).setValues(block);
  },

  trimSheetBuffer: function (sheetName, maxCap) {
    const sheet = this.getSS().getSheetByName(sheetName);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow > maxCap + 1) {
      const excess = lastRow - (maxCap + 1);
      // Keep at least one non-frozen row buffer when header is frozen
      const deletable = Math.min(excess, lastRow - 2);
      if (deletable > 0) {
        sheet.deleteRows(maxCap + 2, deletable);
        Logger.log('🗑️ Trimmed ' + deletable + ' excess row(s) from "' + sheetName + '"');
      }
    }
  }
};

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
      n === CONFIG.CB_CHANNEL_NAME ||
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
    const target = CONFIG.CB_VOLATILE_REASON;
    return r === target || r.indexOf(target) !== -1;
  },

  isInsufficientReason: function (item) {
    const hay = [item.Response, item.ErrorCode, item.RawText, item.reason]
      .join(' ')
      .toLowerCase();
    const kws = CONFIG.INSUFFICIENT_KEYWORDS;
    for (var i = 0; i < kws.length; i++) {
      if (hay.indexOf(kws[i]) !== -1) return true;
    }
    return false;
  },

  isExchangeFundsMercury: function (ch) {
    return ch === 'alerts-exchange-funds-mercury' || ch === 'mercury';
  },

  isExchangeFunds: function (ch) {
    // Exact / legacy names — must NOT match alerts-exchange-funds-mercury
    return (
      ch === 'alerts-exchange-funds' ||
      (ch.indexOf('alerts-exchange-funds') !== -1 && ch.indexOf('mercury') === -1)
    );
  },

  isActionRequired: function (ch) {
    return ch === 'alerts-action-required-mercury' || ch.indexOf('alerts-action-required') !== -1;
  },

  isRailsChannel: function (ch) {
    return ch.indexOf('insufficient-funds-rails') !== -1 || ch === 'if-mercury';
  },

  /**
   * Channel rules:
   *  - cb-order-rejection → volatile only
   *  - insufficient-funds-rails-* → ALL parsed reasons
   *  - alerts-exchange-funds-mercury → ALL parsed
   *  - alerts-exchange-funds → Insta.InternalTp + balance/insufficient; drop Futures / unsettled
   *  - alerts-action-required-mercury → all non-Coindcx parsed alerts
   */
  shouldKeepAlert: function (item) {
    if (!item) return false;
    const ch = AlertFilters.channelKey(item.Channel);
    const raw = String(item.RawText || '');
    const ex = String(item.Exchange || '').toLowerCase();
    const resp = String(item.Response || item.reason || '');

    if (AlertFilters.isCbChannel(ch) || item.Format === 'CB-Digest') {
      return AlertFilters.isVolatileReason(resp);
    }

    if (AlertFilters.isRailsChannel(ch)) {
      return true; // all reasons from rails channel
    }

    if (AlertFilters.isExchangeFundsMercury(ch)) {
      return true; // all parsed alerts
    }

    if (AlertFilters.isExchangeFunds(ch)) {
      if (/Futures\s+Order rejected:/i.test(raw)) return false;
      if (/Total unsettled Conversion order Requests/i.test(raw)) return false;
      if (item.Format === 'Insta-InternalTp') return true;
      if (/Otc::Order did not succeeded/i.test(resp) || /Otc::Order did not succeeded/i.test(raw)) {
        return true;
      }
      // Keep balance / insufficient (previous keyword behavior on this channel)
      if (AlertFilters.isInsufficientReason(item)) return true;
      return false;
    }

    if (AlertFilters.isActionRequired(ch)) {
      if (/Could not \w+ order on\s+Coindcx/i.test(raw) || ex === 'coindcx') return false;
      return true; // all other successfully parsed alerts (Binance / KC / Gateio / …)
    }

    // Unknown / legacy channel names — keep insufficient + insta-style failures
    if (AlertFilters.isInsufficientReason(item)) return true;
    if (item.Format === 'Insta-InternalTp' || /Otc::Order did not succeeded/i.test(resp)) return true;
    if (item.Format === 'INSTA-Key-Value' || item.Format === 'JSON-Action') return true;
    return false;
  }
};


// ============================================================================
// SECTION 3: PARSER ENGINE
// ============================================================================

function parseSlackAlert(rawText, timestamp, channelName) {
  if (!rawText || !String(rawText).trim()) return null;
  const text = String(rawText).trim();
  const normalized = ParserUtils.normalizeAlertText(text);
  const clean = ParserUtils.stripMarkdown(text);
  const ch = AlertFilters.channelKey(channelName);

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
        const tsKey = Utilities.formatDate(
          new Date(timestamp), Session.getScriptTimeZone(), 'yyyyMMddHHmmss'
        );
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
      if (orderJsonMatch) { try { orderObj = JSON.parse(orderJsonMatch[0]); } catch (e) {} }

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
        const tsKey = Utilities.formatDate(alertTs, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
        const dedupKey = token + '_' + userId.substring(0, 8) + '_' + tsKey + '_F';
        expandedRows.push({
          Timestamp: alertTs, Exchange: 'CB', Token: token, Side: side,
          Qty: '', Account: userId,
          Response: 'The market is too volatile right now. Please try again later',
          ErrorCode: '',
          OrderId: dedupKey, Format: 'CB-Digest', Channel: channelName, RawText: line
        });
      });
      if (expandedRows.length > 0) return expandedRows;
      return null;
    }

  } catch (err) {
    Logger.log('⚠️ Parser exception: ' + err.message);
  }

  return null;
}


// ============================================================================
// SECTION 4: PIPELINE EXECUTOR
// ============================================================================

/**
 * Webhooks often put the real body in attachments/blocks, not msg.text.
 * Without this, bullet alerts (• Symbol: B-S-HBAR_USDT) are skipped entirely.
 */
function extractSlackMessageText(msg) {
  if (!msg) return '';
  const parts = [];
  function push(s) {
    if (s == null) return;
    const t = String(s).trim();
    if (t) parts.push(t);
  }

  push(msg.text);

  if (msg.attachments && msg.attachments.length) {
    msg.attachments.forEach(function (a) {
      push(a.pretext);
      push(a.title);
      push(a.text);
      push(a.fallback);
      if (a.fields && a.fields.length) {
        a.fields.forEach(function (f) {
          if (f && (f.title || f.value)) {
            push(String(f.title || '') + ': ' + String(f.value || ''));
          }
        });
      }
    });
  }

  function flattenRichText(elements) {
    if (!elements || !elements.length) return '';
    var out = '';
    elements.forEach(function (el) {
      if (!el) return;
      if (el.text) out += el.text;
      if (el.elements) out += flattenRichText(el.elements);
      if (el.type === 'rich_text_section' || el.type === 'rich_text_list') {
        out += flattenRichText(el.elements);
        if (el.type === 'rich_text_list') out += '\n';
      }
    });
    return out;
  }

  if (msg.blocks && msg.blocks.length) {
    msg.blocks.forEach(function (b) {
      if (!b) return;
      if (b.text && b.text.text) push(b.text.text);
      if (b.fields && b.fields.length) {
        b.fields.forEach(function (f) {
          if (f && f.text) push(f.text);
        });
      }
      if (b.type === 'rich_text') push(flattenRichText(b.elements));
    });
  }

  // De-dupe identical chunks (text often equals attachment fallback)
  const seen = {};
  const uniq = [];
  parts.forEach(function (p) {
    if (!seen[p]) {
      seen[p] = true;
      uniq.push(p);
    }
  });
  return uniq.join('\n').trim();
}

/** Stage 1: Fetch Slack Messages with Self-Healing lookback window + Dedup */
function fetchSlackMessages() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.SLACK_BOT_TOKEN_PROP);
  if (!token) {
    Logger.log('❌ Missing token in Script Properties key: ' + CONFIG.SLACK_BOT_TOKEN_PROP);
    Logger.log('   Run setSlackToken() or add TOKEN manually in Project Settings > Script Properties');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const rawSheet = SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.RAW, RAW_HEADERS);

  // ✅ FIX 4: Build dedup set from existing message_ids
  const existingIds = {};
  const rawLastRow = rawSheet.getLastRow();
  if (rawLastRow > 1) {
    // getRange(row, column, numRows, numColumns)
    rawSheet.getRange(2, 1, rawLastRow - 1, 1).getValues()
      .forEach(function (row) {
        if (row[0]) existingIds[String(row[0])] = true;
      });
  }

  const lookbackMs = (CONFIG.LOOKBACK_DAYS || 7) * 24 * 60 * 60 * 1000;
  const lookbackStart = new Date(Date.now() - lookbackMs);
  const defaultOldestTs = (lookbackStart.getTime() / 1000).toFixed(6);
  Logger.log('📅 Fetch lookback: last ' + CONFIG.LOOKBACK_DAYS + ' day(s) (oldest ts=' + defaultOldestTs + ')');

  const newRows = [];
  var totalFetched = 0;

  CONFIG.CHANNELS.forEach(function (channel) {
    const cursorKey = 'CURSOR_' + channel.id;
    var oldestTs = props.getProperty(cursorKey);

    if (!oldestTs || parseFloat(oldestTs) < parseFloat(defaultOldestTs)) {
      oldestTs = defaultOldestTs;
    }

    var cursor = null;
    var maxTsInBatch = oldestTs;
    var channelCount = 0;

    do {
      const query = 'channel=' + channel.id + '&limit=200&oldest=' + oldestTs
                  + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      var response, body;
      try {
        response = UrlFetchApp.fetch(CONFIG.SLACK_API_BASE + 'conversations.history?' + query, {
          method: 'get',
          headers: { Authorization: 'Bearer ' + token },
          muteHttpExceptions: true
        });
        body = JSON.parse(response.getContentText());
      } catch (e) {
        Logger.log('❌ Fetch error for ' + channel.name + ': ' + e.message);
        break;
      }

      if (!body.ok) {
        Logger.log('❌ Slack API error (' + channel.name + '): ' + body.error);
        break;
      }

      (body.messages || []).forEach(function (msg) {
        const rawText = extractSlackMessageText(msg);
        if (!rawText) return;
        if (existingIds[msg.ts]) return;
        existingIds[msg.ts] = true;

        newRows.push({
          message_id: msg.ts,
          channel_id: channel.id,
          channel_name: channel.name,
          raw_text: rawText,
          posted_at: new Date(parseFloat(msg.ts) * 1000),
          fetched_at: new Date(),
          status: 'PENDING',
          error_message: '',
          retry_count: 0
        });

        if (parseFloat(msg.ts) > parseFloat(maxTsInBatch)) maxTsInBatch = msg.ts;
        channelCount++;
      });

      cursor = (body.response_metadata && body.response_metadata.next_cursor)
             ? body.response_metadata.next_cursor : null;

    } while (cursor);

    if (parseFloat(maxTsInBatch) > parseFloat(oldestTs)) {
      props.setProperty(cursorKey, maxTsInBatch);
    }

    Logger.log('📡 ' + channel.name + ': ' + channelCount + ' new message(s)');
    totalFetched += channelCount;
  });

  if (newRows.length > 0) {
    SheetService.appendObjects(CONFIG.SHEETS.RAW, newRows);
    Logger.log('📥 Staged ' + newRows.length + ' new Slack message(s) to raw.');
  } else {
    Logger.log('✅ No new messages from any channel.');
  }
}

/** Stage 2: Transform Raw Messages */
function transformRawMessages() {
  const rawData = SheetService.readAsObjects(CONFIG.SHEETS.RAW, RAW_HEADERS);
  if (rawData.rows.length === 0) return;

  const pendingRows = rawData.rows.filter(function (r) { return r.status === 'PENDING'; });
  if (pendingRows.length === 0) {
    Logger.log('ℹ️ No PENDING rows in raw to transform.');
    return;
  }

  Logger.log('🔄 Transforming ' + pendingRows.length + ' PENDING message(s)...');

  const mainToAppend = [];
  const cbToAppend = [];
  const rawUpdates = [];

  var stats = { parsed: 0, kept: 0, filtered: 0, unparsed: 0 };

  pendingRows.forEach(function (row) {
    var parsedList;
    try {
      parsedList = parseSlackAlert(row.raw_text, row.posted_at, row.channel_name);
    } catch (e) {
      parsedList = null;
      Logger.log('⚠️ Parse error row ' + row.__row + ': ' + e.message);
    }

    if (parsedList && parsedList.length > 0) {
      stats.parsed += parsedList.length;
      var keptAny = false;
      parsedList.forEach(function (item) {
        // Per-channel allowlist (see AlertFilters.shouldKeepAlert)
        if (!AlertFilters.shouldKeepAlert(item)) {
          stats.filtered++;
          Logger.log(
            '⏭️ Dropped (filter): ch=' + item.Channel +
            ' fmt=' + item.Format +
            ' token=' + item.Token +
            ' reason=' + String(item.Response || '').substring(0, 80)
          );
          return;
        }
        stats.kept++;
        keptAny = true;
        if (AlertFilters.isCbChannel(item.Channel) || item.Format === 'CB-Digest') {
          cbToAppend.push(item);
        } else {
          mainToAppend.push(item);
        }
      });
      rawUpdates.push({
        row: row.__row,
        values: {
          status: keptAny ? 'PROCESSED' : 'SKIPPED',
          error_message: keptAny ? '' : 'Filtered by channel allowlist'
        }
      });
    } else {
      stats.unparsed++;
      // Log a short preview so we can see which Slack formats still fail
      Logger.log(
        '❓ Unparsed ch=' + row.channel_name +
        ' text=' + String(row.raw_text || '').replace(/\s+/g, ' ').substring(0, 120)
      );
      rawUpdates.push({ row: row.__row, values: { status: 'SKIPPED', error_message: 'No parse result' } });
    }
  });

  Logger.log(
    '📊 Transform stats: pending=' + pendingRows.length +
    ' parsedRows=' + stats.parsed +
    ' kept=' + stats.kept +
    ' filtered=' + stats.filtered +
    ' unparsedMsgs=' + stats.unparsed
  );

  mainToAppend.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  cbToAppend.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });

  if (mainToAppend.length > 0) {
    SheetService.appendObjects(CONFIG.SHEETS.TRANSFORM, mainToAppend);
    Logger.log('✅ ' + mainToAppend.length + ' row(s) → transform');
  }
  if (cbToAppend.length > 0) {
    SheetService.appendObjects(CONFIG.SHEETS.TRANSFORM_CB, cbToAppend);
    Logger.log('✅ ' + cbToAppend.length + ' row(s) → transform_cb');
  }
  if (stats.kept === 0) {
    Logger.log('⚠️ Nothing kept — if Slack has older alerts, run resetSlackCursors() then fetchAndProcessPipeline(), or resetAndRebuildAllowlistedAlerts().');
  }

  if (rawUpdates.length > 0) SheetService.updateRowsInPlace(CONFIG.SHEETS.RAW, rawUpdates);

  SheetService.trimSheetBuffer(CONFIG.SHEETS.TRANSFORM, CONFIG.MAX_TRANSFORM_ROWS);
  SheetService.trimSheetBuffer(CONFIG.SHEETS.TRANSFORM_CB, CONFIG.MAX_TRANSFORM_CB_ROWS);

  // ✅ FIX 5: clear content instead of deleteRows (frozen-header safe)
  const cleared = SheetService.clearSheetDataRows(CONFIG.SHEETS.RAW);
  if (cleared > 0) {
    Logger.log('🗑️ Raw staging buffer cleared (' + cleared + ' row(s); ' + pendingRows.length + ' message(s) processed).');
  }
}

/** Stage 3: Aggregate into Alerts Sheet */
function buildAlertsSheet() {
  const txMain = SheetService.readAsObjects(CONFIG.SHEETS.TRANSFORM, TX_HEADERS).rows;
  const txCb = SheetService.readAsObjects(CONFIG.SHEETS.TRANSFORM_CB, TX_HEADERS).rows;
  // Re-apply allowlist so stale transform history (old reasons) cannot enter alerts
  const allRows = txMain.concat(txCb).filter(function (r) {
    return AlertFilters.shouldKeepAlert(r);
  });

  const alertsSheet = SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.ALERTS, AL_HEADERS);
  if (allRows.length === 0) {
    SheetService.clearSheetDataRows(CONFIG.SHEETS.ALERTS);
    Logger.log('ℹ️ No allowlisted rows — alerts sheet cleared.');
    try {
      if (typeof buildDashboard === 'function') buildDashboard();
    } catch (e) { /* optional */ }
    return;
  }

  const groups = {};
  allRows.forEach(function (r) {
    if (!r.Timestamp) return;
    const ts = new Date(r.Timestamp);
    if (isNaN(ts.getTime())) return;
    const key = (r.Token || 'UNKNOWN') + '|' + (r.Exchange || 'UNKNOWN') + '|' + r.Channel + '|' + r.Response;
    if (!groups[key]) {
      groups[key] = {
        token: r.Token || 'N/A', exchange: r.Exchange || 'N/A',
        account: r.Account || 'N/A', side: r.Side || 'N/A',
        channel: r.Channel, reason: r.Response,
        format: r.Format || '',
        timestamps: []
      };
    }
    groups[key].timestamps.push(ts);
  });

  const sessions = [];
  const now = new Date();

  Object.keys(groups).forEach(function (k) {
    const g = groups[k];
    const events = g.timestamps.sort(function (a, b) { return a - b; });
    var start = events[0], last = events[0], count = 1;
    for (var i = 1; i < events.length; i++) {
      if ((events[i] - last) / 60000 > CONFIG.INCIDENT_WINDOW_MINUTES) {
        sessions.push(createSessionRow(g, start, last, now, count));
        start = events[i]; count = 1;
      } else { count++; }
      last = events[i];
    }
    sessions.push(createSessionRow(g, start, last, now, count));
  });

  sessions.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'Live' ? -1 : 1;
    return b.latestTime - a.latestTime;
  });

  if (sessions.length > 0) {
    const output = sessions.map(function (s) {
      return [
        s.token, s.exchange, s.account, s.side, s.channel,
        s.firstTime, s.latestTime, s.duration, s.status, s.sessionDate,
        s.occurrence, s.reason, s.reasonCategory, s.rejectionType
      ];
    });

    // Clear all data rows, then write with getRange(row, column, numRows, numColumns)
    SheetService.clearSheetDataRows(CONFIG.SHEETS.ALERTS);
    const n = output.length;
    alertsSheet.getRange(2, 1, n, AL_HEADERS.length).setValues(output);
    alertsSheet.getRange(2, 6, n, 1).setNumberFormat('M/d/yyyy HH:mm:ss');
    alertsSheet.getRange(2, 7, n, 1).setNumberFormat('M/d/yyyy HH:mm:ss');
    alertsSheet.getRange(2, 8, n, 1).setNumberFormat('0');
    alertsSheet.getRange(2, 11, n, 1).setNumberFormat('0');

    const bgColors = sessions.map(function (s) { return [s.status === 'Live' ? '#d9ead3' : '#fce5cd']; });
    const fontColors = sessions.map(function (s) { return [s.status === 'Live' ? '#274e13' : '#7f2e00']; });
    alertsSheet.getRange(2, 9, n, 1).setBackgrounds(bgColors).setFontColors(fontColors);

    Logger.log('📊 alerts rebuilt: ' + sessions.length + ' session(s).');
  }

  // Refresh sheet dashboard after alerts rebuild (web app reads alerts live)
  try {
    if (typeof buildDashboard === 'function') buildDashboard();
  } catch (dashErr) {
    Logger.log('⚠️ buildDashboard skipped: ' + dashErr.message);
  }
}

function createSessionRow(g, start, last, now, count) {
  const duration = Math.round((last - start) / 60000);
  const gapSinceLast = Math.round((now - last) / 60000);
  const status = gapSinceLast > CONFIG.INCIDENT_WINDOW_MINUTES ? 'Stopped' : 'Live';
  const cls = (typeof classifyReason_ === 'function')
    ? classifyReason_(g.reason, g.format, g.channel)
    : { reasonCategory: 'Other', rejectionType: 'Uncategorized', severity: 'Low' };
  return {
    token: g.token, exchange: g.exchange, account: g.account,
    side: g.side, channel: g.channel,
    firstTime: start, latestTime: last, duration: duration,
    status: status,
    sessionDate: Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    occurrence: count, reason: g.reason,
    reasonCategory: cls.reasonCategory,
    rejectionType: cls.rejectionType,
    severity: cls.severity
  };
}


// ============================================================================
// SECTION 5: ORCHESTRATOR & TRIGGERS
// ============================================================================

/** ✅ FIX 3: setupSheets clears raw first so stale old-format headers are wiped */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rawSheet = ss.getSheetByName(CONFIG.SHEETS.RAW);
  if (rawSheet) {
    rawSheet.clearContents();
    Logger.log('🗑️ Cleared stale raw sheet contents.');
  }

  SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.RAW, RAW_HEADERS);
  SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.TRANSFORM, TX_HEADERS);
  SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.TRANSFORM_CB, TX_HEADERS);
  SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.ALERTS, AL_HEADERS);
  Logger.log('✅ All sheets initialized with correct headers.');
}

function fetchAndProcessPipeline() {
  fetchSlackMessages();
  transformRawMessages();
  buildAlertsSheet(); // also rebuilds dashboard tab when Dashboard.gs is present
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'fetchAndProcessPipeline') ScriptApp.deleteTrigger(t);
  });
  const mins = CONFIG.TRIGGER_MINUTES || 1;
  ScriptApp.newTrigger('fetchAndProcessPipeline').timeBased().everyMinutes(mins).create();
  Logger.log('⏰ Pipeline trigger installed (every ' + mins + ' minute(s)).');
}

/** Clears cursors so the next fetch uses CONFIG.LOOKBACK_DAYS (currently 7). */
function resetSlackCursors() {
  const props = PropertiesService.getScriptProperties();
  CONFIG.CHANNELS.forEach(function (c) { props.deleteProperty('CURSOR_' + c.id); });
  Logger.log('🔄 Cursors reset — next run fetches last ' + CONFIG.LOOKBACK_DAYS + ' day(s).');
}

/** @deprecated use resetSlackCursors */
function resetSlackCursorsTo48Hours() {
  resetSlackCursors();
}

/**
 * One-time cleanup for testing:
 * clears transform/alerts/raw, resets cursors (7-day lookback), runs pipeline once.
 * Then run installTrigger() for every-1-minute incremental fetches.
 */
function resetAndRebuildAllowlistedAlerts() {
  SheetService.clearSheetDataRows(CONFIG.SHEETS.TRANSFORM);
  SheetService.clearSheetDataRows(CONFIG.SHEETS.TRANSFORM_CB);
  SheetService.clearSheetDataRows(CONFIG.SHEETS.ALERTS);
  SheetService.clearSheetDataRows(CONFIG.SHEETS.RAW);
  resetSlackCursors();
  fetchAndProcessPipeline();
  Logger.log('✅ Transform/alerts rebuilt with allowlisted reasons (lookback ' + CONFIG.LOOKBACK_DAYS + 'd).');
  Logger.log('👉 Next: run installTrigger() for every-' + CONFIG.TRIGGER_MINUTES + '-minute fetches.');
}

/** Diagnostic: shows what token key is set and its first 10 chars */
function checkConfig() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.SLACK_BOT_TOKEN_PROP);
  Logger.log('Token key:   ' + CONFIG.SLACK_BOT_TOKEN_PROP);
  Logger.log('Token found: ' + (token ? 'YES (' + token.substring(0, 10) + '...)' : 'NO — run setSlackToken() or check Script Properties'));
  Logger.log('Lookback:    ' + CONFIG.LOOKBACK_DAYS + ' day(s)');
  Logger.log('Trigger:     every ' + CONFIG.TRIGGER_MINUTES + ' minute(s)');
  CONFIG.CHANNELS.forEach(function (c) {
    const cursor = PropertiesService.getScriptProperties().getProperty('CURSOR_' + c.id);
    Logger.log('Cursor ' + c.name + ' (' + c.id + '): ' + (cursor || '(none — will use ' + CONFIG.LOOKBACK_DAYS + 'd window)'));
  });
}
