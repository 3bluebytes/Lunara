// providerRegistry.contract.test.js — 锁住「源名单只有一处」的跨层契约。
//
// 这些断言不是在测试注册表本身（那在 providerRegistry.test.js），而是测试
// **它真的被各处用上了**：模型可见的 enum、库层的验证、工具的拒绝路径。
// 任何一处偷偷留了私有白名单，这里就会红。
import assert from 'node:assert/strict';
import test from 'node:test';
import { providerRegistry } from './providerRegistry.js';
import { MUSIC_SELECTION_PARAMETERS } from '../program/musicSelectionRequest.js';
import { TOOL_DEFS } from '../tools/songTagTools.js';
import { registerMusicTools } from '../virtual-person/musicTools.js';

const playable = providerRegistry.defaultSourceCandidates();

test('the playable source list is the registry list, not a hand-copied one', () => {
  assert.deepEqual(playable, ['ncm', 'qq']);
  assert.deepEqual(playable, providerRegistry.playableSources().map(s => s.id));
  // 目录源可以有，但不能是可播源。
  assert.equal(playable.includes('apple'), false);
});

test('like-write is a separate capability and only a verified source declares it', () => {
  // 读取「我喜欢」和写入「我喜欢」风险完全不同：写入会改真实账号，
  // 没在真机验证过的源不允许顺手声明。
  assert.equal(providerRegistry.supports('ncm', 'like'), true);
  assert.equal(providerRegistry.supports('ncm', 'like-write'), true);
  assert.equal(providerRegistry.supports('qq', 'like'), true, 'QQ 仍可读取收藏');
  // QQ 的写入必须走签名通道；真机上加歌/删歌都能读回权威状态后才允许声明。
  assert.equal(providerRegistry.supports('qq', 'like-write'), true,
    'QQ「我喜欢」双向写入已在签名通道上验证');
  assert.equal(providerRegistry.supports('apple', 'like-write'), false);
});

test('model-facing enums are derived from the registry', () => {
  // 点歌工具的歌单源
  const playlistSource = MUSIC_SELECTION_PARAMETERS.properties.playlist.properties.source;
  assert.deepEqual(playlistSource.enum, playable);

  // 打标工具的 provider
  for (const definition of TOOL_DEFS) {
    const provider = definition.function?.parameters?.properties?.provider;
    if (provider) assert.deepEqual(provider.enum, playable);
  }

  // 音乐工具：歌单读取用 all + 可播源，曲目读取只列可播源
  const registered = new Map();
  const registry = { register: (name, entry) => registered.set(name, entry) };
  registerMusicTools(registry, () => null);
  const paramsOf = name => registered.get(name)?.definition?.parameters;
  const userPlaylists = paramsOf('get_user_playlists');
  const playlistTracks = paramsOf('get_playlist_tracks');
  assert.ok(userPlaylists && playlistTracks, 'both music tools are registered');
  assert.deepEqual(userPlaylists.properties.source.enum, ['all', ...playable]);
  assert.deepEqual(playlistTracks.properties.source.enum, playable);
});

test('an unknown source is rejected by the tag tools instead of being half-accepted', async () => {
  const { getSongTags } = await import('../tools/songTagTools.js');
  const outcome = await getSongTags(
    { song_id: 'x', provider: 'kugou' },
    { store: null, currentTrack: () => null },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.data?.code, 'INVALID_TAG_PROVIDER');
  assert.doesNotMatch(outcome.content, /qq|ncm/i, 'the copy no longer hardcodes two source names');
});
