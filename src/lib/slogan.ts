const SLOGAN_LIST_URL = '/slogan.csv';

function parseSloganCsv(csvText: string): string[] {
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

export async function loadSlogans(): Promise<string[]> {
  const res = await fetch(SLOGAN_LIST_URL);
  if (!res.ok) {
    throw new Error('Failed to load slogans');
  }
  return parseSloganCsv(await res.text());
}

export function pickRandomSlogan(slogans: string[]): string {
  if (slogans.length === 0) {
    return '上古祭仪，卡牌对决';
  }
  return slogans[Math.floor(Math.random() * slogans.length)];
}

export async function resolveRandomSlogan(): Promise<string> {
  const slogans = await loadSlogans();
  return pickRandomSlogan(slogans);
}
