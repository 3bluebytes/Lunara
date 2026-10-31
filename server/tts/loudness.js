// loudness.js — 合成产出的响度归一化。
//
// 不同语音引擎的原始电平不同；统一可处理的 PCM 输出，避免换声线就换音量。
//
// 只处理 16-bit PCM WAV：那是本地 provider 的输出格式，且能在 JS 里无损地读写。
// mp3 等非 PCM 音频不在这里解码，原样透传（不声称已完成 PCM 响度归一化）。
//
// 响度用 dBFS RMS 度量，不声称是 EBU R128 的 LUFS：
// 完整 K 加权门限实现代价高，而这里的目的只是让各 provider 之间的电平可比。

import { TtsSynthesisError } from './TtsProvider.js';
import { readWavInfo } from './wav.js';

/** 目标电平：-18 dBFS RMS。实测自然语音落在 0.10–0.14 RMS 之间。 */
export const TARGET_RMS_DB = -18;
/** 最大提升量。避免把近乎静音或有底噪的输入放大成可听见的噪声。 */
export const MAX_GAIN_DB = 12;
/** 真峰值上限：-1 dBFS，留出转码余量。 */
const PEAK_CEILING_DB = -1;

const dbToRatio = db => 10 ** (db / 20);
const ratioToDb = ratio => 20 * Math.log10(Math.max(ratio, 1e-12));

/** 读取 16-bit PCM WAV 的样本统计。非 WAV 返回 null。 */
export function measurePcm(bytes) {
  const info = readWavInfo(bytes);
  if (!info || info.bitsPerSample !== 16 || info.audioFormat !== 1) return null;
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const start = info.dataOffset;
  const end = start + info.dataSize;
  const count = Math.floor(info.dataSize / 2);
  if (count <= 0) return { ...info, count: 0, rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = data.readInt16LE(start + index * 2) / 32768;
    sumSquares += sample * sample;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  void end;
  return { ...info, count, rms: Math.sqrt(sumSquares / count), peak };
}

/**
 * 把音频归一化到目标电平。
 *
 * 行为：
 *   - 非 WAV / 无法解码 → 原样返回（不假装处理过）
 *   - 已是目标电平 → 不做任何改动
 *   - 需要提升但会超峰值 → 只提升到不超峰的程度，而不是削波
 *   - 需要压低的电平不会被压低（本函数的目的是补足过轻，不是统一压平）
 *
 * @returns {{ bytes: Buffer, changed: boolean, gainDb: number, loudnessDb: number|null, peakDb: number|null }}
 */
export function normalizeLoudness(bytes, {
  targetRmsDb = TARGET_RMS_DB,
  maxGainDb = MAX_GAIN_DB,
  peakCeilingDb = PEAK_CEILING_DB,
  providerId = null,
} = {}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const measured = measurePcm(source);
  if (!measured || measured.count === 0) {
    return { bytes: source, changed: false, gainDb: 0, loudnessDb: null, peakDb: null };
  }
  if (measured.rms <= 0) {
    // 全静音：提升它只会得到更响的静音，因此不动。
    return { bytes: source, changed: false, gainDb: 0, loudnessDb: ratioToDb(0), peakDb: ratioToDb(measured.peak) };
  }
  const loudnessDb = ratioToDb(measured.rms);
  const peakDb = ratioToDb(measured.peak);
  const desiredGainDb = Math.min(targetRmsDb - loudnessDb, maxGainDb);
  // 提升不应让峰值越过天花板。
  const headroomDb = peakCeilingDb - peakDb;
  const gainDb = Math.max(0, Math.min(desiredGainDb, headroomDb));
  if (gainDb < 0.1) {
    return { bytes: source, changed: false, gainDb: 0, loudnessDb, peakDb };
  }
  const gain = dbToRatio(gainDb);
  const data = Buffer.from(source);
  const start = measured.dataOffset;
  for (let index = 0; index < measured.count; index += 1) {
    const offset = start + index * 2;
    const value = data.readInt16LE(offset) * gain;
    // 夹紧而不是回绕：溢出会变成刺耳的爆音。
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), offset);
  }
  const after = measurePcm(data);
  return {
    bytes: data,
    changed: true,
    gainDb,
    loudnessDb: ratioToDb(after.rms),
    peakDb: ratioToDb(after.peak),
  };
}

/** 供 provider 或测试断言使用的便捷包装：归一化失败不应让合成整体失败。 */
export function normalizeLoudnessSafely(bytes, options = {}) {
  try {
    return normalizeLoudness(bytes, options);
  } catch (error) {
    if (error instanceof TtsSynthesisError) throw error;
    return { bytes, changed: false, gainDb: 0, loudnessDb: null, peakDb: null, error: error.message };
  }
}
