// EmbeddingClient（add-local-semantic-memory-recall）：主进程里管理 embedding 子进程。
//
// 调用顺序：available() 同步判断模型是否装好、是否已停用 → ready() 判断子进程是否已加载好模型
// → 没加载好时 warmUp() 在后台启动并预热（调用方本轮不等）→ embed(texts) 发请求
// → 子进程回向量或错误码 → 超时/崩溃/错误都抛 EmbeddingUnavailable，由调用方回落到按原话检索。
// 子进程空闲 idleMs 后退出，常驻内存（约 600 MB）随之释放；连续失败 maxFailures 次后本进程内不再启动。
//
// Python 类比：像一个懒启动的 multiprocessing.Process + Queue，带超时和空闲回收。
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isModelInstalled } from './embeddingModel.js';

const WORKER_PATH = fileURLToPath(new URL('./embeddingWorker.js', import.meta.url));

export class EmbeddingUnavailable extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class EmbeddingClient {
  constructor({ modelRoot, idleMs = 5 * 60_000, coldTimeoutMs = 6000, maxFailures = 3, forkImpl = fork, workerPath = WORKER_PATH,
    isInstalled = isModelInstalled, logger = console } = {}) {
    this.modelRoot = modelRoot;
    this.idleMs = idleMs;
    this.coldTimeoutMs = coldTimeoutMs;
    this.maxFailures = maxFailures;
    this.forkImpl = forkImpl;
    this.workerPath = workerPath;
    this.isInstalled = isInstalled;
    this.logger = logger;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.failures = 0;
    this.disabled = false;
    this.idleTimer = null;
    this._installed = null;
    this.warm = false;
    this._warming = null;
  }

  /** 模型装好且没有因连续失败停用。只看文件，不启动子进程。 */
  available() {
    if (this.disabled) return false;
    this._installed ??= Boolean(this.isInstalled(this.modelRoot));
    return this._installed;
  }

  /** 子进程已在运行且模型已加载：此时一次查询约 2 毫秒，交互路径可以等。 */
  ready() {
    return this.available() && Boolean(this.child) && this.warm;
  }

  /**
   * 后台启动子进程并加载模型，不抛错；重复调用共用同一次预热。
   * 交互路径在冷启动时只调它、不等它，冷启动的约 2.6 秒不落在用户的回合里。
   */
  warmUp() {
    if (!this.available() || this.ready()) return Promise.resolve(this.ready());
    this._warming ||= this.embed(['预热'], { timeoutMs: this.coldTimeoutMs })
      .then(() => true, () => false)
      .finally(() => { this._warming = null; });
    return this._warming;
  }

  /**
   * texts → Float32Array[]（已归一化）。失败抛 EmbeddingUnavailable。
   * 子进程还没起来时（冷启动要启动 Node、加载 transformers 与模型，实测约 2.6 秒）超时放宽到 coldTimeoutMs。
   */
  async embed(texts, { timeoutMs = 1500 } = {}) {
    if (!this.available()) throw new EmbeddingUnavailable('EMBEDDING_UNAVAILABLE');
    if (!texts.length) return [];
    if (!this.child || !this.warm) timeoutMs = Math.max(timeoutMs, this.coldTimeoutMs);
    const child = this._ensureChild();
    const id = this.nextId++;
    this._clearIdle();
    try {
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new EmbeddingUnavailable('EMBEDDING_TIMEOUT'));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        child.channel?.ref?.(); // 有请求在途时保持事件循环，等到回复或超时
        child.send({ id, texts });
      });
      this.failures = 0;
      this.warm = true;
      return splitVectors(reply, texts.length);
    } catch (error) {
      // 超时不计入失败：冷启动可能慢，下一次调用时模型已经加载好。
      if (error?.code !== 'EMBEDDING_TIMEOUT') this._recordFailure(error?.code);
      throw error instanceof EmbeddingUnavailable ? error : new EmbeddingUnavailable('EMBEDDING_FAILED');
    } finally {
      if (!this.pending.size) child.channel?.unref?.();
      this._armIdle();
    }
  }

  close() {
    this._clearIdle();
    const child = this.child;
    this.child = null;
    this.warm = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new EmbeddingUnavailable('EMBEDDING_CLOSED'));
    }
    this.pending.clear();
    if (child && child.exitCode === null) child.kill();
  }

  _ensureChild() {
    if (this.child) return this.child;
    // Electron 主进程里 process.execPath 是 Electron 本体；ELECTRON_RUN_AS_NODE 让子进程按纯 Node 运行。
    const child = this.forkImpl(this.workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LUNARA_EMBEDDING_MODEL_ROOT: this.modelRoot },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('message', message => {
      if (!message || message.ready) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new EmbeddingUnavailable(message.error));
      else entry.resolve(message);
    });
    const onGone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.warm = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new EmbeddingUnavailable('EMBEDDING_PROCESS_EXITED'));
      }
      this.pending.clear();
    };
    child.on('exit', onGone);
    child.on('error', onGone);
    // 子进程与 IPC 通道不拖住主进程退出。
    child.unref?.();
    child.channel?.unref?.();
    this.child = child;
    return child;
  }

  _recordFailure(code) {
    this.failures += 1;
    if (code === 'EMBEDDING_PACKAGE_MISSING' || this.failures >= this.maxFailures) {
      this.disabled = true;
      this.logger?.warn?.(`[embedding] 本地语义检索已停用（${code || 'EMBEDDING_FAILED'}），回落到按原话检索`);
      this.close();
    }
  }

  _armIdle() {
    if (this.pending.size || !this.child) return;
    this._clearIdle();
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  _clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function splitVectors({ dims, data }, count) {
  const width = Array.isArray(dims) ? dims[dims.length - 1] : 0;
  if (!width || !data || data.length !== width * count) throw new EmbeddingUnavailable('EMBEDDING_BAD_OUTPUT');
  return Array.from({ length: count }, (_, i) => Float32Array.from(data.subarray(i * width, (i + 1) * width)));
}
