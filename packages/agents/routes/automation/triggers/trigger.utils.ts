export function minutesWithin(minutes: int): int {
  if (minutes < 0) {
    return 0;
  }
  if (minutes > 30) {
    return 30;
  }
  return minutes;
}

export function draftUntil(minutes: int, at: number): string {
  if (minutes == 0) {
    return "";
  }
  return `${(at as i64) + (minutes as i64) * 60000}`;
}
