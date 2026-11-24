/**
 * 手帐页边伙伴批注生成：结合人格文档与私密记忆，产出带原文锚点校验的简短批注。
 *
 * 独立于 server/index.js 组合根，维持入口文件精简与可单测性。
 */

/**
 * 创建手帐页边批注生成器。
 * @param {object} deps
 * @param {object} [deps.virtualPerson] 虚拟人运行时对象（含 registry）
 * @param {() => object|null} [deps.getStation] 获取当前 Station 实例的延迟读取器
 * @param {(personId: string) => string} [deps.loadPersonaMarkdown] 读取磁盘人格文档兜底
 * @param {object} deps.llm LLM 客户端（需提供 chat、extractJson、LLMNotConfiguredError）
 * @returns {(input: { entry: object, person?: object, personId: string }) => Promise<{ anchor: string, text: string }>}
 */
export function createJournalAnnotationGenerator({
  virtualPerson,
  getStation,
  loadPersonaMarkdown,
  llm,
}) {
  return async function generateJournalAnnotation({ entry, person, personId }) {
    const personaText = String(
      virtualPerson?.registry?.get?.(personId)?.personaDocument
      || person?.personaDocument
      || loadPersonaMarkdown?.(personId)
      || '',
    ).trim().slice(0, 1400);

    const memStore = getStation?.()?.stationMemory?.store;
    const ns = person?.memoryNamespace;
    const memLines = memStore && ns
      ? memStore.search({ namespace: ns, excludeTags: ['revoked', 'superseded'], limit: 6 })
        .map(m => `- ${String(m.summary || m.content || '').trim()}`)
        .filter(s => s.length > 2)
        .slice(0, 6)
      : [];

    const tracksText = (entry.attachedTracks || []).slice(0, 4)
      .map(t => `《${t.title}》${t.artist ? ` - ${t.artist}` : ''}${t.playedAt ? ` (${t.playedAt})` : ''}`)
      .join('、');
    const quotesText = (entry.attachedQuotes || []).slice(0, 4)
      .map(q => `[${q.speaker} ${q.time || ''}] ${q.text}`)
      .join('\n');
    const sourceBlob = [entry.title || '', entry.content || '', quotesText].join('\n');

    const systemPrompt = [
      `你是 ${person?.displayName || personId}，正在给朋友今天写的一页手帐页边留下一句简短真实的批注。`,
      personaText ? `【你的性格与说话方式】\n${personaText}` : '',
      memLines.length ? `【你与TA的私有记忆参考】\n${memLines.join('\n')}` : '',
      '【规则】',
      '1. 仅输出 JSON：{"anchor":"原文短句（最多16字，如无可引内容写空串）","text":"批注正文（16-90字，你的真实口吻，像写在页边的手写便签）"}',
      '2. anchor 必须原样出自用户本页标题、正文或贴入的原话，禁止改字或编造；没有合适锚点就留空串 ""。',
      '3. 不替用户下情绪结论、不编造未发生的见面/听歌/EXIF/天气、不使用系统字段或 Markdown 标题。',
    ].filter(Boolean).join('\n\n');

    const userPrompt = [
      `手帐日期：${entry.localDate || ''}${entry.mood ? ` · 心情：${entry.mood}` : ''}`,
      entry.title ? `标题：${entry.title}` : '',
      entry.content ? `正文：\n${String(entry.content).slice(0, 1200)}` : '',
      tracksText ? `贴入的听歌：${tracksText}` : '',
      quotesText ? `贴入的原话：\n${quotesText}` : '',
    ].filter(Boolean).join('\n\n');

    let result;
    try {
      result = await llm.chat(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        null,
        { taskId: 'journal_annotation' },
      );
    } catch (error) {
      if (
        (llm?.LLMNotConfiguredError && error instanceof llm.LLMNotConfiguredError)
        || error?.name === 'LLMNotConfiguredError'
        || error?.code === 'LLM_NOT_CONFIGURED'
      ) {
        const err = new Error('model unavailable');
        err.code = 'annotation_llm_unavailable';
        throw err;
      }
      throw error;
    }

    const raw = String(result?.message?.content || '').trim();
    const parsed = llm.extractJson(raw);
    const rawAnchor = String(parsed?.anchor || '').trim().slice(0, 16);
    const verifiedAnchor = rawAnchor && sourceBlob.includes(rawAnchor) ? rawAnchor : '';
    const text = String(parsed?.text || (!parsed ? raw.replace(/^```[\s\S]*?\n|```$/g, '') : ''))
      .trim()
      .slice(0, 180);
    if (!text) {
      const err = new Error('empty annotation');
      err.code = 'annotation_empty';
      throw err;
    }
    return { anchor: verifiedAnchor, text };
  };
}
