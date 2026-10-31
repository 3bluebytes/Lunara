// libraryTrackCache.js — remembers exact playlist tracks seen by music tools.
import { collectionOrigin, findCollectionMatch } from './library/collectionSourceAffinity.js';

const remembered = new Map();
const identities = new Map();

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s()（）\[\]【】《》"'·\-–—,，.。/\\:;]/g, '');
}

function keysForTrack(track) {
  const title = norm(track.title);
  const artist = norm(track.artist);
  const keys = new Set();
  if (title) keys.add(title);
  if (title && artist) {
    keys.add(`${artist}|${title}`);
    keys.add(`${title}|${artist}`);
    keys.add(`${artist}${title}`);
    keys.add(`${title}${artist}`);
  }
  return keys;
}

function keysForQuery(query) {
  const text = String(query || '');
  const parts = text.split(/\s*[-—–]\s*/).map(norm).filter(Boolean);
  const keys = new Set([norm(text)]);
  if (parts.length >= 2) {
    keys.add(`${parts[0]}|${parts[1]}`);
    keys.add(`${parts[1]}|${parts[0]}`);
    keys.add(`${parts[0]}${parts[1]}`);
    keys.add(`${parts[1]}${parts[0]}`);
  }
  return keys;
}

export function rememberTracks(tracks = [], provider = '') {
  for (const track of tracks) {
    if (!track?.title || !track?.song_id) continue;
    const id = `${provider}:${track.song_id}`;
    const origin = collectionOrigin(track) || collectionOrigin(identities.get(id));
    const collectionKind = track.collectionKind || identities.get(id)?.collectionKind;
    const rec = { ...track, provider, ...(origin ? { collectionOrigin: origin } : {}),
      ...(collectionKind ? { collectionKind } : {}) };
    removeIdentity(id);
    identities.set(id, rec);
    for (const key of keysForTrack(rec)) {
      if (!remembered.has(key)) remembered.set(key, new Set());
      remembered.get(key).add(id);
      if (remembered.size > 10000) remembered.delete(remembered.keys().next().value);
    }
    if (identities.size > 2000) removeIdentity(identities.keys().next().value);
  }
}

export function findRememberedIdentity(source, songId) {
  return identities.get(`${source}:${songId}`) || null;
}

function removeIdentity(id) {
  identities.delete(id);
  for (const [key, refs] of remembered) {
    refs.delete(id);
    if (!refs.size) remembered.delete(key);
  }
}

export function getRememberedCollectionTracks() {
  return [...identities.values()].filter(track => collectionOrigin(track));
}

export function findRememberedTrack(query) {
  const collection = findCollectionMatch(query, getRememberedCollectionTracks());
  if (collection.status !== 'none') return collection.track;
  for (const key of keysForQuery(query)) {
    const hits = [...(remembered.get(key) || [])].map(id => identities.get(id)).filter(Boolean);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

export function clearRememberedTracks() {
  remembered.clear();
  identities.clear();
}
