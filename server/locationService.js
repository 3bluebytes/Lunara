// locationService.js — 用户位置偏好：IP 自动定位（默认）+ 手动城市覆盖。
// IP 定位走免 key 服务（ipwho.is 主、ipapi.co 备）；手动城市走 Open-Meteo Geocoding。
// 位置是敏感数据：坐标只存本地 pref，且入库前截断到 2 位小数（约 1km 网格），
// 日志与错误消息只允许出现城市名，不允许出现坐标原文。
// 解析失败一律 fail closed/fail soft：保留既有位置或进入诚实"无位置"，绝不猜城市、绝不用默认城市顶替。

const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const CITY_NAME_LIMIT = 80;

// 出口 IP 本来就会被任何被访问的服务看到，IP 查询不增加暴露面；结果只取城市级。
// 国内实测（2026-09-18）：ipwho.is 可用但偶发超时；ipapi.co 常年限流（429）；
// freeipapi.com 可达。因此保留三家并整轮重试一次，全部失败才进诚实缺省。
const IP_LOOKUP_PROVIDERS = [
  {
    url: 'https://ipwho.is/',
    parse: data => (data?.success === true ? {
      cityName: String(data.city || '').trim(),
      resolvedName: [data.city, data.region, data.country].filter(Boolean).join(' · '),
      latitude: data.latitude,
      longitude: data.longitude,
    } : null),
  },
  {
    url: 'https://ipapi.co/json/',
    parse: data => (data && !data.error ? {
      cityName: String(data.city || '').trim(),
      resolvedName: [data.city, data.region, data.country_name].filter(Boolean).join(' · '),
      latitude: data.latitude,
      longitude: data.longitude,
    } : null),
  },
  {
    url: 'https://freeipapi.com/api/json',
    parse: data => (data?.cityName ? {
      cityName: String(data.cityName || '').trim(),
      resolvedName: [data.cityName, data.regionName, data.countryName].filter(Boolean).join(' · '),
      latitude: data.latitude,
      longitude: data.longitude,
    } : null),
  },
];

/** 坐标校验并截断到 2 位小数；非法输入返回 null。 */
export function normalizeCoordinate(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: Number(lat.toFixed(2)), longitude: Number(lon.toFixed(2)) };
}

/** 读取本地存储的位置；缺失或字段不完整一律视为未设置。无 source 的旧记录视为手动固定。 */
export function readStoredLocation(state) {
  try {
    const raw = JSON.parse(state.getPref('location') || 'null');
    if (!raw || typeof raw !== 'object') return null;
    const cityName = String(raw.cityName || '').trim();
    if (!cityName) return null;
    const coords = normalizeCoordinate(raw.latitude, raw.longitude);
    if (!coords) return null;
    return {
      cityName,
      resolvedName: String(raw.resolvedName || '').trim() || cityName,
      latitude: coords.latitude,
      longitude: coords.longitude,
      source: raw.source === 'auto' ? 'auto' : 'manual',
    };
  } catch {
    return null;
  }
}

/** 对外（HTTP/事件/prompt）只暴露城市名与来源，不暴露坐标。 */
export function publicLocation(location) {
  if (!location) return null;
  return { cityName: location.cityName, resolvedName: location.resolvedName, source: location.source || 'manual' };
}

/** 依次尝试各 IP 定位服务（最多两轮，吸收偶发超时/限流）；全部失败返回 null（诚实缺省）。 */
export async function detectLocationByIp({ fetchImpl = fetch, timeoutMs = 7000, logger = console, signal = null } = {}) {
  for (let round = 0; round < 2; round += 1) {
    // 停机中止：不再发起新一轮探测，也不让在途连接拖住生命周期。
    if (signal?.aborted) return null;
    for (const provider of IP_LOOKUP_PROVIDERS) {
      if (signal?.aborted) return null;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(provider.url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        if (!response.ok) throw new Error(`ip lookup http ${response.status}`);
        const parsed = provider.parse(await response.json());
        const coords = parsed ? normalizeCoordinate(parsed.latitude, parsed.longitude) : null;
        if (parsed?.cityName && coords) {
          return { cityName: parsed.cityName, resolvedName: parsed.resolvedName || parsed.cityName, ...coords };
        }
        logger?.warn?.(`[location] ip lookup returned no usable city: ${provider.url}`);
      } catch (error) {
        logger?.warn?.(`[location] ip lookup failed: ${error?.message || error}`);
      }
    }
  }
  return null;
}

export function createLocationService({ state, fetchImpl = fetch, timeoutMs = 5000, logger = console, onChanged = null, getSignal = null } = {}) {
  // 外部生命周期中止信号：停机时中止在途探测/地理编码，进程不残留自有网络句柄。
  function combinedSignal(ms) {
    const timeout = AbortSignal.timeout(ms);
    const external = getSignal?.();
    return external ? AbortSignal.any([timeout, external]) : timeout;
  }
  async function notify(next, previous) {
    try {
      await onChanged?.(next, previous);
    } catch (error) {
      logger?.warn?.(`[location] onChanged failed: ${error?.message || error}`);
    }
  }

  function store(next) {
    state.setPref('location', JSON.stringify(next));
    return readStoredLocation(state);
  }

  async function geocodeCity(query) {
    const url = `${GEOCODING_ENDPOINT}?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`;
    const response = await fetchImpl(url, { signal: combinedSignal(timeoutMs) });
    if (!response.ok) throw new Error(`geocoding http ${response.status}`);
    const data = await response.json();
    const hit = Array.isArray(data?.results) ? data.results[0] : null;
    const coords = hit ? normalizeCoordinate(hit.latitude, hit.longitude) : null;
    if (!hit || !coords) return null;
    const resolvedName = [hit.name, hit.admin1, hit.country].filter(Boolean).join(' · ');
    return { resolvedName, ...coords };
  }

  async function setLocation(cityInput) {
    const cityName = String(cityInput || '').trim().slice(0, CITY_NAME_LIMIT);
    if (!cityName) return { error: '请填写城市名，或使用自动定位。' };
    let resolved;
    try {
      resolved = await geocodeCity(cityName);
    } catch (error) {
      logger?.warn?.(`[location] geocoding failed for "${cityName}": ${error?.message || error}`);
      return { error: '暂时无法解析城市，请稍后再试。' };
    }
    if (!resolved) {
      return { error: `没有找到“${cityName}”，换个写法试试（如“杭州”或“Paris”）。` };
    }
    const previous = readStoredLocation(state);
    const location = {
      cityName,
      resolvedName: resolved.resolvedName || cityName,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      source: 'manual',
    };
    const next = store(location);
    if (!next) {
      // 极端情况：写入后读不回。视同失败，保留旧值语义。
      if (previous) state.setPref('location', JSON.stringify(previous));
      return { error: '位置没有保存成功，请重试。' };
    }
    await notify(next, previous);
    return { location: next };
  }

  /**
   * 启动时的自动定位：手动设置固定不覆盖；无位置或自动位置则重测（IP 可能已变）。
   * 检测失败进入诚实缺省（无位置或保留旧自动位置），绝不编造。
   */
  async function ensureAutoLocation() {
    const existing = readStoredLocation(state);
    if (existing?.source === 'manual') return { location: existing, detected: false };
    const detected = await detectLocationByIp({ fetchImpl, timeoutMs, logger, signal: getSignal?.() ?? null });
    if (!detected) {
      return { location: existing, detected: false, error: 'auto-unavailable' };
    }
    const previous = existing;
    const next = store({ ...detected, source: 'auto' });
    if (!next) return { location: previous, detected: false, error: 'auto-unavailable' };
    await notify(next, previous);
    return { location: next, detected: true };
  }

  /**
   * 用户显式"重新自动定位"：手动固定值不得被静默覆盖——存在手动设置时拒绝并引导先清除，
   * 两步确认后才切到自动；失败保留原位置并返回可纠正错误。
   */
  async function redetectLocation() {
    const existing = readStoredLocation(state);
    if (existing?.source === 'manual') {
      return { error: `当前是手动设置的“${existing.cityName}”，自动定位不会覆盖它。要先点「清除」再自动定位。` };
    }
    const detected = await detectLocationByIp({ fetchImpl, timeoutMs, logger, signal: getSignal?.() ?? null });
    if (!detected) {
      return { error: '暂时无法通过 IP 自动定位，请检查网络后重试，或手动填写城市。' };
    }
    const next = store({ ...detected, source: 'auto' });
    if (!next) return { error: '位置没有保存成功，请重试。' };
    await notify(next, existing);
    return { location: next };
  }

  async function clearLocation() {
    const previous = readStoredLocation(state);
    state.setPref('location', '');
    await notify(null, previous);
    return { ok: true };
  }

  return { setLocation, clearLocation, ensureAutoLocation, redetectLocation };
}

/**
 * 懒触发的自动定位包装：服务启动本身不得发网络请求（生产生命周期冒烟测试
 * 契约是启停零残留句柄），只有真实消费者索取环境信息时才允许触发。
 * 语义：每进程成功解析一次即不再触发；失败后 retryMs 内不重试（有界退避）；
 * 并发调用共享同一次在途检测。
 */
export function createLazyAutoLocation(service, { retryMs = 5 * 60 * 1000, logger = console } = {}) {
  let pending = null;
  let lastAttemptAt = 0;
  let resolved = false;
  return function ensureAutoLocationLazily() {
    if (resolved) return Promise.resolve(null);
    if (pending) return pending;
    if (Date.now() - lastAttemptAt < retryMs) return Promise.resolve(null);
    pending = service.ensureAutoLocation()
      .then(result => {
        if (result?.location) {
          resolved = true;
          logger?.log?.(`[location] ${result.location.source === 'manual' ? 'kept manual' : 'auto-detected'}: ${result.location.resolvedName}`);
        } else {
          logger?.warn?.('[location] auto detect unavailable, staying honest no-location');
        }
        return result;
      })
      .catch(error => {
        logger?.warn?.(`[location] auto detect failed: ${error?.message || error}`);
        return null;
      })
      .finally(() => {
        lastAttemptAt = Date.now();
        pending = null;
      });
    return pending;
  };
}
