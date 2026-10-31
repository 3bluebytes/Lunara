// env.js — 环境注入：天气、日历、当下时间
// Open-Meteo 不需要 key。坐标来自用户设置的位置偏好（locationService），
// 未设置位置时明确"不感知天气"，绝不回落到任何默认城市。

const WEATHER_TIMEOUT_MS = 5000;
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;
const WEATHER_FAILURE_TTL_MS = 5 * 60 * 1000;

let _locationProvider = () => null;
let _weatherRefreshListener = null;
let _weatherCache = { ts: 0, data: null };

/** 注入坐标来源（返回 readStoredLocation 的结果或 null）。未注入等于未设置位置。 */
export function setLocationProvider(provider) {
  _locationProvider = typeof provider === 'function' ? provider : () => null;
}

/** 天气缓存自然刷新后的回调（用于广播 environment 事件）。 */
export function setWeatherRefreshListener(listener) {
  _weatherRefreshListener = typeof listener === 'function' ? listener : null;
}

/** 位置变更后调用：下次 getWeather 重新拉取。 */
export function invalidateWeatherCache() {
  _weatherCache = { ts: 0, data: null };
}

function unavailableWeather(reason, cityName = null) {
  return {
    available: false,
    reason,
    cityName,
    resolvedName: null,
    tempC: null,
    isDay: null,
    precipitation: null,
    summary: 'unknown',
    summaryZh: null,
  };
}

export async function getWeather({ fetchImpl = fetch, signal: externalSignal = null } = {}) {
  const location = _locationProvider();
  if (!location) return unavailableWeather('no-location');
  const now = Date.now();
  // 成功结果缓存 30 分钟；失败结果短缓存 5 分钟，保证有界重试而不是每次调用都打超时。
  if (_weatherCache.data && now - _weatherCache.ts < (_weatherCache.data.available ? WEATHER_CACHE_TTL_MS : WEATHER_FAILURE_TTL_MS)) {
    return _weatherCache.data;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code,is_day,precipitation`;
    const timeout = AbortSignal.timeout(WEATHER_TIMEOUT_MS);
    const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    const r = await fetchImpl(url, { signal });
    if (!r.ok) throw new Error(`weather http ${r.status}`);
    const j = await r.json();
    const code = j.current?.weather_code ?? 0;
    const data = {
      available: true,
      reason: null,
      cityName: location.cityName,
      resolvedName: location.resolvedName || location.cityName,
      tempC: j.current?.temperature_2m ?? null,
      isDay: !!j.current?.is_day,
      precipitation: j.current?.precipitation ?? 0,
      summary: weatherSummary(code),
      summaryZh: weatherSummaryZh(code),
    };
    _weatherCache = { ts: now, data };
    try {
      _weatherRefreshListener?.(data);
    } catch {}
    return data;
  } catch {
    // 失败详情可能含 URL（即坐标），不进结果也不进日志。
    const failed = unavailableWeather('fetch-failed', location.cityName);
    _weatherCache = { ts: now, data: failed };
    return failed;
  }
}

function weatherSummary(code) {
  if (code === 0) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code <= 48) return 'fog';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'shower';
  if (code <= 86) return 'snow-shower';
  return 'thunder';
}

function weatherSummaryZh(code) {
  if (code === 0) return '晴';
  if (code <= 3) return '多云';
  if (code <= 48) return '雾';
  if (code <= 57) return '毛毛雨';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return '阵雨';
  if (code <= 86) return '阵雪';
  return '雷雨';
}

export function getNow() {
  const d = new Date();
  return {
    iso: d.toISOString(),
    local: d.toLocaleString('zh-CN', { timeZone: process.env.TZ || 'Asia/Shanghai', hour12: false }),
    weekday: ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()],
    hour: d.getHours(),
    slot: timeSlot(d.getHours()),
  };
}

function timeSlot(h) {
  if (h < 6) return 'late_night';
  if (h < 9) return 'morning';
  if (h < 12) return 'forenoon';
  if (h < 14) return 'noon';
  if (h < 18) return 'afternoon';
  if (h < 22) return 'evening';
  return 'late_night';
}

// ===== v2 (memory-system-v2) encoding-specificity helpers =====

/**
 * Coarser time bucket for encoding specificity. 比 timeSlot 粒度粗，便于跨日匹配。
 * @param {Date} [date]
 * @returns {'morning'|'afternoon'|'evening'|'night'|'late-night'}
 */
export function getTimeBucket(date = new Date()) {
  const h = date.getHours();
  if (h < 6) return 'late-night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

/**
 * Numeric day-of-week, Sunday=0 ... Saturday=6.
 * @param {Date} [date]
 * @returns {number}
 */
export function getDayOfWeek(date = new Date()) {
  return date.getDay();
}

// 日历 hook —— 现在只返回空，后面接 ICS / 飞书日历都行
async function getCalendarHints() {
  return { upcoming: [] };
}

/** environment 事件/接口的统一载荷：只含城市名与天气摘要，绝不含坐标。 */
export function environmentEventPayload(weather) {
  if (!weather) return { available: false, cityName: null, summaryZh: null, tempC: null };
  return {
    available: !!weather.available,
    cityName: weather.cityName || null,
    summaryZh: weather.available ? (weather.summaryZh || null) : null,
    tempC: Number.isFinite(weather.tempC) ? Math.round(weather.tempC) : null,
  };
}

export async function snapshot() {
  const [weather, cal] = await Promise.all([getWeather(), getCalendarHints()]);
  return { now: getNow(), weather, calendar: cal };
}

/** 仅供测试：清空模块级缓存与注入，保证用例互不污染。 */
export function resetEnvStateForTest() {
  _locationProvider = () => null;
  _weatherRefreshListener = null;
  _weatherCache = { ts: 0, data: null };
}
