import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export class TasteAdminService {
  constructor({
    consolidator,
    state,
    root,
    readText = path => readFile(path, 'utf8'),
    environmentSnapshot,
    getSchema = null,
    now = () => new Date(),
  } = {}) {
    this.consolidator = consolidator;
    this.state = state;
    this.root = root;
    this.readText = readText;
    this.environmentSnapshot = environmentSnapshot;
    this.getSchema = getSchema;
    this.now = now;
  }

  consolidate({ dryRun = false } = {}) {
    return this.consolidator.runConsolidation({ trigger: 'manual', dryRun: Boolean(dryRun) });
  }

  log({ limit = 20 } = {}) {
    const bounded = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
    return { ok: true, log: this.state.recentConsolidations(bounded) };
  }

  status() {
    const last = this.state.lastConsolidation();
    const lastAt = this.state.lastConsolidationAt();
    return {
      ok: true,
      running: this.consolidator.isRunning(),
      lastFinishedAt: last?.finished_at || null,
      lastSummary: last?.summary || null,
      threshold: { newPlays: this.state.playsCountSince(lastAt || 0), since: lastAt || 0 },
    };
  }

  async profile() {
    const read = name => this.readText(resolve(this.root, 'user', name)).catch(() => '');
    const [taste, routines, mood, playlistsRaw, env] = await Promise.all([
      read('taste.md'),
      read('routines.md'),
      read('mood-rules.md'),
      read('playlists.json'),
      this.environmentSnapshot(),
    ]);
    let playlists = {};
    try { playlists = JSON.parse(playlistsRaw || '{}'); } catch {}
    // DB 图式优先；旧文件只在没有任何图式行时兜底，并明确标注来源。
    let schemas = [];
    if (this.getSchema) {
      try { schemas = await this.getSchema() || []; } catch { schemas = []; }
    }
    const primary = schemas[0] || null;
    return {
      taste: primary?.content || taste,
      routines,
      mood,
      playlists,
      env,
      tasteSource: primary ? 'db-schema' : 'legacy-file',
      ...(schemas.length ? { schemas } : {}),
    };
  }

  today() {
    const date = this.now();
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { date: key, plan: this.state.loadPlan(key) };
  }
}
