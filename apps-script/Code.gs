/**
 * ============================================================================
 *  Slack Rejection Alert Monitoring System — Production Pipeline (V2.2)
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
    // Formerly labeled "IF-Mercury" — insufficient-funds rails rejections
    { id: 'C0BDYE1RQTH', name: 'insufficient-funds-rails-mercury-rejections' },
    { id: 'C08TQHSSL73', name: 'alerts-action-required-mercury' },
    { id: 'C01R3QCR62Y', name: 'alerts-exchange-funds' },
    { id: 'C0BCN9QG679', name: 'CB-Rejection' },
    { id: 'C08T9KQGQ13', name: 'Mercury' }
  ],

  CB_CHANNEL_NAME: 'CB-Rejection',
  INCIDENT_WINDOW_MINUTES: 30,
  MAX_TRANSFORM_ROWS: 5000,
  MAX_TRANSFORM_CB_ROWS: 30000,

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
  'Status', 'Session Date', 'Occurrence', 'Reason', 'Reason Category'
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
    const cleared = lastRow - 1;
    sheet.getRange(2, 1, lastRow, lastCol).clearContent();
    return cleared;
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
    const endRow = startRow + rows.length - 1;
    sheet.getRange(startRow, 1, endRow, hdrs.length).setValues(rows);
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

  /** Strip Slack bold/italic asterisks and surrounding quotes/backticks. */
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

  normalizeAlertText: function (text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[•\u2022\u2023]/g, '\n')
      .replace(/\n+/g, '\n')
      .trim();
  },

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


// ============================================================================
// SECTION 3: PARSER ENGINE
// ============================================================================

function parseSlackAlert(rawText, timestamp, channelName) {
  if (!rawText || !String(rawText).trim()) return null;
  const text = String(rawText).trim();
  const normalized = ParserUtils.normalizeAlertText(text);
  const clean = ParserUtils.stripMarkdown(text);

  try {
    // FORMAT A/B: Key-Value or Bullet-List (OrderId present or "Order rejected on")
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
        const tsKey = Utilities.formatDate(
          new Date(timestamp), Session.getScriptTimeZone(), 'yyyyMMddHHmmss'
        );
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
      var orderObj = {}, errObj = {};
      const orderJsonMatch = text.match(/\{"version"[\s\S]*?\}/) || text.match(/\{[\s\S]*?\}/);
      if (orderJsonMatch) { try { orderObj = JSON.parse(orderJsonMatch[0]); } catch (e) {} }
      const errJsonMatch = text.match(/\{"Code"[\s\S]*?\}/);
      if (errJsonMatch) { try { errObj = JSON.parse(errJsonMatch[0]); } catch (e) {} }
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
        Side: '', Qty: '', Account: '',
        Response: msgMatch ? msgMatch[1] : 'Order rejected',
        ErrorCode: codeMatch ? codeMatch[1] : '',
        OrderId: orderIdMatch ? orderIdMatch[1].trim() : '',
        Format: 'JSON-Futures',
        Channel: channelName,
        RawText: text
      }];
    }

    // FORMAT F: CB-Rejection Rollup Digest
    if (channelName === CONFIG.CB_CHANNEL_NAME || /Order Rejections/i.test(text)) {
      const VOLATILE_REASON = 'the market is too volatile right now. please try again later.';
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
        const tsKey = Utilities.formatDate(alertTs, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
        const dedupKey = token + '_' + userId.substring(0, 8) + '_' + tsKey + '_F';
        expandedRows.push({
          Timestamp: alertTs, Exchange: 'CB', Token: token, Side: side,
          Qty: '', Account: userId, Response: reason, ErrorCode: '',
          OrderId: dedupKey, Format: 'CB-Digest', Channel: channelName, RawText: line
        });
      });
      if (expandedRows.length > 0) return expandedRows;
      return null;
    }

  } catch (err) {
    Logger.log('⚠️ Parser exception: ' + err.message);
  }

  return [{
    Timestamp: timestamp, Exchange: '', Token: '', Side: '', Qty: '',
    Account: '', Response: 'UNMATCHED FORMAT', ErrorCode: '', OrderId: '',
    Format: 'UNMATCHED', Channel: channelName, RawText: text
  }];
}


// ============================================================================
// SECTION 4: PIPELINE EXECUTOR
// ============================================================================

/** Stage 1: Fetch Slack Messages with Self-Healing 48h Window + Dedup */
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
    // Include the last data row (previously off-by-one: rawLastRow - 1)
    rawSheet.getRange(2, 1, rawLastRow, 1).getValues()
      .forEach(function (row) {
        if (row[0]) existingIds[String(row[0])] = true;
      });
  }

  const fortyEightHoursAgo = new Date(Date.now() - (48 * 60 * 60 * 1000));
  const defaultOldestTs = (fortyEightHoursAgo.getTime() / 1000).toFixed(6);

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
        if (!msg.text || !msg.text.trim()) return;
        if (existingIds[msg.ts]) return;
        existingIds[msg.ts] = true;

        newRows.push({
          message_id: msg.ts,
          channel_id: channel.id,
          channel_name: channel.name,
          raw_text: msg.text,
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

  pendingRows.forEach(function (row) {
    var parsedList;
    try {
      parsedList = parseSlackAlert(row.raw_text, row.posted_at, row.channel_name);
    } catch (e) {
      parsedList = null;
      Logger.log('⚠️ Parse error row ' + row.__row + ': ' + e.message);
    }

    if (parsedList && parsedList.length > 0) {
      parsedList.forEach(function (item) {
        // Filter: skip Gateio insufficient-funds from alerts-action-required-mercury.
        if (item.Channel === 'alerts-action-required-mercury' &&
            item.Exchange && item.Exchange.toLowerCase() === 'gateio') {
          const resp = (item.Response || '').toLowerCase();
          const errCode = (item.ErrorCode || '').toLowerCase();
          const INSUF = ['insufficientfunds', 'balance_not_enough', 'not enough balance',
                         'balance insufficient', 'insufficient'];
          const isInsufficient = INSUF.some(function (kw) { return resp.indexOf(kw) !== -1; })
                              || errCode.indexOf('insufficient') !== -1
                              || errCode === 'insufficient_funds';
          if (isInsufficient) {
            Logger.log('⏭️ Skipped Gateio insufficient-funds alert (filtered): ' + item.Token);
            return;
          }
        }

        if (item.Channel === CONFIG.CB_CHANNEL_NAME || item.Format === 'CB-Digest') {
          cbToAppend.push(item);
        } else {
          mainToAppend.push(item);
        }
      });
      rawUpdates.push({ row: row.__row, values: { status: 'PROCESSED', error_message: '' } });
    } else {
      rawUpdates.push({ row: row.__row, values: { status: 'SKIPPED', error_message: 'No parse result' } });
    }
  });

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
  const allRows = txMain.concat(txCb);

  const alertsSheet = SheetService.ensureSheetWithHeaders(CONFIG.SHEETS.ALERTS, AL_HEADERS);
  if (allRows.length === 0) return;

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
        channel: r.Channel, reason: r.Response, timestamps: []
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
        s.occurrence, s.reason, 'General'
      ];
    });

    // Clear all data rows (not lastRow-1 — that left the final row stale)
    SheetService.clearSheetDataRows(CONFIG.SHEETS.ALERTS);
    const endRow = output.length + 1; // row 1 = headers
    alertsSheet.getRange(2, 1, endRow, AL_HEADERS.length).setValues(output);
    alertsSheet.getRange(2, 6, endRow, 6).setNumberFormat('M/d/yyyy HH:mm:ss');
    alertsSheet.getRange(2, 7, endRow, 7).setNumberFormat('M/d/yyyy HH:mm:ss');
    alertsSheet.getRange(2, 8, endRow, 8).setNumberFormat('0');
    alertsSheet.getRange(2, 11, endRow, 11).setNumberFormat('0');

    const bgColors = sessions.map(function (s) { return [s.status === 'Live' ? '#d9ead3' : '#fce5cd']; });
    const fontColors = sessions.map(function (s) { return [s.status === 'Live' ? '#274e13' : '#7f2e00']; });
    alertsSheet.getRange(2, 9, endRow, 9).setBackgrounds(bgColors).setFontColors(fontColors);

    Logger.log('📊 alerts rebuilt: ' + sessions.length + ' session(s).');
  }
}

function createSessionRow(g, start, last, now, count) {
  const duration = Math.round((last - start) / 60000);
  const gapSinceLast = Math.round((now - last) / 60000);
  const status = gapSinceLast > CONFIG.INCIDENT_WINDOW_MINUTES ? 'Stopped' : 'Live';
  return {
    token: g.token, exchange: g.exchange, account: g.account,
    side: g.side, channel: g.channel,
    firstTime: start, latestTime: last, duration: duration,
    status: status,
    sessionDate: Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    occurrence: count, reason: g.reason
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
  buildAlertsSheet();
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'fetchAndProcessPipeline') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fetchAndProcessPipeline').timeBased().everyMinutes(5).create();
  Logger.log('⏰ Pipeline trigger installed (every 5 minutes).');
}

function resetSlackCursorsTo48Hours() {
  const props = PropertiesService.getScriptProperties();
  CONFIG.CHANNELS.forEach(function (c) { props.deleteProperty('CURSOR_' + c.id); });
  Logger.log('🔄 Cursors reset — next run fetches last 48 hours.');
}

/** Diagnostic: shows what token key is set and its first 10 chars */
function checkConfig() {
  const token = PropertiesService.getScriptProperties().getProperty(CONFIG.SLACK_BOT_TOKEN_PROP);
  Logger.log('Token key:   ' + CONFIG.SLACK_BOT_TOKEN_PROP);
  Logger.log('Token found: ' + (token ? 'YES (' + token.substring(0, 10) + '...)' : 'NO — run setSlackToken() or check Script Properties'));
  CONFIG.CHANNELS.forEach(function (c) {
    const cursor = PropertiesService.getScriptProperties().getProperty('CURSOR_' + c.id);
    Logger.log('Cursor ' + c.name + ' (' + c.id + '): ' + (cursor || '(none — will use 48h window)'));
  });
}
