const initializedDbs = new WeakSet();

function ensureFamiliarArtistCadenceTable(db) {
  if (initializedDbs.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS familiar_artist_cadence (
    person_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    source_quote TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  initializedDbs.add(db);
}

export function getFamiliarArtistCadence(db, personId) {
  ensureFamiliarArtistCadenceTable(db);
  return db.prepare('SELECT mode, source_turn_id AS sourceTurnId, source_quote AS sourceQuote FROM familiar_artist_cadence WHERE person_id = ?')
    .get(String(personId || '')) || null;
}

export function saveFamiliarArtistFeedback(db, { personId, sourceTurnId, userText, mode, now = Date.now() }) {
  if (!['familiar_first', 'clear'].includes(mode) || !personId || !sourceTurnId || !String(userText || '').trim()) return null;
  ensureFamiliarArtistCadenceTable(db);
  const existing = getFamiliarArtistCadence(db, personId);
  if (existing?.sourceTurnId === sourceTurnId) {
    if (existing.mode !== mode) return null;
    return { mode, replayed: true, displayText: mode === 'clear'
      ? '已取消熟悉歌手优先的安排。' : '我会以你熟悉的歌手为主，偶尔穿插陌生歌手。' };
  }
  db.prepare(`INSERT INTO familiar_artist_cadence (person_id, mode, source_turn_id, source_quote, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(person_id) DO UPDATE SET mode=excluded.mode, source_turn_id=excluded.source_turn_id,
      source_quote=excluded.source_quote, updated_at=excluded.updated_at`)
    .run(personId, mode, sourceTurnId, String(userText).trim(), now);
  return { mode, displayText: mode === 'clear'
    ? '已取消熟悉歌手优先的安排。' : '我会以你熟悉的歌手为主，偶尔穿插陌生歌手。' };
}

function normalizedArtist(artist) {
  return String(artist || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export function chooseFamiliarArtistClasses({ pool, recentPlays, likedArtists, count }) {
  const liked = new Set((likedArtists || []).map(normalizedArtist).filter(Boolean));
  for (const track of pool) {
    if (/(?:^|:)liked(?:$|:)/u.test(String(track.candidateOrigin || ''))) liked.add(normalizedArtist(track.artist));
  }
  const recent = Array.isArray(recentPlays) ? recentPlays : [];
  const playsByArtist = new Map();
  for (const row of recent) {
    const artist = normalizedArtist(row.artist);
    if (artist) playsByArtist.set(artist, (playsByArtist.get(artist) || 0) + 1);
  }
  const familiar = artist => liked.has(normalizedArtist(artist)) || (playsByArtist.get(normalizedArtist(artist)) || 0) >= 2;
  const hasFamiliar = pool.some(track => familiar(track.artist));
  const hasUnfamiliar = pool.some(track => !familiar(track.artist));
  if (!hasFamiliar || !hasUnfamiliar) return null;
  let familiarStreak = 0;
  for (const row of recent) {
    if (!familiar(row.artist)) break;
    familiarStreak++;
    if (familiarStreak >= 3) break;
  }
  const startingStreak = familiarStreak;
  const classes = [];
  for (let index = 0; index < count; index++) {
    const useUnfamiliar = familiarStreak >= 3;
    classes.push(useUnfamiliar ? 'unfamiliar' : 'familiar');
    familiarStreak = useUnfamiliar ? 0 : familiarStreak + 1;
  }
  return { familiar, classes, startingStreak };
}

export function orderFamiliarArtistPool(pool, plan) {
  if (!plan) return pool;
  const familiar = pool.filter(track => plan.familiar(track.artist));
  const unfamiliar = pool.filter(track => !plan.familiar(track.artist));
  const ordered = [];
  let streak = plan.startingStreak;
  while (familiar.length || unfamiliar.length) {
    const noveltyTurn = streak >= 3;
    const track = (noveltyTurn ? unfamiliar : familiar).shift()
      || (noveltyTurn ? familiar : unfamiliar).shift();
    ordered.push(track);
    streak = plan.familiar(track.artist) ? Math.min(3, streak + 1) : 0;
  }
  return ordered;
}
