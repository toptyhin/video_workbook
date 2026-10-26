export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatTimecodeWithMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const millis = total % 1000;
  return `${formatTimecode(total)}.${String(millis).padStart(3, '0')}`;
}

const TIMECODE_RE = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/;

export function parseTimecode(input: string): number | null {
  const match = TIMECODE_RE.exec(input);
  if (!match) return null;
  const [, hoursRaw, minutesRaw, secondsRaw, millisRaw] = match;
  const hours = hoursRaw ? Number(hoursRaw) : 0;
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);
  if (minutes > 59 || seconds > 59) return null;
  const millis = millisRaw ? Number(millisRaw.padEnd(3, '0')) : 0;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
