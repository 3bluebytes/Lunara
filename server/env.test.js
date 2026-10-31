import test from 'node:test';
import assert from 'node:assert/strict';

const env = await import('./env.js');

const SHA_LOCATION = { cityName: '上海', resolvedName: '上海 · 上海市 · 中国', latitude: 31.23, longitude: 121.47 };
const SHA_URL = 'https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47&current=temperature_2m,weather_code,is_day,precipitation';

function okWeather(body) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const SHA_CURRENT = { current: { temperature_2m: 23.6, weather_code: 61, is_day: 1, precipitation: 0.4 } };

test('未设置位置：不发请求、返回显式不可用且无城市信息', async () => {
  env.resetEnvStateForTest();
  const fetchImpl = okWeather(SHA_CURRENT);

  const weather = await env.getWeather({ fetchImpl });

  assert.equal(weather.available, false);
  assert.equal(weather.reason, 'no-location');
  assert.equal(weather.cityName, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('位置已设置：请求带截断坐标，结果含城市名与中英文摘要', async () => {
  env.resetEnvStateForTest();
  env.setLocationProvider(() => SHA_LOCATION);
  const fetchImpl = okWeather(SHA_CURRENT);

  const weather = await env.getWeather({ fetchImpl });

  assert.deepEqual(fetchImpl.calls, [SHA_URL]);
  assert.equal(weather.available, true);
  assert.equal(weather.cityName, '上海');
  assert.equal(weather.resolvedName, '上海 · 上海市 · 中国');
  assert.equal(weather.summary, 'rain');
  assert.equal(weather.summaryZh, '雨');
  assert.equal(weather.tempC, 23.6);
});

test('成功结果走缓存：30 分钟内第二次调用不再发请求', async () => {
  env.resetEnvStateForTest();
  env.setLocationProvider(() => SHA_LOCATION);
  const fetchImpl = okWeather(SHA_CURRENT);

  await env.getWeather({ fetchImpl });
  await env.getWeather({ fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
});

test('失败结果显式不可用：不编造天气，事件载荷不含坐标', async () => {
  env.resetEnvStateForTest();
  env.setLocationProvider(() => SHA_LOCATION);
  const failing = async () => { throw new Error('boom'); };

  const weather = await env.getWeather({ fetchImpl: failing });
  const payload = env.environmentEventPayload(weather);

  assert.equal(weather.available, false);
  assert.equal(weather.reason, 'fetch-failed');
  assert.equal(weather.cityName, '上海');
  assert.equal(payload.available, false);
  assert.equal(payload.summaryZh, null);
  assert.equal(JSON.stringify(payload).includes('121.47'), false);
});

test('位置变更后失效缓存：下一次调用重新发起请求', async () => {
  env.resetEnvStateForTest();
  env.setLocationProvider(() => SHA_LOCATION);
  const fetchImpl = okWeather(SHA_CURRENT);

  await env.getWeather({ fetchImpl });
  env.invalidateWeatherCache();
  await env.getWeather({ fetchImpl });

  assert.equal(fetchImpl.calls.length, 2);
});

test('缓存自然刷新触发监听器，且监听器拿到的是无坐标摘要', async () => {
  env.resetEnvStateForTest();
  env.setLocationProvider(() => SHA_LOCATION);
  const seen = [];
  env.setWeatherRefreshListener(data => { seen.push(data); });
  const fetchImpl = okWeather(SHA_CURRENT);

  await env.getWeather({ fetchImpl });
  await env.getWeather({ fetchImpl });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].available, true);
  assert.equal(seen[0].latitude, undefined);
});

test('environmentEventPayload 四舍五入温度并丢弃小数位', () => {
  assert.deepEqual(
    env.environmentEventPayload({ available: true, cityName: '上海', summaryZh: '雨', tempC: 23.6 }),
    { available: true, cityName: '上海', summaryZh: '雨', tempC: 24 },
  );
  assert.deepEqual(env.environmentEventPayload(null), { available: false, cityName: null, summaryZh: null, tempC: null });
});
