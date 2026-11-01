import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveDatabasePath,
  resolveDataRoot,
  resolveImageCacheDir,
  resolveAudioCacheDir,
  resolvePackageRoot,
  resolvePersonaRoot,
  resolveSessionTraceDir,
  resolveTaskTraceDir,
  resolveTtsCacheDir,
  resolveTtsModelDir,
} from './runtimePaths.js';

// run-tests.mjs 会向每个测试进程注入六个 LUNARA_* 隔离变量；「未列出的 env 保留」
// 会让依赖数据根推导默认值的用例读到注入值。因此无论用例列出什么，都先清空整个
// LUNARA_*/CLAUDIO_* 路径族，再应用显式值——用例里的 undefined 只是意图标注。
const PATH_ENV_FAMILY = [
  'LUNARA_DB_PATH', 'CLAUDIO_DB_PATH',
  'LUNARA_RADIOHOST_DIR', 'CLAUDIO_DJ_DIR',
  'LUNARA_DATA_DIR',
  'LUNARA_TTS_CACHE_DIR', 'CLAUDIO_TTS_CACHE_DIR',
  'LUNARA_TTS_MODEL_DIR', 'CLAUDIO_TTS_MODEL_DIR',
  'LUNARA_SESSION_TRACE_DIR',
];

function withEnv(values, fn) {
  const names = [...new Set([...PATH_ENV_FAMILY, ...Object.keys(values)])];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { fn(); } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('LUNARA_DB_PATH 优先于 legacy CLAUDIO_DB_PATH', () => {
  withEnv({ LUNARA_DB_PATH: '/tmp/lunara.db', CLAUDIO_DB_PATH: '/tmp/legacy.db' }, () => {
    assert.equal(resolveDatabasePath('/tmp/default.db'), resolve('/tmp/lunara.db'));
  });
});

test('只有 legacy DB path 时仍可兼容读取', () => {
  withEnv({ LUNARA_DB_PATH: undefined, CLAUDIO_DB_PATH: '/tmp/legacy.db' }, () => {
    assert.equal(resolveDatabasePath('/tmp/default.db'), resolve('/tmp/legacy.db'));
  });
});

test('LUNARA_RADIOHOST_DIR 覆盖默认人格根目录', () => {
  withEnv({ LUNARA_RADIOHOST_DIR: '/tmp/lunara-radiohost' }, () => {
    assert.equal(resolvePersonaRoot('/tmp/default-radiohost'), resolve('/tmp/lunara-radiohost'));
  });
});

test('CLAUDIO_DJ_DIR fallback 已失效，未设置时落到默认值', () => {
  withEnv({ LUNARA_RADIOHOST_DIR: undefined, CLAUDIO_DJ_DIR: '/tmp/legacy-radiohost' }, () => {
    assert.equal(resolvePersonaRoot('/tmp/default-radiohost'), resolve('/tmp/default-radiohost'));
  });
});

test('LUNARA_TTS_CACHE_DIR 可覆盖合成缓存目录', () => {
  withEnv({ LUNARA_TTS_CACHE_DIR: '/tmp/lunara-tts', CLAUDIO_TTS_CACHE_DIR: '/tmp/legacy-tts' }, () => {
    assert.equal(resolveTtsCacheDir('/tmp/default-tts'), resolve('/tmp/lunara-tts'));
  });
});

test('合成缓存目录缺失时兼容 legacy 变量', () => {
  withEnv({ LUNARA_TTS_CACHE_DIR: undefined, CLAUDIO_TTS_CACHE_DIR: '/tmp/legacy-tts' }, () => {
    assert.equal(resolveTtsCacheDir('/tmp/default-tts'), resolve('/tmp/legacy-tts'));
  });
});

test('合成缓存目录两者都缺失时用 fallback', () => {
  withEnv({ LUNARA_TTS_CACHE_DIR: undefined, CLAUDIO_TTS_CACHE_DIR: undefined }, () => {
    assert.equal(resolveTtsCacheDir('/tmp/default-tts'), resolve('/tmp/default-tts'));
  });
});

// ---- 数据根（data-root change）----

function withWarnCapture(fn) {
  const warnings = [];
  const previous = console.warn;
  console.warn = message => warnings.push(String(message));
  try { fn(); } finally { console.warn = previous; }
  return warnings;
}

test('resolveDataRoot 默认锚 ~/.lunara', () => {
  withEnv({ LUNARA_DATA_DIR: undefined }, () => {
    assert.equal(resolveDataRoot(), resolve(homedir(), '.lunara'));
  });
});

test('LUNARA_DATA_DIR 覆盖默认数据根', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home' }, () => {
    assert.equal(resolveDataRoot(), resolve('/tmp/lunara-home'));
  });
});

test('resolvePackageRoot 返回仓库根（server 的上一级）', () => {
  const pkgRoot = resolvePackageRoot();
  assert.equal(pkgRoot, resolve(pkgRoot));
  assert.ok(!pkgRoot.endsWith('/server'), `包根不应是 server 目录: ${pkgRoot}`);
});

test('audio/img 缓存目录锚数据根', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home' }, () => {
    assert.equal(resolveAudioCacheDir(), resolve('/tmp/lunara-home', 'cache/audio'));
    assert.equal(resolveImageCacheDir(), resolve('/tmp/lunara-home', 'cache/img'));
  });
});

test('无覆盖 env 时数据库默认锚数据根（优先级链：数据根推导）', () => {
  withEnv({ LUNARA_DB_PATH: undefined, CLAUDIO_DB_PATH: undefined, LUNARA_DATA_DIR: '/tmp/lunara-home' }, () => {
    assert.equal(resolveDatabasePath(), resolve('/tmp/lunara-home', 'data/state.db'));
    assert.equal(resolvePersonaRoot(), resolve('/tmp/lunara-home', 'user/radiohost'));
  });
});

test('每路径 env 优先于 LUNARA_DATA_DIR 推导', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_DB_PATH: '/tmp/explicit/state.db' }, () => {
    assert.equal(resolveDatabasePath(), resolve('/tmp/explicit/state.db'));
  });
});

test('相对 env 值改锚数据根解析并告警实际路径', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_DB_PATH: 'data/state.db' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolveDatabasePath(), resolve('/tmp/lunara-home', 'data/state.db'));
    });
    assert.equal(warnings.length, 1, `应有一条相对路径告警，实际: ${JSON.stringify(warnings)}`);
    // Windows 上 path.resolve 产生反斜杠分隔，正则需兼容两种分隔符。
    assert.match(warnings[0], /data[\\/]+state\.db/);
  });
});

test('绝对 env 值不产生相对路径告警', () => {
  withEnv({ LUNARA_DB_PATH: '/tmp/absolute/state.db' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolveDatabasePath(), resolve('/tmp/absolute/state.db'));
    });
    assert.equal(warnings.length, 0);
  });
});

// ---- 跨平台路径语义与 resolvePersonaRoot 相对值（数据根 change 补充）----

test('LUNARA_DATA_DIR 含 .. 与冗余分隔符时按平台 path.resolve 规范化', () => {
  withEnv({ LUNARA_DATA_DIR: join('/tmp', 'lunara', '.', 'sub', '..', 'home') }, () => {
    assert.equal(resolveDataRoot(), resolve('/tmp/lunara/home'));
  });
});

test('legacy CLAUDIO_DB_PATH 同样优先于 LUNARA_DATA_DIR 推导（优先级链完整）', () => {
  withEnv({ LUNARA_DB_PATH: undefined, CLAUDIO_DB_PATH: '/tmp/legacy.db', LUNARA_DATA_DIR: '/tmp/lunara-home' }, () => {
    assert.equal(resolveDatabasePath(), resolve('/tmp/legacy.db'));
  });
});

test('相对 LUNARA_RADIOHOST_DIR 锚数据根解析并告警（与每路径 resolver 同语义）', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_RADIOHOST_DIR: 'user/radiohost' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolvePersonaRoot(), resolve('/tmp/lunara-home', 'user/radiohost'));
    });
    assert.equal(warnings.length, 1, `应有一条相对路径告警，实际: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /user[\\/]+radiohost/);
  });
});

test('绝对 LUNARA_RADIOHOST_DIR 不产生告警', () => {
  withEnv({ LUNARA_RADIOHOST_DIR: '/tmp/absolute-radiohost' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolvePersonaRoot(), resolve('/tmp/absolute-radiohost'));
    });
    assert.equal(warnings.length, 0);
  });
});

test('相对 LUNARA_TTS_CACHE_DIR / LUNARA_TTS_MODEL_DIR 同样锚数据根', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_TTS_CACHE_DIR: 'cache/tts', LUNARA_TTS_MODEL_DIR: 'cache/tts-models' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolveTtsCacheDir(), resolve('/tmp/lunara-home', 'cache/tts'));
      assert.equal(resolveTtsModelDir(), resolve('/tmp/lunara-home', 'cache/tts-models'));
    });
    assert.equal(warnings.length, 2, `每个相对值各告警一次，实际: ${JSON.stringify(warnings)}`);
  });
});

// ---- 会话执行记录目录（add-session-jsonl-trace）----

test('resolveSessionTraceDir 默认锚数据根 sessions/', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_SESSION_TRACE_DIR: undefined }, () => {
    assert.equal(resolveSessionTraceDir(), resolve('/tmp/lunara-home', 'sessions'));
  });
});

test('LUNARA_SESSION_TRACE_DIR 覆盖会话记录目录', () => {
  withEnv({ LUNARA_SESSION_TRACE_DIR: '/tmp/explicit-sessions' }, () => {
    assert.equal(resolveSessionTraceDir(), resolve('/tmp/explicit-sessions'));
  });
});

test('相对 LUNARA_SESSION_TRACE_DIR 锚数据根解析并告警', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_SESSION_TRACE_DIR: 'sessions' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolveSessionTraceDir(), resolve('/tmp/lunara-home', 'sessions'));
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LUNARA_SESSION_TRACE_DIR/);
  });
});

test('resolveTaskTraceDir 默认锚数据根 tasks/', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_TASK_TRACE_DIR: undefined }, () => {
    assert.equal(resolveTaskTraceDir(), resolve('/tmp/lunara-home', 'tasks'));
  });
});

test('LUNARA_TASK_TRACE_DIR 覆盖任务记录目录', () => {
  withEnv({ LUNARA_TASK_TRACE_DIR: '/tmp/explicit-tasks' }, () => {
    assert.equal(resolveTaskTraceDir(), resolve('/tmp/explicit-tasks'));
  });
});

test('相对 LUNARA_TASK_TRACE_DIR 锚数据根解析并告警', () => {
  withEnv({ LUNARA_DATA_DIR: '/tmp/lunara-home', LUNARA_TASK_TRACE_DIR: 'tasks' }, () => {
    const warnings = withWarnCapture(() => {
      assert.equal(resolveTaskTraceDir(), resolve('/tmp/lunara-home', 'tasks'));
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LUNARA_TASK_TRACE_DIR/);
  });
});
