import test from 'node:test';
import assert from 'node:assert/strict';

const { createLocationService, readStoredLocation, publicLocation, normalizeCoordinate, detectLocationByIp } = await import('./locationService.js');

function makeState(initial = null) {
  let stored = initial;
  return {
    getPref: key => (key === 'location' ? stored : null),
    setPref: (key, value) => { if (key === 'location') stored = value; },
    inspect: () => (stored ? JSON.parse(stored) : null),
  };
}

function makeFetch(response) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
  impl.calls = calls;
  return impl;
}

function okGeocode(results) {
  return makeFetch({ ok: true, status: 200, json: async () => ({ results }) });
}

test('设置合法城市：解析成功、坐标截断入库、返回城市名不含坐标', async () => {
  const state = makeState();
  const fetchImpl = okGeocode([{ name: '杭州', admin1: '浙江省', country: '中国', latitude: 30.274084, longitude: 120.15507 }]);
  const onChanged = [];
  const service = createLocationService({ state, fetchImpl, onChanged: async loc => { onChanged.push(loc); } });

  const result = await service.setLocation('杭州');

  assert.equal(result.error, undefined);
  assert.equal(result.location.cityName, '杭州');
  assert.equal(result.location.resolvedName, '杭州 · 浙江省 · 中国');
  assert.equal(result.location.latitude, 30.27);
  assert.equal(result.location.longitude, 120.16);
  assert.equal(result.location.source, 'manual');
  assert.deepEqual(publicLocation(result.location), { cityName: '杭州', resolvedName: '杭州 · 浙江省 · 中国', source: 'manual' });
  const stored = state.inspect();
  assert.equal(stored.latitude, 30.27);
  assert.equal(onChanged.length, 1);
  // 外发 URL 只带截断后坐标
  assert.ok(fetchImpl.calls[0].url.includes('name=%E6%9D%AD%E5%B7%9E'));
});

test('解析不到结果：fail closed，保留既有位置，不猜城市', async () => {
  const state = makeState(JSON.stringify({ cityName: '杭州', resolvedName: '杭州', latitude: 30.27, longitude: 120.16 }));
  const fetchImpl = okGeocode([]);
  const service = createLocationService({ state, fetchImpl });

  const result = await service.setLocation('不存在的城市xyz');

  assert.ok(result.error);
  assert.equal(state.inspect().cityName, '杭州');
});

test('geocoding 网络失败：fail closed，旧位置原样保留', async () => {
  const previous = JSON.stringify({ cityName: '上海', resolvedName: '上海', latitude: 31.23, longitude: 121.47 });
  const state = makeState(previous);
  const fetchImpl = makeFetch(new Error('timeout'));
  const service = createLocationService({ state, fetchImpl });

  const result = await service.setLocation('北京');

  assert.ok(result.error);
  assert.deepEqual(state.inspect(), JSON.parse(previous));
});

test('空输入：直接报错且不打网络请求', async () => {
  const state = makeState();
  const fetchImpl = okGeocode([]);
  const service = createLocationService({ state, fetchImpl });

  const result = await service.setLocation('   ');

  assert.ok(result.error);
  assert.equal(fetchImpl.calls.length, 0);
});

test('清除位置：回到未设置状态并通知 onChanged(null)', async () => {
  const state = makeState(JSON.stringify({ cityName: '杭州', resolvedName: '杭州', latitude: 30.27, longitude: 120.16 }));
  const onChanged = [];
  const service = createLocationService({ state, fetchImpl: okGeocode([]), onChanged: async loc => { onChanged.push(loc); } });

  await service.clearLocation();

  assert.equal(readStoredLocation(state), null);
  assert.deepEqual(onChanged, [null]);
});

test('readStoredLocation 对残缺数据一律视为未设置', () => {
  assert.equal(readStoredLocation(makeState(null)), null);
  assert.equal(readStoredLocation(makeState('not-json')), null);
  assert.equal(readStoredLocation(makeState(JSON.stringify({ cityName: 'x' }))), null);
  assert.equal(readStoredLocation(makeState(JSON.stringify({ cityName: 'x', latitude: 999, longitude: 0 }))), null);
});

test('normalizeCoordinate 校验范围并截断精度', () => {
  assert.deepEqual(normalizeCoordinate(31.230411, 121.473701), { latitude: 31.23, longitude: 121.47 });
  assert.equal(normalizeCoordinate(95, 0), null);
  assert.equal(normalizeCoordinate('abc', 0), null);
});

// ===== IP 自动定位（2026-09-18 需求修订） =====

function okJson(body) {
  return makeFetch({ ok: true, status: 200, json: async () => body });
}

const IPWHO_BODY = { success: true, city: '杭州', region: '浙江省', country: '中国', latitude: 30.293646, longitude: 120.16144 };
const IPAPI_BODY = { city: '杭州', region: '浙江省', country_name: '中国', latitude: 30.2936, longitude: 120.1614 };

test('IP 自动定位：首个服务可用时归一化城市与截断坐标', async () => {
  const fetchImpl = okJson(IPWHO_BODY);

  const detected = await detectLocationByIp({ fetchImpl });

  assert.equal(detected.cityName, '杭州');
  assert.equal(detected.resolvedName, '杭州 · 浙江省 · 中国');
  assert.equal(detected.latitude, 30.29);
  assert.equal(detected.longitude, 120.16);
  assert.equal(fetchImpl.calls[0].url, 'https://ipwho.is/');
});

test('IP 自动定位：主服务失败回落到备用服务', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://ipwho.is/') throw new Error('boom');
    return { ok: true, status: 200, json: async () => IPAPI_BODY };
  };

  const detected = await detectLocationByIp({ fetchImpl });

  assert.deepEqual(calls, ['https://ipwho.is/', 'https://ipapi.co/json/']);
  assert.equal(detected.cityName, '杭州');
});

test('IP 自动定位：全部失败返回 null（诚实缺省）', async () => {
  const fetchImpl = makeFetch(new Error('offline'));

  assert.equal(await detectLocationByIp({ fetchImpl }), null);
});

test('ensureAutoLocation：手动位置固定，不被自动结果覆盖', async () => {
  const state = makeState(JSON.stringify({ cityName: '北京', resolvedName: '北京', latitude: 39.9, longitude: 116.41, source: 'manual' }));
  const fetchImpl = okJson(IPWHO_BODY);
  const service = createLocationService({ state, fetchImpl });

  const result = await service.ensureAutoLocation();

  assert.equal(result.detected, false);
  assert.equal(result.location.cityName, '北京');
  assert.equal(result.location.source, 'manual');
  assert.equal(fetchImpl.calls.length, 0);
});

test('ensureAutoLocation：无位置时自动检测并写入 source=auto', async () => {
  const state = makeState();
  const onChanged = [];
  const service = createLocationService({ state, fetchImpl: okJson(IPWHO_BODY), onChanged: async loc => { onChanged.push(loc); } });

  const result = await service.ensureAutoLocation();

  assert.equal(result.detected, true);
  assert.equal(result.location.source, 'auto');
  assert.equal(state.inspect().source, 'auto');
  assert.equal(onChanged.length, 1);
});

test('ensureAutoLocation：检测失败保持无位置，不编造城市', async () => {
  const state = makeState();
  const service = createLocationService({ state, fetchImpl: makeFetch(new Error('offline')) });

  const result = await service.ensureAutoLocation();

  assert.equal(result.detected, false);
  assert.ok(result.error);
  assert.equal(readStoredLocation(state), null);
});

test('redetectLocation：手动固定值拒绝被静默覆盖，先清除才能切自动', async () => {
  const manual = JSON.stringify({ cityName: '北京', resolvedName: '北京 · 北京市 · 中国', latitude: 39.9, longitude: 116.41, source: 'manual' });
  const state = makeState(manual);
  const fetchImpl = okJson(IPWHO_BODY);
  const service = createLocationService({ state, fetchImpl });

  const refused = await service.redetectLocation();
  assert.ok(refused.error);
  assert.match(refused.error, /清除/);
  assert.equal(state.inspect().cityName, '北京');
  assert.equal(fetchImpl.calls.length, 0); // 拒绝路径不发网络请求

  await service.clearLocation();
  const ok = await service.redetectLocation();
  assert.equal(ok.location.source, 'auto');
  assert.equal(ok.location.cityName, '杭州');
});

test('redetectLocation：无位置时直接自动定位；检测失败保留原 auto 位置', async () => {
  const auto = JSON.stringify({ cityName: '杭州', resolvedName: '杭州', latitude: 30.27, longitude: 120.16, source: 'auto' });
  const state = makeState(auto);
  let service = createLocationService({ state, fetchImpl: makeFetch(new Error('offline')) });

  const failed = await service.redetectLocation();
  assert.ok(failed.error);
  assert.equal(state.inspect().cityName, '杭州');

  state.setPref('location', '');
  service = createLocationService({ state, fetchImpl: okJson(IPWHO_BODY) });
  const ok = await service.redetectLocation();
  assert.equal(ok.location.cityName, '杭州');
  assert.equal(ok.location.source, 'auto');
});

test('无 source 的旧记录视为手动固定，不会被自动覆盖', async () => {
  const state = makeState(JSON.stringify({ cityName: '上海', resolvedName: '上海', latitude: 31.23, longitude: 121.47 }));
  const service = createLocationService({ state, fetchImpl: okJson(IPWHO_BODY) });

  const result = await service.ensureAutoLocation();

  assert.equal(result.location.cityName, '上海');
  assert.equal(result.location.source, 'manual');
  assert.equal(state.inspect().cityName, '上海');
});

test('IP 自动定位：freeipapi 作为第三回落可用', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url !== 'https://freeipapi.com/api/json') throw new Error('down');
    return { ok: true, status: 200, json: async () => ({ cityName: 'Los Angeles', regionName: 'California', countryName: 'United States', latitude: 34.05, longitude: -118.24 }) };
  };

  const detected = await detectLocationByIp({ fetchImpl });

  assert.equal(detected.cityName, 'Los Angeles');
  assert.equal(calls.length, 3);
});

test('IP 自动定位：第一轮全挂后第二轮重试成功', async () => {
  let round = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://ipwho.is/') {
      round += 1;
      if (round <= 1) throw new Error('transient');
      return { ok: true, status: 200, json: async () => IPWHO_BODY };
    }
    throw new Error('down');
  };

  const detected = await detectLocationByIp({ fetchImpl });

  assert.equal(detected.cityName, '杭州');
});
