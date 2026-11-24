// mp3.js — MP3 分段元数据剥离、合法静音帧生成与无缝拼接。
//
// 多段语音（特别是带段间呼吸留白的多句私语）拼接成单个 .mp3 文件时：
//   1. 后续分片的 ID3v2 / ID3v1 标签若留在线性字节流中间，会污染音频帧；
//   2. 首帧若有 Xing/Info/VBRI VBR 头帧，它会把整首歌时长锁死在第一段的时长上，
//      导致浏览器 <audio> 进度条卡在 1/N 就以为结束或拖动定位错乱；
//   3. 段间直接拼帧会丢掉动作留白感，需按首段采样率/声道模式插入零主数据的合法 MPEG III 静音帧。

const SAMPLE_RATE_TABLES = Object.freeze({
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000],  // MPEG 2.5
});

const BITRATE_TABLES_KBPS = Object.freeze({
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
});

function parseFrameHeaderAt(buffer, offset) {
  if (!buffer || offset + 4 > buffer.length) return null;
  const b0 = buffer[offset];
  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];
  const b3 = buffer[offset + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  // Layer III only (layerBits === 1), versionBits 1 is reserved
  if (versionBits === 1 || layerBits !== 1) return null;

  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;

  const rates = SAMPLE_RATE_TABLES[versionBits];
  const bitrates = BITRATE_TABLES_KBPS[versionBits];
  if (!rates || !bitrates || sampleRateIdx > 2 || bitrateIdx === 0 || bitrateIdx === 15) return null;

  const sampleRate = rates[sampleRateIdx];
  const bitrateBps = bitrates[bitrateIdx] * 1000;
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  const coeff = versionBits === 3 ? 144 : 72;
  const frameSize = Math.floor((coeff * bitrateBps) / sampleRate) + padding;
  if (frameSize < 4) return null;

  const sideInfoBytes = versionBits === 3
    ? (channelMode === 3 ? 17 : 32)
    : (channelMode === 3 ? 9 : 17);

  return {
    offset,
    frameSize,
    versionBits,
    bitrateIdx,
    sampleRateIdx,
    sampleRate,
    channelMode,
    samplesPerFrame,
    sideInfoBytes,
  };
}

function isXingInfoVbriFrame(buffer, frame) {
  const xingPos = frame.offset + 4 + frame.sideInfoBytes;
  if (xingPos + 4 <= frame.offset + frame.frameSize && xingPos + 4 <= buffer.length) {
    const tag = buffer.toString('latin1', xingPos, xingPos + 4);
    if (tag === 'Xing' || tag === 'Info') return true;
  }
  const vbriPos = frame.offset + 4 + 32;
  if (vbriPos + 4 <= frame.offset + frame.frameSize && vbriPos + 4 <= buffer.length) {
    if (buffer.toString('latin1', vbriPos, vbriPos + 4) === 'VBRI') return true;
  }
  return false;
}

function id3v2Length(buffer) {
  if (buffer.length < 10 || buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return 0;
  const flags = buffer[5];
  const tagSize = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14)
    | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  const total = 10 + tagSize + (flags & 0x10 ? 10 : 0);
  return total < buffer.length ? total : 0;
}

/** 解析音频中首个真实的 MPEG Layer III 音频帧头；若无完整帧（如极短 mock 数据）返回 null。 */
export function parseFirstMpegFrame(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const start = id3v2Length(buffer);
  for (let pos = start; pos + 4 <= buffer.length; pos += 1) {
    if (buffer[pos] !== 0xff) continue;
    const frame = parseFrameHeaderAt(buffer, pos);
    if (!frame || pos + frame.frameSize > buffer.length) continue;
    const nextPos = pos + frame.frameSize;
    if (nextPos === buffer.length || parseFrameHeaderAt(buffer, nextPos)) {
      return frame;
    }
  }
  return null;
}

/** 剥离分段 MP3 的 ID3v2 / ID3v1 及可选的 VBR Xing/Info/VBRI 头帧。 */
export function stripMp3Metadata(bytes, { stripLeadingId3v2 = false, stripTrailingId3v1 = false, stripXingFrame = false } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  let start = 0;
  let end = buffer.length;
  if (stripLeadingId3v2) {
    start = id3v2Length(buffer);
  }
  if (stripTrailingId3v1 && end - start >= 128 && buffer[end - 128] === 0x54
    && buffer[end - 127] === 0x41 && buffer[end - 126] === 0x47) {
    end -= 128;
  }
  let sliced = buffer.subarray(start, end);
  if (stripXingFrame) {
    const first = parseFirstMpegFrame(sliced);
    if (first && isXingInfoVbriFrame(sliced, first)) {
      sliced = sliced.subarray(first.offset + first.frameSize);
    }
  }
  return sliced;
}

/**
 * 依据首段音频帧参数生成指定毫秒时长的全零主数据静音 MPEG Layer III 帧。
 * 静音帧 main_data_begin 恒为 0，顺便重置前一段残留的比特池，消除跨句拼接杂音。
 */
export function createMp3SilenceFrames(durationMs, frameInfo) {
  const ms = Math.max(0, Number(durationMs) || 0);
  if (!ms || !frameInfo?.sampleRate || !frameInfo?.samplesPerFrame) return Buffer.alloc(0);

  const frameDurationMs = (frameInfo.samplesPerFrame / frameInfo.sampleRate) * 1000;
  const frameCount = Math.max(1, Math.round(ms / frameDurationMs));

  const versionBits = frameInfo.versionBits;
  const sampleRateIdx = frameInfo.sampleRateIdx;
  const channelMode = frameInfo.channelMode;
  // 选择稳妥 CBR 码率槽，确保每帧字节长度远大于侧信息头
  const bitrateIdx = frameInfo.bitrateIdx >= 5 && frameInfo.bitrateIdx <= 14 ? frameInfo.bitrateIdx : 9;
  const bitrates = BITRATE_TABLES_KBPS[versionBits];
  const rates = SAMPLE_RATE_TABLES[versionBits];
  if (!bitrates || !rates) return Buffer.alloc(0);

  const bitrateBps = bitrates[bitrateIdx] * 1000;
  const sampleRate = rates[sampleRateIdx];
  const coeff = versionBits === 3 ? 144 : 72;
  const frameSize = Math.floor((coeff * bitrateBps) / sampleRate);
  if (frameSize < 4 + frameInfo.sideInfoBytes) return Buffer.alloc(0);

  const frame = Buffer.alloc(frameSize);
  frame[0] = 0xff;
  frame[1] = 0xe0 | (versionBits << 3) | (1 << 1) | 1; // Layer III + protection_bit=1 (无 CRC)
  frame[2] = (bitrateIdx << 4) | (sampleRateIdx << 2);
  frame[3] = channelMode << 6;

  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

/** 拼接多段 MP3 音频：统一清洗内部标签与 Xing 头帧，并在段间按需插入真实静音帧。 */
export function concatMp3Buffers(parts, { pausesMs = [] } = {}) {
  const list = Array.isArray(parts) ? parts : [];
  if (!list.length) return { bytes: Buffer.alloc(0), durationMs: 0 };
  if (list.length === 1) {
    const only = list[0];
    return {
      bytes: Buffer.isBuffer(only.bytes) ? only.bytes : Buffer.from(only.bytes || []),
      durationMs: Number.isFinite(only.durationMs) ? only.durationMs : null,
    };
  }

  const rawBuffers = list.map(part => (Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes || [])));
  const frameInfo = rawBuffers.map(parseFirstMpegFrame).find(Boolean) || null;
  const chunks = [];
  let totalPauseMs = 0;

  for (let i = 0; i < rawBuffers.length; i += 1) {
    const pause = i > 0 ? Math.max(0, Number(pausesMs[i]) || 0) : 0;
    if (pause > 0 && frameInfo) {
      const silence = createMp3SilenceFrames(pause, frameInfo);
      if (silence.length) {
        chunks.push(silence);
        totalPauseMs += pause;
      }
    }
    const cleaned = stripMp3Metadata(rawBuffers[i], {
      stripLeadingId3v2: i > 0,
      stripTrailingId3v1: i < rawBuffers.length - 1,
      stripXingFrame: Boolean(frameInfo),
    });
    if (cleaned.length) chunks.push(cleaned);
  }

  const durationsKnown = list.every(part => Number.isFinite(part.durationMs));
  const durationMs = durationsKnown
    ? list.reduce((sum, part) => sum + part.durationMs, 0) + totalPauseMs
    : null;

  return { bytes: Buffer.concat(chunks), durationMs };
}
