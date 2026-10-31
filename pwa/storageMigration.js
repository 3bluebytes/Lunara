// Browser storage key migration for the Lunara rename.
export function migrateStorageKey(storage, legacyKey, currentKey) {
  if (!storage || !legacyKey || !currentKey) return false;
  try {
    const current = storage.getItem(currentKey);
    const legacy = storage.getItem(legacyKey);
    if (current == null && legacy != null) storage.setItem(currentKey, legacy);
    if (legacy != null) storage.removeItem(legacyKey);
    return current == null && legacy != null;
  } catch {
    return false;
  }
}
