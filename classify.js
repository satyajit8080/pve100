// @ts-check
/*
 * US-equity classifier — server-side gate that runs on normalized PVE markets BEFORE the signal
 * engine sees them. Prediction-market metadata is not a clean asset-class taxonomy, so this is a
 * heuristic that ERRS TOWARD EXCLUSION: if a market cannot be confidently tied to a US stock/ETF,
 * it is rejected (per the brief's "if uncertain, EXCLUDE" rule). No fabrication, no guessing.
 */

export const CLASSIFIER_VERSION = 'clf-1.0.0';

// Curated US-equity universe (large-caps). Extend via env US_EQUITY_TICKERS. Not exhaustive S&P 500,
// but covers the names most likely to appear in stock-related prediction markets. Tickers that collide
// with crypto/deny words (e.g. COIN) are intentionally omitted to avoid misclassification.
export const DEFAULT_TICKERS = new Set([
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AVGO', 'ORCL', 'AMD', 'ADBE', 'CRM', 'NFLX',
  'INTC', 'CSCO', 'QCOM', 'TXN', 'AMAT', 'MU', 'PYPL', 'SHOP', 'UBER', 'ABNB', 'PLTR', 'SNOW', 'NOW', 'INTU',
  'IBM', 'PANW', 'CRWD', 'DDOG', 'MDB', 'TEAM', 'WDAY', 'ZM', 'ROKU', 'HOOD', 'SOFI', 'RBLX', 'SPOT', 'PINS',
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'MA', 'WMT', 'COST', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD', 'KO', 'PEP', 'PG',
  'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'CVS', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN', 'GILD', 'MRNA',
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'BA', 'CAT', 'DE', 'GE', 'HON', 'MMM', 'LMT', 'RTX', 'UPS', 'FDX',
  'DIS', 'CMCSA', 'TMUS', 'RIVN', 'LCID', 'GM', 'MARA', 'DELL', 'HPQ', 'MSTR', 'SMCI', 'ARM', 'ASML',
]);

export const DEFAULT_ETFS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VEA', 'VWO', 'XLF', 'XLE', 'XLK', 'XLV', 'XLI', 'XLY', 'XLP',
  'XLU', 'XLB', 'XLC', 'SMH', 'SOXX', 'XBI', 'ARKK', 'ARKG', 'TLT', 'IEF', 'HYG', 'LQD', 'GLD', 'SLV',
  'USO', 'UNG', 'VXX', 'UVXY', 'SQQQ', 'TQQQ', 'SPXL', 'SPXS',
]);

// Hard-exclude tickers (crypto). These override any accidental allow match.
const DENY_TICKERS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'BNB', 'LTC', 'SHIB', 'AVAX', 'DOT', 'MATIC', 'LINK', 'TRX', 'BCH', 'XLM', 'USDT', 'USDC', 'PEPE', 'WIF', 'BONK']);

// Category deny-term patterns. Order matters only for labeling the reason.
const DENY_CATEGORIES = [
  ['CRYPTO', /\b(crypto|bitcoin|ethereum|solana|dogecoin|blockchain|token|altcoin|stablecoin|defi|nft|satoshi|halving|memecoin|web3)\b/i],
  ['POLITICS', /\b(election|president|presidential|senate|congress|governor|parliament|prime minister|vote|ballot|primary|democrat|republican|gop|impeach|referendum|nominee|electoral)\b/i],
  ['SPORTS', /\b(nfl|nba|mlb|nhl|ufc|mma|premier league|la liga|super bowl|world cup|playoff|championship|touchdown|goalscorer|match|fixture|grand prix|f1 race|golf|tennis|cricket|soccer|football game)\b/i],
  ['WEATHER', /\b(weather|temperature|rainfall|hurricane|snowfall|climate|degrees|heatwave)\b/i],
  ['OTHER', /\b(oscars|grammy|box office|rotten tomatoes|celebrity|royal|award show|eurovision)\b/i],
];

// Phrases that suggest a US-equity event market (used only as a secondary, weak signal).
const EQUITY_PHRASES = /\b(stock|shares?|earnings|market cap|all-time high|ath|close (above|below)|nasdaq|nyse|s&p|s and p|dow jones|russell)\b/i;

const CASHTAG = /\$([A-Za-z]{1,5})\b/g;

function textOf(m) {
  return [m && m.title, m && m.slug, Array.isArray(m && m.tags) ? m.tags.join(' ') : ''].filter(Boolean).join(' ');
}
function wholeWord(ticker, upperText) {
  // length<=2 tickers only match via cashtag (handled separately) to avoid false positives like "F"/"GE"
  if (ticker.length < 3) return false;
  return new RegExp('\\b' + ticker + '\\b').test(upperText);
}
function cashtags(text) {
  const out = new Set(); let m;
  CASHTAG.lastIndex = 0;
  while ((m = CASHTAG.exec(text))) out.add(m[1].toUpperCase());
  return out;
}

/**
 * @param {*} market normalized market {slug,title,tags,volume,liquidity,outcomes}
 * @param {*} [cfg] { allowTickers?:Set, allowEtfs?:Set, denyTickers?:Set }
 * @returns {{asset_type:string, classification:('ALLOWED'|'REJECTED'), reason:string, confidence:number, ticker:(string|null), version:string}}
 */
export function classifyMarket(market, cfg = {}) {
  const allow = cfg.allowTickers || DEFAULT_TICKERS;
  const etfs = cfg.allowEtfs || DEFAULT_ETFS;
  const deny = cfg.denyTickers || DENY_TICKERS;
  const text = textOf(market);
  const upper = text.toUpperCase();
  const tags = cashtags(text);
  const R = (asset_type, classification, reason, confidence, ticker = null) =>
    ({ asset_type, classification, reason, confidence, ticker, version: CLASSIFIER_VERSION });

  // 1) HARD DENY — crypto/politics/sports/weather/other terms, or a crypto ticker (cashtag or word)
  for (const [cat, re] of DENY_CATEGORIES) if (re.test(text)) return R(cat, 'REJECTED', `${cat.toLowerCase()} term match`, 0.95);
  for (const t of deny) { if (tags.has(t) || wholeWord(t, upper)) return R('CRYPTO', 'REJECTED', `crypto ticker ${t}`, 0.95, t); }

  // 2) ALLOW — a known ETF or equity ticker (cashtag for any length; whole-word for length>=3)
  for (const t of tags) { if (etfs.has(t)) return R('US_ETF', 'ALLOWED', `$${t} ETF match`, 0.9, t); }
  for (const t of tags) { if (allow.has(t)) return R('US_EQUITY', 'ALLOWED', `$${t} ticker match`, 0.9, t); }
  for (const t of etfs) { if (wholeWord(t, upper)) return R('US_ETF', 'ALLOWED', `${t} ETF match`, 0.85, t); }
  for (const t of allow) { if (wholeWord(t, upper)) return R('US_EQUITY', 'ALLOWED', `${t} ticker match`, 0.85, t); }

  // 3) AMBIGUOUS — equity phrasing but no known ticker → EXCLUDE (uncertain)
  if (EQUITY_PHRASES.test(text)) return R('UNKNOWN', 'REJECTED', 'equity phrasing but no known ticker', 0.5);

  // 4) Everything else → EXCLUDE
  return R('UNKNOWN', 'REJECTED', 'ambiguous market', 0.5);
}

/**
 * @param {*[]} markets @param {*} [cfg]
 * @returns {{allowed:*[], rejected:{slug:*,title:*,asset_type:string,reason:string,confidence:number}[], stats:*, decisions:*[]}}
 */
export function filterMarkets(markets, cfg = {}) {
  const allowed = []; const rejected = []; const decisions = [];
  const byReason = {}; const byType = {};
  for (const m of markets || []) {
    const d = classifyMarket(m, cfg);
    decisions.push({ slug: m.slug, title: m.title, ...d });
    byType[d.asset_type] = (byType[d.asset_type] || 0) + 1;
    if (d.classification === 'ALLOWED') {
      allowed.push({ ...m, asset_type: d.asset_type, ticker: d.ticker, classification: d });
    } else {
      byReason[d.reason] = (byReason[d.reason] || 0) + 1;
      rejected.push({ slug: m.slug, title: m.title, asset_type: d.asset_type, reason: d.reason, confidence: d.confidence });
    }
  }
  const stats = { received: (markets || []).length, accepted: allowed.length, rejected: rejected.length, byReason, byType, version: CLASSIFIER_VERSION, ts: new Date().toISOString() };
  return { allowed, rejected, stats, decisions };
}

/** Build a classifier config from environment overrides (comma-separated tickers). */
export function configFromEnv(env = {}) {
  const cfg = {};
  const parse = (s) => new Set(String(s).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
  if (env.US_EQUITY_TICKERS) cfg.allowTickers = new Set([...DEFAULT_TICKERS, ...parse(env.US_EQUITY_TICKERS)]);
  if (env.US_EQUITY_ETFS) cfg.allowEtfs = new Set([...DEFAULT_ETFS, ...parse(env.US_EQUITY_ETFS)]);
  if (env.EXTRA_DENY_TICKERS) cfg.denyTickers = new Set([...DENY_TICKERS, ...parse(env.EXTRA_DENY_TICKERS)]);
  return cfg;
}

// =====================================================================
//  EXPLORER categorization — groups ALL PVE markets by asset_type for the
//  PVE Data Explorer. This is DISPLAY-ONLY. The signal engine still uses
//  filterMarkets() (US_EQUITY/US_ETF only); categorizeMarkets never feeds scoring.
// =====================================================================
export const ASSET_CATEGORIES = {
  US_EQUITY: { label: 'US Stocks', emoji: '\u{1F1FA}\u{1F1F8}', engine: true },
  US_ETF:    { label: 'US ETFs',   emoji: '\u{1F4CA}',          engine: true },
  CRYPTO:    { label: 'Crypto',    emoji: '\u20BF',             engine: false },
  POLITICS:  { label: 'Political', emoji: '\u{1F3DB}',          engine: false },
  SPORTS:    { label: 'Sports',    emoji: '\u26BD',             engine: false },
  WEATHER:   { label: 'Weather',   emoji: '\u{1F326}',          engine: false },
  OTHER:     { label: 'Other Markets', emoji: '\u{1F30E}',      engine: false },
  UNKNOWN:   { label: 'Uncategorized', emoji: '\u2753',         engine: false },
};

/**
 * Bucket every market by classifier asset_type (dynamic, from tags+title). Display-only.
 * @param {*[]} markets @param {*} [cfg]
 * @returns {{byCategory:Object, counts:Object, total:number, version:string}}
 */
export function categorizeMarkets(markets, cfg = {}) {
  const byCategory = {}; for (const k of Object.keys(ASSET_CATEGORIES)) byCategory[k] = [];
  for (const m of markets || []) {
    const d = classifyMarket(m, cfg);
    const cat = byCategory[d.asset_type] ? d.asset_type : 'UNKNOWN';
    byCategory[cat].push({
      slug: m.slug, title: m.title, tags: m.tags || [], volume: m.volume, liquidity: m.liquidity,
      endDate: m.endDate, status: m.status,
      price: (m.outcomes && m.outcomes[0] && m.outcomes[0].price),
      leadTokenId: (m.outcomes && m.outcomes[0] && m.outcomes[0].tokenId),
      asset_type: d.asset_type, ticker: d.ticker, classification: d.classification, reason: d.reason,
      engineEligible: !!(ASSET_CATEGORIES[d.asset_type] && ASSET_CATEGORIES[d.asset_type].engine) && d.classification === 'ALLOWED',
    });
  }
  const counts = {}; let total = 0; for (const k in byCategory) { counts[k] = byCategory[k].length; total += counts[k]; }
  return { byCategory, counts, total, version: CLASSIFIER_VERSION };
}
