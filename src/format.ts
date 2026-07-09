// Shared user-facing formatting helpers.

// "1 file", "2 files", "1 branch", "3 branches" — replaces the lazy
// "N file(s)" style throughout the UI and reports.
export function pluralize(count: number, word: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? word : (pluralForm ?? `${word}s`)}`;
}

// Timestamps are stored as ISO/UTC strings; slicing them printed UTC times
// that look wrong next to the user's wall clock. Render in local time.
export function formatLocalTime(iso: string, options?: { seconds?: boolean; date?: boolean }): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}${options?.seconds ? `:${pad(parsed.getSeconds())}` : ""}`;
  if (options?.date) {
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${time}`;
  }
  return time;
}

// "7m 26s" instead of raw milliseconds.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
