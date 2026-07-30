/**
 * Shared configuration for Token Health trackers.
 * Prefer Script Properties for secrets (CMC_API_KEY).
 */
var CONFIG = {
  // Fallback only — prefer PropertiesService.getScriptProperties().getProperty('CMC_API_KEY')
  CMC_API_KEY: '',

  CMC_CHUNK_SIZE: 60,
  CMC_SLEEP_MS: 100,

  TIMEZONE: 'Asia/Kolkata',

  // Binance hosts tried in order on ticker failures
  BINANCE_TICKER_URLS: [
    'https://data-api.binance.vision/api/v3/ticker/24hr',
    'https://api.binance.com/api/v3/ticker/24hr',
    'https://api1.binance.com/api/v3/ticker/24hr',
    'https://api2.binance.com/api/v3/ticker/24hr',
    'https://api3.binance.com/api/v3/ticker/24hr'
  ],

  BINANCE_CHAIN_URL: 'https://www.binance.com/bapi/capital/v2/public/capital/getNetworkCoinAll',
  KUCOIN_TICKER_URL: 'https://api.kucoin.com/api/v1/market/allTickers',
  KUCOIN_CHAIN_URL: 'https://api.kucoin.com/api/v1/currencies',
  GATE_TICKER_URL: 'https://api.gateio.ws/api/v4/spot/tickers',
  GATE_CHAIN_URL: 'https://api.gateio.ws/api/v4/spot/currencies',

  BINANCE_MAX_ATTEMPTS: 3,
  BINANCE_RETRY_SLEEP_MS: 400,

  ALERT_RECIPIENTS: [
    'aditya.arya@coindcx.com',
    'abdul.khan@coindcx.com',
    'akash.naidu@coindcx.com',
    'ayush.agarwal@coindcx.com',
    'chitresh.kashyap@coindcx.com',
    'cletus.dias@coindcx.com',
    'harsh.pandey@coindcx.com',
    'harshit.gupta@coindcx.com',
    'jatin.bisht@coindcx.com',
    'jayadrath.rondal@coindcx.com',
    'mihir.sutariya@coindcx.com',
    'mohit.mittal@coindcx.com',
    'obaid.rehman@coindcx.com',
    'ronak.keny@coindcx.com',
    'sujay.patil@coindcx.com',
    'therese.joseph@coindcx.com'
  ]
};

function getCmcApiKey_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('CMC_API_KEY');
  if (fromProps && String(fromProps).trim()) return String(fromProps).trim();
  return CONFIG.CMC_API_KEY || '';
}

/** Run once from the Apps Script editor to store the CMC key securely. */
function setCmcApiKey() {
  var key = 'PASTE_YOUR_CMC_KEY_HERE';
  if (!key || key.indexOf('PASTE_') === 0) {
    throw new Error('Replace PASTE_YOUR_CMC_KEY_HERE with your real CMC API key, then run setCmcApiKey().');
  }
  PropertiesService.getScriptProperties().setProperty('CMC_API_KEY', key);
  Logger.log('CMC_API_KEY saved to Script Properties.');
}
