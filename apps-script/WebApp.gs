/**
 * ============================================================
 *  Rejection Dashboard — Web App backend (V2.3 compatible)
 *
 *  Same Apps Script project as Code.gs + Dashboard.gs.
 *  Deploy: Deploy → New deployment → Web app
 *    Execute as: Me
 *    Who has access: your org / anyone with link
 *
 *  Exposes:
 *    doGet() → Index.html
 *    getDashboardData(range) → JSON for Chart.js UI
 * ============================================================
 */

var PERSIST_THRESHOLD_MIN = 30;

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Rejection Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function parseRange_(range, tz) {
  var dayMs = 86400000;
  var startOfDay = function (d) {
    return new Date(Utilities.formatDate(d, tz, 'yyyy/MM/dd'));
  };
  var keyOf = function (d) {
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  };

  var now = new Date();
  var todayStart = startOfDay(now);
  var type = (range && range.type) ? range.type : 'today';
  var startD;
  var endD;
  var label;

  if (type === 'custom' && range && range.start && range.end) {
    startD = new Date(range.start + 'T00:00:00');
    endD = new Date(range.end + 'T00:00:00');
    if (endD < startD) {
      var t = startD;
      startD = endD;
      endD = t;
    }
    label = keyOf(startD) + ' → ' + keyOf(endD);
  } else if (type === 'yesterday') {
    startD = new Date(todayStart.getTime() - dayMs);
    endD = startD;
    label = 'Yesterday';
  } else if (type === 'last7') {
    startD = new Date(todayStart.getTime() - 6 * dayMs);
    endD = todayStart;
    label = 'Last 7 days';
  } else {
    type = 'today';
    startD = todayStart;
    endD = todayStart;
    label = 'Today';
  }

  var spanDays = Math.round((endD - startD) / dayMs) + 1;
  var prevEnd = new Date(startD.getTime() - dayMs);
  var prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * dayMs);

  return {
    type: type,
    startKey: keyOf(startD),
    endKey: keyOf(endD),
    prevStartKey: keyOf(prevStart),
    prevEndKey: keyOf(prevEnd),
    label: label,
    singleDay: spanDays === 1
  };
}

/**
 * Dashboard payload from alerts tab.
 * Columns: A..N (Reason Category M, Rejection Type N)
 */
function getDashboardData(range) {
  var ss = getSS_();
  var sh = ss.getSheetByName(SH_ALERTS);
  var tz = tz_();
  var threshold = (typeof HIGH_OCCURRENCE_THRESHOLD === 'number') ? HIGH_OCCURRENCE_THRESHOLD : 100;
  var persistMin = (typeof PERSIST_THRESHOLD_MIN === 'number') ? PERSIST_THRESHOLD_MIN : 30;
  var R = parseRange_(range, tz);

  var empty = {
    updatedAt: Utilities.formatDate(new Date(), tz, 'MMM d, yyyy HH:mm:ss'),
    threshold: threshold,
    persistMin: persistMin,
    range: R,
    scorecards: {
      total: 0, totalTokens: 0, totalOcc: 0,
      cb: 0, cbTokens: 0, cbOcc: 0, active: 0
    },
    deltas: { total: 0, cb: 0, active: 0 },
    byTypePersisted: {},
    persistedTotal: 0,
    persistedTokenList: [],
    trendBuckets: [],
    trendMode: 'time',
    highOccList: [],
    rejectionTable: []
  };

  if (!sh) return empty;
  var last = sh.getLastRow();
  if (last < 2) return empty;

  var data = sh.getRange(2, 1, last - 1, 14).getValues();

  var inRange = function (key) { return key >= R.startKey && key <= R.endKey; };
  var inPrev = function (key) { return key >= R.prevStartKey && key <= R.prevEndKey; };

  var agg = { total: 0, totalOcc: 0, cb: 0, cbOcc: 0, active: 0 };
  var prevAgg = { total: 0, cb: 0, active: 0 };
  var cbTokenSet = {};
  var totalTokenSet = {};
  var byTypePersisted = {};
  var persistedTotal = 0;
  var persistedTokens = {};

  var NUM_BUCKETS = 48;
  var timeBuckets = [];
  for (var b = 0; b < NUM_BUCKETS; b++) {
    timeBuckets.push({ cb: 0, other: 0, cbOcc: 0, otherOcc: 0 });
  }
  var dateBuckets = {};
  var highOcc = {};
  var rejectionTable = [];

  data.forEach(function (row) {
    var token = row[0];
    var exchange = row[1];
    var account = row[2];
    var durationM = Number(row[7]) || 0;
    var status = row[8];
    var sessDate = row[9];
    var occ = Number(row[10]) || 1;
    var reason = row[11];
    var rejType = row[13] || 'Uncategorized';
    if (!sessDate) return;

    var dObj = new Date(sessDate);
    var dKey = Utilities.formatDate(dObj, tz, 'yyyy-MM-dd');

    if (inPrev(dKey)) {
      prevAgg.total++;
      if (rejType === 'CB Rejection') prevAgg.cb++;
      if (status === 'Live') prevAgg.active++;
    }

    if (!inRange(dKey)) return;

    agg.total++;
    agg.totalOcc += occ;
    if (token) totalTokenSet[token] = true;
    if (rejType === 'CB Rejection') {
      agg.cb++;
      agg.cbOcc += occ;
      if (token) cbTokenSet[token] = true;
    }
    if (status === 'Live') agg.active++;

    if (durationM >= persistMin) {
      byTypePersisted[rejType] = (byTypePersisted[rejType] || 0) + 1;
      persistedTotal++;
      if (token) {
        if (!persistedTokens[token]) {
          persistedTokens[token] = { occurrence: 0, exchange: exchange, status: status };
        }
        persistedTokens[token].occurrence += occ;
        if (status === 'Live') persistedTokens[token].status = 'Live';
      }
    }

    if (R.singleDay) {
      var hr = Number(Utilities.formatDate(dObj, tz, 'H'));
      var mn = Number(Utilities.formatDate(dObj, tz, 'm'));
      var bIdx = hr * 2 + (mn >= 30 ? 1 : 0);
      if (bIdx >= 0 && bIdx < NUM_BUCKETS) {
        if (rejType === 'CB Rejection') {
          timeBuckets[bIdx].cb++;
          timeBuckets[bIdx].cbOcc += occ;
        } else {
          timeBuckets[bIdx].other++;
          timeBuckets[bIdx].otherOcc += occ;
        }
      }
    } else {
      if (!dateBuckets[dKey]) dateBuckets[dKey] = { cb: 0, other: 0, cbOcc: 0, otherOcc: 0 };
      if (rejType === 'CB Rejection') {
        dateBuckets[dKey].cb++;
        dateBuckets[dKey].cbOcc += occ;
      } else {
        dateBuckets[dKey].other++;
        dateBuckets[dKey].otherOcc += occ;
      }
    }

    if (occ > threshold) {
      if (!highOcc[token]) highOcc[token] = { occurrence: 0, exchange: exchange, status: status };
      highOcc[token].occurrence += occ;
      if (status === 'Live') highOcc[token].status = 'Live';
    }

    if (rejType === 'CB Rejection') {
      rejectionTable.push({
        token: token,
        exchange: exchange,
        account: account,
        reason: reason,
        type: rejType,
        duration: durationM,
        occurrence: occ,
        status: status
      });
    }
  });

  var persistedTokenList = Object.keys(persistedTokens).map(function (t) {
    return {
      token: t,
      occurrence: persistedTokens[t].occurrence,
      exchange: persistedTokens[t].exchange,
      status: persistedTokens[t].status
    };
  }).sort(function (a, b) { return b.occurrence - a.occurrence; });

  var highOccList = Object.keys(highOcc).map(function (t) {
    return {
      token: t,
      occurrence: highOcc[t].occurrence,
      exchange: highOcc[t].exchange,
      status: highOcc[t].status
    };
  }).sort(function (a, b) { return b.occurrence - a.occurrence; });

  rejectionTable.sort(function (a, b) { return b.occurrence - a.occurrence; });

  var trendBuckets;
  var trendMode;
  if (R.singleDay) {
    trendMode = 'time';
    trendBuckets = timeBuckets.map(function (bucket, i) {
      var h = Math.floor(i / 2);
      var m = (i % 2) === 0 ? '00' : '30';
      var label = (h < 10 ? '0' + h : '' + h) + ':' + m;
      return {
        label: label,
        cb: bucket.cb,
        other: bucket.other,
        cbOcc: bucket.cbOcc,
        otherOcc: bucket.otherOcc
      };
    });
  } else {
    trendMode = 'date';
    var keys = Object.keys(dateBuckets).sort();
    trendBuckets = keys.map(function (k) {
      return {
        label: k.slice(5),
        cb: dateBuckets[k].cb,
        other: dateBuckets[k].other,
        cbOcc: dateBuckets[k].cbOcc,
        otherOcc: dateBuckets[k].otherOcc
      };
    });
  }

  return {
    updatedAt: Utilities.formatDate(new Date(), tz, 'MMM d, yyyy HH:mm:ss'),
    threshold: threshold,
    persistMin: persistMin,
    range: R,
    scorecards: {
      total: agg.total,
      totalTokens: Object.keys(totalTokenSet).length,
      totalOcc: agg.totalOcc,
      cb: agg.cb,
      cbTokens: Object.keys(cbTokenSet).length,
      cbOcc: agg.cbOcc,
      active: agg.active
    },
    deltas: {
      total: agg.total - prevAgg.total,
      cb: agg.cb - prevAgg.cb,
      active: agg.active - prevAgg.active
    },
    byTypePersisted: byTypePersisted,
    persistedTotal: persistedTotal,
    persistedTokenList: persistedTokenList,
    trendBuckets: trendBuckets,
    trendMode: trendMode,
    highOccList: highOccList,
    rejectionTable: rejectionTable
  };
}
