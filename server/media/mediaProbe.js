// mediaProbe.js — 媒体资产的校验契约。
//
// 「浏览器能不能放」不是完整性证明：本文件把两件事分开：
// 1. 结构事实（容器魔数、FLAC STREAMINFO 里的真实时长）——不依赖外部工具；
// 2. 解码事实（ffmpeg 完整解码零错误、ffprobe 探测容器与时长）——有工具才做。
//
// 失败分类保持稳定、可直接落 trace；不返回 URL、供应商报文或凭据。

import { open } from 'node:fs/promises';

export const DEFAULT_DURATION_TOLERANCE_SECONDS = 5;
export const DEFAULT_DURATION_TOLERANCE_RATIO = 0.05;
// 「元数据时长和实际时长有点差」是常态（不同版本、不同源、编辑偏差），不能当损坏，
// 否则会误杀可播的歌。只有明显截断（预览流、下载中断）才致命：缺失同时超过
// 45 秒与 30%（即实际不足元数据的 70%）。中间地带只记录漂移，不拒绝。
export const DEFAULT_TRUNCATION_GAP_SECONDS = 45;
export const DEFAULT_TRUNCATION_RATIO = 0.3;
// 尾部损坏 ≠ 音频缺失：实测 269 个缓存 FLAC 里有 259 个把音频完整解码到 100%，
// 只是最后一帧之后还有坏字节。只要解码覆盖到参考时长的 98%，就按「尾部损坏」接受，
// 只有真正丢了大段音频才判坏。
export const DEFAULT_DECODED_COVERAGE_RATIO = 0.98;

const FLAC_MAGIC = 'fLaC';

/** 容器魔数判定；只读文件头部，不做解码。 */
export function detectContainer(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  if (buf.length >= 4) {
    const magic = buf.subarray(0, 4).toString('latin1');
    if (magic === FLAC_MAGIC) return 'flac';
    if (magic === 'OggS') return 'ogg';
    if (magic === 'RIFF') return 'wav';
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return 'mpeg';
  // MPEG 帧同步：11 个 1。
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mpeg';
  return 'unknown';
}

/**
 * FLAC STREAMINFO 里的权威时长（totalSamples / sampleRate）。
 * 只读前 26 字节；头部不是 STREAMINFO 时返回 null，不猜。
 */
export function flacDurationSeconds(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  if (buf.length < 26 || buf.subarray(0, 4).toString('latin1') !== FLAC_MAGIC) return null;
  const blockType = buf[4] & 0x7f;
  if (blockType !== 0) return null;
  if (buf.readUIntBE(5, 3) < 34) return null;
  const packed = buf.readBigUInt64BE(18);
  const sampleRate = Number(packed >> 44n);
  const totalSamples = Number(packed & 0xfffffffffn);
  if (!sampleRate || !totalSamples) return null;
  return totalSamples / sampleRate;
}

/** 已知时长对账：只判定「明显变短」，因为截断是最常见的静默损坏。 */
export function durationLooksShort(actualSeconds, expectedSeconds, {
  toleranceSeconds = DEFAULT_DURATION_TOLERANCE_SECONDS,
  ratio = DEFAULT_DURATION_TOLERANCE_RATIO,
  coverageRatio = DEFAULT_DECODED_COVERAGE_RATIO,
} = {}) {
  const actual = Number(actualSeconds);
  const expected = Number(expectedSeconds);
  if (!(actual > 0) || !(expected > 0)) return false;
  const tolerance = Math.max(toleranceSeconds, expected * ratio);
  return actual < expected - tolerance;
}

/** 明显截断判定：只有大幅变短才算损坏，普通时长漂移只记录不拒绝。 */
export function durationLooksTruncated(actualSeconds, expectedSeconds, {
  gapSeconds = DEFAULT_TRUNCATION_GAP_SECONDS,
  ratio = DEFAULT_TRUNCATION_RATIO,
} = {}) {
  const actual = Number(actualSeconds);
  const expected = Number(expectedSeconds);
  if (!(actual > 0) || !(expected > 0)) return false;
  const gap = expected - actual;
  return gap > gapSeconds && actual < expected * (1 - ratio);
}

export async function readHead(file, bytes = 64) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeFailureReason(error) {
  const killed = error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT';
  if (killed) return 'decode-timeout';
  if (error?.code === 'ENOENT') return 'unreadable';
  return 'decode-failed';
}

// ffmpeg 的 -progress 输出用微秒；名字里带 ms 但实际是 us，取最后一个非零值。
export function decodedDurationSeconds(progressOutput) {
  const text = String(progressOutput || '');
  let value = null;
  for (const line of text.split('\n')) {
    const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
    if (match && Number(match[1]) > 0) value = Number(match[1]) / 1e6;
  }
  return value;
}

async function probeWithFfprobe(ffprobePath, file, execFileImpl, timeoutMs) {
  try {
    const { stdout } = await execFileImpl(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'json', file,
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(String(stdout || '{}'));
    const format = String(parsed?.format?.format_name || '').split(',')[0] || null;
    const duration = Number(parsed?.format?.duration);
    return { format, durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null };
  } catch {
    return { format: null, durationSeconds: null };
  }
}

/**
 * 创建校验器。ffmpeg 可用时做完整解码；不可用时退化到结构事实，并在
 * verifiedBy 里如实标注，绝不把结构检查说成解码验证。
 */
/** 解码覆盖判定：解码到的时长是否足以证明音频完整。 */
export function decodeCoverageIsComplete(decodedSeconds, referenceSeconds, {
  coverageRatio = DEFAULT_DECODED_COVERAGE_RATIO,
} = {}) {
  const decoded = Number(decodedSeconds);
  const reference = Number(referenceSeconds);
  if (!(decoded > 0) || !(reference > 0)) return false;
  return decoded >= reference * coverageRatio;
}

export function createMediaVerifier({
  ffmpegPath = null,
  ffprobePath = null,
  execFileImpl = null,
  timeoutMs = 30_000,
  toleranceSeconds = DEFAULT_DURATION_TOLERANCE_SECONDS,
  ratio = DEFAULT_DURATION_TOLERANCE_RATIO,
  coverageRatio = DEFAULT_DECODED_COVERAGE_RATIO,
} = {}) {
  if (typeof execFileImpl !== 'function') throw new TypeError('createMediaVerifier requires execFileImpl');
  return async function verifyMediaFile(file, { expectedDurationSeconds = 0 } = {}) {
    const head = await readHead(file, 64).catch(() => null);
    if (!head) return { ok: false, reason: 'unreadable', format: null, durationSeconds: null, verifiedBy: 'structure' };
    const container = detectContainer(head);
    let format = container === 'unknown' ? null : container;
    let durationSeconds = container === 'flac' ? flacDurationSeconds(head) : null;
    let verifiedBy = 'structure';

    if (ffmpegPath) {
      let stdout = '';
      try {
        const result = await execFileImpl(ffmpegPath, [
          '-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-', '-progress', 'pipe:1',
        ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        stdout = String(result?.stdout || '');
      } catch (error) {
        // 解码在文件末尾报错但音频已经完整输出：尾部垃圾不挡播放，如实标注。
        const decoded = decodedDurationSeconds(error?.stdout);
        const reference = durationSeconds || (Number(expectedDurationSeconds) > 0 ? Number(expectedDurationSeconds) : null);
        if (decodeCoverageIsComplete(decoded, reference, { coverageRatio })) {
          return { ok: true, reason: null, format, durationSeconds: decoded, verifiedBy: 'decode', note: 'trailing-damage' };
        }
        const reason = decodeFailureReason(error);
        if (reason === 'decode-timeout') {
          // 「来不及验证」不等于「文件坏了」：弱机器上 46MB FLAC 解码可能超时，
          // 因此退回结构/时长对账并如实标注，不让校验本身把可播的歌挡掉。
          if (durationLooksTruncated(durationSeconds, expectedDurationSeconds)) {
            return { ok: false, reason: 'duration-short', format, durationSeconds, verifiedBy: 'structure' };
          }
          return {
            ok: true, reason: null, format, durationSeconds: decoded || durationSeconds,
            verifiedBy: 'structure', note: 'decode-timeout',
          };
        }
        return { ok: false, reason, format, durationSeconds: decoded || durationSeconds, verifiedBy: 'decode' };
      }
      verifiedBy = 'decode';
      // 完整解码顺带给出真实解码时长：MP3 没有校验和，这是判断截断的唯一手段。
      const decoded = decodedDurationSeconds(stdout);
      if (decoded) durationSeconds = decoded;
      if (ffprobePath) {
        const probed = await probeWithFfprobe(ffprobePath, file, execFileImpl, timeoutMs);
        if (probed.format) format = probed.format;
        if (probed.durationSeconds) durationSeconds = probed.durationSeconds;
      }
    }

    if (durationLooksTruncated(durationSeconds, expectedDurationSeconds)) {
      return { ok: false, reason: 'duration-short', format, durationSeconds, verifiedBy };
    }
    const drift = durationLooksShort(durationSeconds, expectedDurationSeconds, { toleranceSeconds, ratio });
    return { ok: true, reason: null, format, durationSeconds, verifiedBy, note: drift ? 'duration-drift' : null };
  };
}
