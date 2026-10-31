// wav.js — WAV 容器解析与规范化。
//
// 为什么需要它：系统语音引擎写出的 WAV 往往带厂商附加块。macOS `say` 就会写入
// `JUNK` 与 `FLLR` 块，`fmt ` 因此不在固定偏移上。这类文件本身合法（RIFF 按块解析），
// 但直接对外有两个问题：
//   1. 体积里带着无意义的填充块；
//   2. 无法在代码里可靠地断言"这真的是 16-bit PCM"——而这正是我们对外声明的格式。
//
// 因此 provider 产出 PCM 时统一经过规范化，只保留 `fmt ` 与 `data`。
// 不支持的格式直接失败，绝不用改扩展名的方式冒充。

import { TtsSynthesisError } from './TtsProvider.js';

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'
const PCM_FORMAT = 1;

/**
 * 解析 RIFF 块结构，返回 fmt / data 的位置与参数。
 * 不做规范化，只读——供测试与诊断断言真实格式。
 */
export function readWavInfo(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 12 || buffer.readUInt32BE(0) !== RIFF || buffer.readUInt32BE(8) !== WAVE) {
    return null;
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const declaredSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    // 某些写入方把 size 写成 0xFFFFFFFF 或超出实际长度，按实际可用长度截断。
    const size = Math.max(0, Math.min(declaredSize, buffer.length - body));
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { offset: body, size };
    }
    // RIFF 块按偶数字节对齐
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return { ...fmt, dataOffset: data.offset, dataSize: data.size,
    durationMs: fmt.byteRate > 0 ? Math.round((data.size / fmt.byteRate) * 1000) : null };
}

/** 去掉厂商附加块，输出只含 `fmt ` 与 `data` 的最小规范 WAV。 */
export function toCanonicalWav(bytes, { providerId = null } = {}) {
  const info = readWavInfo(bytes);
  if (!info) {
    throw new TtsSynthesisError('not a readable RIFF/WAVE payload', {
      providerId, code: 'TTS_INVALID_WAV',
    });
  }
  if (info.audioFormat !== PCM_FORMAT) {
    throw new TtsSynthesisError(`unsupported wav encoding (audioFormat=${info.audioFormat}, expected PCM)`, {
      providerId, code: 'TTS_UNSUPPORTED_WAV_ENCODING',
    });
  }
  if (info.bitsPerSample !== 16) {
    throw new TtsSynthesisError(`unsupported wav bit depth (${info.bitsPerSample}, expected 16)`, {
      providerId, code: 'TTS_UNSUPPORTED_WAV_DEPTH',
    });
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + info.dataSize, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.byteRate, 28);
  header.writeUInt16LE(info.blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(info.dataSize, 40);
  return {
    bytes: Buffer.concat([header, buffer.subarray(info.dataOffset, info.dataOffset + info.dataSize)]),
    durationMs: info.durationMs,
    info,
  };
}
