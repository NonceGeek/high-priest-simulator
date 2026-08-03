const NICKNAME_KEY = 'nickname';
const MAX_NICKNAME_LENGTH = 16;
const NAME_LIST_URL = '/priest-names.csv';

export function hasStoredNickname(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const saved = localStorage.getItem(NICKNAME_KEY);
  return saved !== null && saved.trim().length > 0;
}

export function getStoredNickname(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const saved = localStorage.getItem(NICKNAME_KEY)?.trim();
  return saved || null;
}

export function setStoredNickname(nickname: string): string {
  const cleaned = nickname.trim().slice(0, MAX_NICKNAME_LENGTH);
  if (!cleaned) {
    throw new Error('Nickname cannot be empty');
  }
  localStorage.setItem(NICKNAME_KEY, cleaned);
  return cleaned;
}

export function parsePriestNameCsv(csvText: string): string[] {
  return csvText
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const comma = line.indexOf(',');
      return comma >= 0 ? line.slice(comma + 1).trim() : line;
    })
    .filter(Boolean);
}

export async function loadPriestNames(): Promise<string[]> {
  const res = await fetch(NAME_LIST_URL);
  if (!res.ok) {
    throw new Error('Failed to load priest names');
  }
  return parsePriestNameCsv(await res.text());
}

export function pickRandomName(names: string[]): string {
  if (names.length === 0) {
    return '祭司';
  }
  return names[Math.floor(Math.random() * names.length)];
}

/** Stored nickname if set; otherwise a random CSV name (not persisted yet). */
export async function resolveInitialNickname(): Promise<{
  nickname: string;
  isStored: boolean;
}> {
  const existing = getStoredNickname();
  if (existing) {
    return { nickname: existing, isStored: true };
  }

  const names = await loadPriestNames();
  return { nickname: pickRandomName(names), isStored: false };
}

export { NICKNAME_KEY, MAX_NICKNAME_LENGTH, NAME_LIST_URL };
