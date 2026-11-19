import type { Session } from "./api";

const STORAGE_KEY = "nibble.session";

const restore = (): Session | null => {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored === null) return null;
  try {
    const saved = JSON.parse(stored) as Session;
    const expiresAt = Date.parse(saved.expiresAt);
    return expiresAt > Date.now() ? saved : null;
  } catch {
    return null;
  }
};

const restored = restore();
let current = $state<Session | null>(restored);

export const session = {
  get current() {
    return current;
  },
  start(next: Session) {
    current = next;
    const serialized = JSON.stringify(next);
    sessionStorage.setItem(STORAGE_KEY, serialized);
  },
  end() {
    current = null;
    sessionStorage.removeItem(STORAGE_KEY);
  },
};
