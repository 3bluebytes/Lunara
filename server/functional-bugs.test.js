// functional-bugs.test.js — Regression tests for story-level Lunara bugs.
//
// Run: node server/functional-bugs.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempCwd = mkdtempSync(resolve(tmpdir(), 'lunara-regression-'));
process.chdir(tempCwd);

let passed = 0;
let failed = 0;

function fresh(rel) {
  return import(`${pathToFileURL(resolve(ROOT, rel)).href}?t=${Date.now()}_${Math.random()}`);
}

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

async function testInvalidActivationKeepsCurrentRadiohost() {
  const { RadioHostRegistry, createRadioHost } = await fresh('server/station/RadioHost.js');
  const registry = new RadioHostRegistry().initialize();
  registry.register(createRadioHost({ id: 'radiohost-a', voiceProfileId: 'voice-a', name: 'A', status: 'active' }));
  registry.register(createRadioHost({ id: 'radiohost-b', voiceProfileId: 'voice-b', name: 'B', status: 'inactive' }));

  const result = registry.setActive('missing-radiohost');

  assert(result === null, 'invalid activation returns null');
  assert(registry.getActive()?.id === 'radiohost-a', 'invalid activation does not clear current active radiohost');
}

async function testOutcomeCanArriveAfterQueueDelay() {
  const state = await fresh('server/state.js');
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    state.logPlay({ song_id: 'song-late', query: 'late song', title: 'Late Song', artist: 'Radiohost' });
    now += 10 * 60 * 1000;
    const r = state.recordOutcome({ song_id: 'song-late', outcome: 'completed', played_seconds: 240 });
    assert(r.updated === 1, 'play outcome still updates after a delayed queue start');
  } finally {
    Date.now = realNow;
  }
}

async function testPersonaFallbackKeepsLegacyFieldsAndBoundaries() {
  const { generatePersona, personaToMemoryRecords } = await fresh('server/station/PersonaGenerator.js');
  const previousMode = process.env.LUNARA_PERSONA_GENERATION_MODE;
  process.env.LUNARA_PERSONA_GENERATION_MODE = 'fallback';
  let persona;
  try {
    persona = await generatePersona({
      voiceProfile: {
        displayName: '电台男主播',
        description: '深夜电台男声',
        styleTags: ['broadcast', 'gentle'],
        gender: 'male',
      },
    });
  } finally {
    if (previousMode === undefined) delete process.env.LUNARA_PERSONA_GENERATION_MODE;
    else process.env.LUNARA_PERSONA_GENERATION_MODE = previousMode;
  }

  assert(!!persona.personaDescription, 'persona exposes personaDescription compatibility field');
  assert(!!persona.speakingStyle, 'persona exposes speakingStyle compatibility field');
  assert(!!persona.boundaries, 'persona includes boundary setting');

  const records = personaToMemoryRecords(persona, 'radiohost:test-persona');
  assert(records.some(r => r.content.startsWith('边界设定：')), 'persona memory records include boundaries');
}




async function run() {
  console.log('\n🧪 Lunara functional regression tests\n');
  await testInvalidActivationKeepsCurrentRadiohost();
  await testOutcomeCanArriveAfterQueueDelay();
  await testPersonaFallbackKeepsLegacyFieldsAndBoundaries();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
