// audioFingerprint.js — 自研轻量音频指纹，**只用于提议**，永不自动建立等价关系。
//
// 为什么不引入 chromaprint：它的 npm 生态基本要 native 编译或外部二进制，而本仓库
// 有 Electron 打包（三平台 ABI 与二进制要一起维护）。这里复用随包的 ffmpeg 解出
// PCM，再用纯 JS 做分帧频带能量量化——零新依赖，代价是它没有权威性。
//
// 正因为没有权威性，它的产出只能用来「帮用户少看几眼」：指纹一致时把候选排前面并
// 预选，最终仍需用户确认（`add-cross-source-recording-identity` 的 D3）。
//
// 指纹本身也会被写进本地库，所以它不能包含可还原的音频内容：这里只保留每个时间点
// 16 位量化的频带形状，属于「相似度摘要」而非音频副本。

const SAMPLE_RATE = 11_025;
const POINT_SAMPLES = 2_048;
const MAX_POINTS = 180;
const BANDS = [90, 160, 260, 400, 640, 1_000, 1_600, 2_600];
const HEX = '0123456789abcdef';

export const FINGERPRINT_VERSION = 1;
export const FINGERPRINT_MATCH_THRESHOLD = 0.82;

function decodeArgs(filePath) {
  return [
    '-nostdin', '-v', 'error', '-i', filePath,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ];
}

/** 高斯窗口不是必须的：这里只做「哪几个频带在这一刻占主导」，不需要精确频谱。 */
function bandEnergies(samples, offset) {
  const energies = BANDS.map(frequency => {
    // 二阶 Goertzel：单点 DFT，比整段 FFT 便宜，且只要这几个固定频率。
    const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / SAMPLE_RATE);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < POINT_SAMPLES; i += 1) {
      const value = (samples[offset + i] || 0) / 32768;
      const s0 = value + coefficient * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2)) / POINT_SAMPLES;
  });
  const total = energies.reduce((sum, value) => sum + value, 0);
  return total > 0 ? energies.map(value => value / total) : energies.map(() => 0);
}

function quantize(energies) {
  // 相对强度 → 2 bit：0 静音/极弱，3 主导。用 log 压缩，避免响段吃掉全部码位。
  let bits = 0;
  energies.forEach((share, index) => {
    const level = share <= 0.001 ? 0 : share < 0.08 ? 1 : share < 0.2 ? 2 : 3;
    bits |= level << (index * 2);
  });
  return bits;
}

/**
 * 把 PCM（s16le / mono / 11025Hz）折成指纹串。
 * 每个时间点 4 个 hex 字符；点数有上限，长音频只取前 `MAX_POINTS` 个窗口。
 */
export function fingerprintPcm(buffer) {
  if (!buffer || buffer.length < POINT_SAMPLES * 2) return null;
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
  const points = [];
  const stride = POINT_SAMPLES;
  for (let offset = 0; offset + POINT_SAMPLES <= samples.length && points.length < MAX_POINTS; offset += stride) {
    const bits = quantize(bandEnergies(samples, offset));
    points.push(HEX[(bits >> 12) & 0xf] + HEX[(bits >> 8) & 0xf] + HEX[(bits >> 4) & 0xf] + HEX[bits & 0xf]);
  }
  if (points.length < 4) return null;
  return points.join('');
}

/**
 * 两段指纹的相似度：逐点比较 4 个 hex（等价于比较 8 个频带的量化值），
 * 长度不同时按较短的一方对齐比较，避免「短试听永远不像」这种误判。
 */
export function fingerprintSimilarity(left, right) {
  if (!left || !right) return 0;
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let same = 0;
  for (let i = 0; i < length; i += 1) if (left[i] === right[i]) same += 1;
  return same / length;
}

export function isFingerprintMatch(left, right, { threshold = FINGERPRINT_MATCH_THRESHOLD } = {}) {
  return fingerprintSimilarity(left, right) >= threshold;
}

/**
 * 从文件算指纹。`execFileImpl` 与 `ffmpegPath` 都可注入：单测不需要真的 ffmpeg。
 * 任何失败都返回 `{ ok: false, reason }`，由调用方决定「下次再试」。
 */
export async function computeFingerprint(filePath, {
  ffmpegPath = null,
  execFileImpl = null,
  maxSeconds = 240,
  timeoutMs = 30_000,
  maxBytes = 24 * 1024 * 1024,
} = {}) {
  if (!filePath) return { ok: false, reason: 'missing-file' };
  if (!ffmpegPath || typeof execFileImpl !== 'function') return { ok: false, reason: 'no-ffmpeg' };
  const args = decodeArgs(filePath);
  args.splice(args.length - 1, 0, '-t', String(Math.max(1, Math.round(maxSeconds))));
  let stdout;
  try {
    const result = await execFileImpl(ffmpegPath, args, {
      timeout: timeoutMs, maxBuffer: maxBytes, windowsHide: true, encoding: 'buffer',
    });
    stdout = result?.stdout;
  } catch (error) {
    // 尾部坏字节不影响已解码部分：能算就从已有数据算，算不出才如实失败。
    stdout = error?.stdout;
    if (!stdout) return { ok: false, reason: 'decode-failed' };
  }
  if (!Buffer.isBuffer(stdout)) stdout = stdout ? Buffer.from(stdout) : null;
  const fingerprint = fingerprintPcm(stdout);
  if (!fingerprint) return { ok: false, reason: 'insufficient-audio' };
  return { ok: true, fingerprint, version: FINGERPRINT_VERSION, points: fingerprint.length / 4 };
}
