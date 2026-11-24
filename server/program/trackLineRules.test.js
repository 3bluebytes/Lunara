// 串词校验规则：host 写的每条串词都过这一组确定性判定。样本是听众指出“太标准化”的真实串词。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NARRATION_MIN_LENGTH, STYLE_RULES, lineShapes, narrationDefect, narrationRuleFeedback, overusedPhrases, overusedShapes } from './ProgramNarrationComposer.js';

const SAMPLES = [
  '林宥嘉的《兜圈》。它走得慢，人声也一直收着，落在手边的事情旁边不碍事。唱的是绕远的路，可它没把绕远当成后悔——那些看着像浪费掉的时间，它自己觉得值。',
  '《绵绵》，陈奕迅，收在《打得火热》里。钢琴和弦乐都垫得很低，人声也一直往里收，安静得不去抢谁。它通篇在否认，说自己没爱过，可那股劲儿分明是舍不得——话讲得越用力，越像招供。',
  '陈奕迅的《粤语残片》。它回头看当年那些手忙脚乱，没把笨拙说成难堪，倒像隔了很多年终于能笑着认下来。后来心动一次比一次浅这件事，它也只是承认，不抱怨。吉他和弦乐都铺得不重，人声收在里面，放在手边有事的时候不碍事。',
  '方大同的《总结》。你夸过他那首《每天每天》甜得干脆，这首反过来了——它一句结论都不肯下，把从前摊在那儿，承认自己躲，也不急着替谁收尾。钢琴和鼓都走得很慢，声音收在里面，搁在手边的事旁边不吵。',
  '周杰伦的《轨迹》，收在《寻找周杰伦》里。钢琴和弦乐都垫得很低，人声一路往里收，安静到不占地方。它唱的是舍不得，却偏偏用最平的语气说出来——越不使劲，那点留恋越藏不住。',
  '陈奕迅和 eason and the duo band 的《渐渐》，收在《L.O.V.E.》里。它没把疏远写成一场争吵，只让一切慢慢淡下去，连"不想知道"都说得心平气和——那种平静比哭更让人心里发凉。钢琴和弦乐铺得很低，人声也不往前挤。',
  '《大个女》，陈奕迅。它不像一般的成长歌那样催人往前，反倒一句句在松绑——做最后一名也被允许，心记得要开就好。钢琴和弦乐都垫得很浅，人声收在里面，做手边的事时它不抢位置。',
  '方大同的《苏丽珍》，收在《爱爱爱》里。你先前喜欢他甜得直接的那一面，这首正好相反——整首歌都是一个人在心底反复掂量，话到嘴边又收回去，它不肯替谁下决定，只把这份犹犹豫豫唱得很干净。钢琴和吉他都轻，人声也不往前挤，安静得不会打扰手边的事。',
];

const track = { title: '晴天', artist: '周杰伦', album: '叶惠美' };
const check = (text, options = {}) => narrationDefect(text, { track: options.track || track,
  facts: { album: track.album, year: null }, recentConversation: [], minSentences: 1, minChars: 12, ...options });

test('host 写的普通一句话能通过，歌手和位置不限，歌名必须有', () => {
  assert.equal(check('下雨天翻出来的《晴天》，还是当年那个味道。'), null);
  assert.equal(check('周杰伦的《晴天》，每次听都想起操场边那棵树。'), null);
  assert.equal(check('周杰伦这首老歌，每次听都想起操场边那棵树。'), 'missing-title');
});

test('听感和声音可以照自己的想象说：乐器、编曲、人声怎么处理都不拦', () => {
  for (const line of ['《晴天》的钢琴垫得很低，听着舒服。', '《晴天》这段吉他真好听，一直绕着走。', '《晴天》里弦乐进来的那一下很动人。',
    '《晴天》人声压着唱，反而更动人。', '《晴天》的编曲很克制，留了很多空。', '《晴天》琴声一起，人就静了。',
    '《晴天》我猜听起来像傍晚的操场，风有点凉。', '《晴天》整首不到五分钟，刚好听完。']) {
    assert.equal(check(line), null, line);
  }
});

test('unsupported-fact：发行年份或专辑和曲库记的对不上才拒绝，曲库没记的不查', () => {
  const known = { facts: { album: '叶惠美', year: 2003 } };
  assert.equal(check('《晴天》是 2003 年发行的，收在《叶惠美》里。', known), null);
  assert.equal(check('《晴天》是 2001 年发行的老歌了。', known), 'unsupported-fact');
  assert.equal(check('《晴天》收录在专辑《范特西》里。', known), 'unsupported-fact');
  assert.equal(check('《晴天》让我想起 2008 年那个夏天。', known), null, '不是在说发行年份');
  assert.equal(check('《晴天》是 2001 年发行的老歌了。'), null, '曲库没记年份就不查');
  assert.match(narrationRuleFeedback('unsupported-fact', { track, ...known }, ''), /叶惠美.*2003/u);
});

test('unbacked-listener-claim：续播里声称听众说过什么要被拦', () => {
  for (const line of ['你说想找不抢事的背景，那就《晴天》吧。', '这是你要的那种安静，《晴天》。', '你提过喜欢老歌，放一首《晴天》。',
    '你想要的慢歌来了，《晴天》。', '你夸过他的旋律，这首《晴天》也一样。']) {
    assert.equal(check(line), 'unbacked-listener-claim', line);
  }
});

test('unbacked-listener-claim：听众本回合的请求或本曲记忆可以作依据', () => {
  assert.equal(check('这是你要的那种安静，《晴天》。', { listenerAsked: true }), null);
  assert.equal(check('你夸过他的旋律，这首《晴天》也一样。', { memories: ['听众夸过周杰伦的旋律'] }), null);
  assert.equal(check('如果你喜欢老歌，《晴天》大概不会错。'), null);
});

test('immediate-reference：提及紧接的前一首一律拒绝，松散联想照常接受', () => {
  for (const line of ['刚才那首之后，接一首《晴天》。', '接着刚才的情绪，放《晴天》。', '上一首有点吵，换《晴天》。', '刚刚那段听完，来《晴天》。']) {
    assert.equal(check(line), 'immediate-reference', line);
  }
  assert.equal(check('还记得《七里香》吗，同一个人写的《晴天》也在这张碟附近。'), null);
});

test('overusedPhrases：最近实际说出的串词里 3 条以上共有的片段', () => {
  const phrases = overusedPhrases(SAMPLES);
  for (const expected of ['人声', '手边', '钢琴', '弦乐']) {
    assert.ok(phrases.some(phrase => phrase.includes(expected)), `应当抓到「${expected}」，实际 ${phrases.join('、')}`);
  }
  assert.ok(!phrases.includes('的'), '单字不算片段');
});

test('overusedPhrases：只看最近 8 条，不到 3 条不算，歌名不算', () => {
  const lines = ['《不碍事》不碍事地放着。', '这首不碍事。', '另一首也不碍事。'];
  assert.ok(overusedPhrases(lines).includes('不碍事'), '3 条共有');
  assert.ok(!overusedPhrases(lines.slice(0, 2)).includes('不碍事'), '2 条不算');
  const older = [...lines, ...Array.from({ length: 8 }, (_, index) => `第${index}句完全不同的话${index}`)];
  assert.ok(!overusedPhrases(older).includes('不碍事'), '8 条之外的不算');
  const named = ['《晴天》真好。', '又是《晴天》呀。', '还听《晴天》吗。'];
  assert.ok(!overusedPhrases(named).some(phrase => phrase.includes('晴天')), '书名号里的歌名不算');
  assert.ok(!overusedPhrases([{ text: '陈奕迅很好。', artist: '陈奕迅' }, { text: '还是陈奕迅呀。', artist: '陈奕迅' },
    { text: '陈奕迅又来了。', artist: '陈奕迅' }]).some(phrase => phrase.includes('陈奕迅')), '那条串词自己的歌手不算');
  assert.deepEqual(overusedPhrases(['这首歌是一个。', '这首歌不是一个。', '这首歌就是一个。']).filter(phrase => ['这首', '一个', '不是'].includes(phrase)), [], '停用词不算');
});

test('overused-phrase：新串词用了用滥词要改写，歌名歌手里的不算', () => {
  assert.equal(check('《晴天》放在这里，放着不碍事。', { overusedPhrases: ['不碍事'] }), 'overused-phrase');
  assert.equal(check('《晴天》放在这里，放着不打扰。', { overusedPhrases: ['不碍事'] }), null);
  assert.equal(check('周杰伦的《晴天》放在这里。', { overusedPhrases: ['周杰伦', '晴天'] }), null);
  assert.match(narrationRuleFeedback('overused-phrase', { overusedPhrases: ['不碍事'] }, '《晴天》放着不碍事。'), /不碍事/u);
});

test('样本里替听众说话的两条仍被拒绝，只描述听感的不再因为声音被拒', () => {
  const titles = [['兜圈', '林宥嘉'], ['绵绵', '陈奕迅'], ['粤语残片', '陈奕迅'], ['总结', '方大同'], ['轨迹', '周杰伦'],
    ['渐渐', '陈奕迅'], ['大个女', '陈奕迅'], ['苏丽珍', '方大同']];
  const albums = ['', '打得火热', '', '', '寻找周杰伦', 'L.O.V.E.', '', '爱爱爱'];
  const defects = SAMPLES.map((text, index) => narrationDefect(text, { track: { title: titles[index][0], artist: titles[index][1] },
    facts: { album: albums[index], year: null }, recentConversation: [], minSentences: 1, minChars: 12, styleChecks: false }));
  assert.equal(defects[3], 'unbacked-listener-claim');
  assert.equal(defects[7], 'unbacked-listener-claim');
  assert.ok(!defects.includes('unverifiable-sound'), JSON.stringify(defects));
});

test('篇幅：只有下限和异常上限；8 句 300 字通过，13 句被拒', () => {
  assert.deepEqual(NARRATION_MIN_LENGTH, { minChars: 12, minSentences: 1 });
  const inputs = { track: { title: '晴天', artist: '周杰伦' }, facts: {}, recentConversation: [] };
  const sentence = '这一句大概有四十个字，用来把一段话撑到足够长的篇幅，看它会不会因为说得多了一点就被拦下来';
  const long = `《晴天》先放着。${Array.from({ length: 7 }, (_, index) => `${sentence}${index}。`).join('')}`;
  assert.ok(long.length >= 300, String(long.length));
  assert.equal(narrationDefect(long, { ...inputs, styleChecks: false }), null);
  const many = `《晴天》先放着。${'再说一句。'.repeat(12)}`;
  assert.equal(narrationDefect(many, { ...inputs, styleChecks: false }), 'sentence-count');
});

test('长度和句数：目标只给写作参考，机械只查下限和异常上限', () => {
  const long = `《晴天》${'这段话说得比目标篇幅长一些，'.repeat(15)}到这里。`;
  assert.ok(long.length > 200 && long.length < 650);
  assert.equal(check(long), null);
  assert.equal(check(`《晴天》${'很长'.repeat(330)}。`), 'too-long');
  assert.equal(check('《晴天》。'), 'too-short');
});

test('反馈不把否定式判断或“它不肯做什么”当写法', () => {
  for (const rule of ['retells-lyrics', 'recites-lyrics', 'unbacked-listener-claim', 'immediate-reference']) {
    const feedback = narrationRuleFeedback(rule, { track }, '');
    assert.doesNotMatch(feedback, /不肯|判断/u, rule);
    assert.match(feedback, new RegExp(rule), rule);
  }
});

// ── 2026-11-07 一小时实机里看到的套路（歌名照搬，句子是转述） ────────────────────
const real = (title, artist) => ({ track: { title, artist } });

test('stock-phrasing：「没把 X 唱成 Y，反而…」和「最 X 的地方」这类套话句式要改写', () => {
  for (const [line, options] of [
    ['《爱与诚》，古巨基。它不把分手唱成一场闹剧，反而像谈一件早就该谈清的事。', real('爱与诚', '古巨基')],
    ['孙燕姿《我不难过》。她没有把难过唱成控诉，反而把对方的错也一并放过。', real('我不难过', '孙燕姿')],
    ['《关于爱的定义》，方大同。这首歌里他没打算把爱说清，反而承认它是模糊的。', real('关于爱的定义', '方大同')],
    ['《才二十三》放在这儿。没有把话说圆，只是承认了。', real('才二十三', '方大同')],
    ['《爱与诚》这首歌最狠的地方是，它一点不躲。', real('爱与诚', '古巨基')],
    ['《必杀技》，它最准的地方是那股没正经。', real('必杀技', '古巨基')],
    ['《晴天》整首最打动人的地方，是它一直没长大。', {}],
  ]) assert.equal(check(line, options), 'stock-phrasing', line);
});

test('stock-phrasing：普通的否定和比较不算', () => {
  for (const line of ['《晴天》不算新歌了，可我还是常放。', '没把《晴天》放进歌单之前，我都快忘了它。', '《晴天》里我最喜欢的是那句结尾。',
    '《晴天》是我觉得他写得最好的一首。', '《晴天》一响，像回到最开始的地方。']) assert.equal(check(line), null, line);
});

test('immediate-reference：前一首、接着是、下一首也是在接前后文', () => {
  for (const line of ['《晴天》这首比前一首安静，慢慢听。', '接着是《晴天》，换个心情。', '前面那首太吵，《晴天》安静点。', '《晴天》放完，下一首换个口味。']) {
    assert.equal(check(line), 'immediate-reference', line);
  }
});

test('talks-about-material：不跟听众谈素材本身（没拿到歌词之类）', () => {
  for (const line of ['《晴天》这首我没拿到歌词，就不装作听懂了。', '《晴天》的歌词我这次没看到，只说说感觉。', '《晴天》素材里没写它是哪年的。']) {
    assert.equal(check(line), 'talks-about-material', line);
  }
  assert.equal(check('《晴天》的歌词我一直记不全。'), null);
});

test('repeats-reference：别的串词（同一批、待念、最近说过的）已经拿来对比过的歌，这条不再提', () => {
  const others = [{ text: '《总结》放这。你之前说《每天每天》是小甜歌，这首反过来。', title: '总结', artist: '方大同' }];
  const options = { track: { title: '关于爱的定义', artist: '方大同' }, otherLines: others };
  assert.equal(check('《关于爱的定义》也不像《每天每天》那么甜。', options), 'repeats-reference');
  assert.equal(check('《关于爱的定义》把爱讲得很含糊，他不急着下结论。', options), null);
  assert.equal(check('《关于爱的定义》也不像《每天每天》那么甜。', { track: options.track }), null, '没有别的串词提过就不算');
  assert.equal(check('《总结》又来了一遍，我还是喜欢。', { track: { title: '总结', artist: '方大同' }, otherLines: others }), null,
    '自己的歌名不算对比');
});

// 2026-11-07 实机念出来的串词：14 条里大多是同一种句式，换了词片段检查也拦不住。
const SHAPED = [
  '《裙下之臣》。这首歌最坦白的不是那些欲望，是它把自己摆得那么低还乐在其中。',
  '《How Long Will I Love You》。这首歌问的不是爱有多深，是能有多久——把期限这个问题摊开，还是愿意答下去。',
  '《Fly Me to the Moon》。这歌名本身就是一句很贪心的请求——不是想靠近，是想干脆换个轨道。',
  '《我什么都没有》。这歌狠的地方是它不哭，一样样数完自己缺什么，还笑着说不用难受。',
];

test('lineShapes：认得出“不是 A，是 B”的对比、破折号接解读、拿歌当主语下判断', () => {
  assert.deepEqual([...lineShapes(SHAPED[0])].sort(), ['contrast', 'song-verdict']);
  assert.deepEqual([...lineShapes(SHAPED[1])].sort(), ['contrast', 'dash', 'song-verdict']);
  assert.deepEqual([...lineShapes(SHAPED[2])].sort(), ['contrast', 'dash']);
  assert.deepEqual([...lineShapes(SHAPED[3])], ['song-verdict']);
  assert.deepEqual([...lineShapes('下雨了，给你放《晴天》，一起听会儿。')], []);
  assert.deepEqual([...lineShapes('《晴天》不是新歌，可你应该会喜欢。')], [], '只有“不是”没有翻转不算对比');
});

test('overusedShapes：最近 6 条里出现 3 次以上的句式才算用滥', () => {
  assert.deepEqual(overusedShapes(SHAPED.map(text => ({ text }))).sort(), ['contrast', 'song-verdict']);
  assert.deepEqual(overusedShapes(SHAPED.slice(0, 2).map(text => ({ text }))), []);
  const old = [...SHAPED, '《甲》，放着。', '《乙》，放着。', '《丙》，放着。', '《丁》，放着。', '《戊》，放着。', '《己》，放着。'];
  assert.deepEqual(overusedShapes(old.map(text => ({ text }))), [], '只看最近 6 条');
});

test('repeats-shape：同一句式最近已经用滥，这条又用就退回，并点名是哪种句式', () => {
  const otherLines = SHAPED.map(text => ({ text }));
  const line = '《晴天》写的不是夏天，是那年没说出口的话。';
  assert.equal(check(line, { otherLines }), 'repeats-shape');
  assert.match(narrationRuleFeedback('repeats-shape', { otherLines }, line), /不是 A，是 B/u);
  assert.equal(check('《晴天》——下雨天就该放它。', { otherLines }), null, '破折号最近只用了两次');
  assert.equal(check(line, { otherLines: otherLines.slice(0, 2) }), null, '用得不多时不拦');
  assert.equal(check('下雨了，给你放《晴天》，一起听会儿。', { otherLines }), null);
});

test('风格类后判：一条既替听众说话又套了句式，先报事实问题', () => {
  assert.equal(check('《晴天》最动人的地方是你说过想要的那种安静。'), 'unbacked-listener-claim');
});

test('styleChecks: false 时风格类不判，事实类照判', () => {
  assert.equal(check('《晴天》最动人的地方，是你那天一直在哼。'), 'stock-phrasing');
  assert.equal(check('《晴天》最动人的地方，是你那天一直在哼。', { styleChecks: false }), null);
  assert.equal(check('你提过喜欢老歌，放一首《晴天》。', { styleChecks: false }), 'unbacked-listener-claim');
  assert.deepEqual([...STYLE_RULES].sort(), ['overused-phrase', 'repeats-reference', 'repeats-shape', 'stock-phrasing']);
});
