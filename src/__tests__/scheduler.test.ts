import { describe, expect, test } from 'bun:test';
import { shouldRun, isDailySchedule } from '../task/scheduler.js';

// Helper: create ISO timestamp offset from now by the given milliseconds
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// Helper: create ISO timestamp for a specific date/time in Asia/Shanghai (UTC+8)
function shanghaiTime(dateStr: string, hour: number, minute: number): string {
  const h = String(hour).padStart(2, '0');
  const m = String(minute).padStart(2, '0');
  return new Date(`${dateStr}T${h}:${m}:00+08:00`).toISOString();
}

function todayShanghai(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function yesterdayShanghai(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

describe('shouldRun — interval schedules', () => {
  test('every 30m: first run (lastRunAt=null) → true', () => {
    expect(shouldRun('every 30m', null)).toBe(true);
  });

  test('every 30m: ran 5 minutes ago → false', () => {
    expect(shouldRun('every 30m', ago(5 * 60_000))).toBe(false);
  });

  test('every 30m: ran 31 minutes ago → true', () => {
    expect(shouldRun('every 30m', ago(31 * 60_000))).toBe(true);
  });

  test('every 30m: ran 8 hours ago (sleep scenario) → true, only once', () => {
    // shouldRun returns true once; after markJobRun updates lastRunAt,
    // the next call with fresh lastRunAt would return false.
    expect(shouldRun('every 30m', ago(8 * 3600_000))).toBe(true);
    // Simulate markJobRun: lastRunAt = now
    expect(shouldRun('every 30m', ago(0))).toBe(false);
  });

  test('every 2h: ran 24 hours ago (long sleep) → true, only once', () => {
    expect(shouldRun('every 2h', ago(24 * 3600_000))).toBe(true);
    expect(shouldRun('every 2h', ago(0))).toBe(false);
  });

  test('every 2h: ran 1 hour ago → false', () => {
    expect(shouldRun('every 2h', ago(1 * 3600_000))).toBe(false);
  });
});

describe('shouldRun — daily schedules', () => {
  // These tests use the current wall-clock time in Asia/Shanghai.
  // We pick a target time that's definitely in the past today to test "should compensate".

  test('daily: first run (lastRunAt=null), past target time → true', () => {
    // Use 00:00 as target — always past
    expect(shouldRun('daily 00:00', null)).toBe(true);
  });

  test('daily: already ran today at target time → false', () => {
    const today = todayShanghai();
    const lastRun = shanghaiTime(today, 0, 0);
    expect(shouldRun('daily 00:00', lastRun)).toBe(false);
  });

  test('daily: ran yesterday, today past target → true (compensate)', () => {
    const yesterday = yesterdayShanghai();
    const lastRun = shanghaiTime(yesterday, 0, 0);
    expect(shouldRun('daily 00:00', lastRun)).toBe(true);
  });

  test('daily: future target time → false', () => {
    // Use 23:59 as target — almost certainly in the future
    expect(shouldRun('daily 23:59', null)).toBe(false);
  });

  test('daily: cross-day sleep (ran 2 days ago) → true, compensates once', () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const lastRun = twoDaysAgo.toISOString();
    // Target 00:00 is past → should compensate
    expect(shouldRun('daily 00:00', lastRun)).toBe(true);
    // After execution, lastRunAt = now → should not run again
    expect(shouldRun('daily 00:00', new Date().toISOString())).toBe(false);
  });
});

describe('shouldRun — unknown format', () => {
  test('returns false for unrecognized schedule', () => {
    expect(shouldRun('weekly monday', null)).toBe(false);
    expect(shouldRun('garbage', null)).toBe(false);
  });
});

describe('isDailySchedule', () => {
  test('recognizes daily schedules', () => {
    expect(isDailySchedule('daily 03:00')).toBe(true);
    expect(isDailySchedule('daily 23:59')).toBe(true);
  });

  test('rejects non-daily schedules', () => {
    expect(isDailySchedule('every 30m')).toBe(false);
    expect(isDailySchedule('every 2h')).toBe(false);
    expect(isDailySchedule('daily')).toBe(false);
    expect(isDailySchedule('garbage')).toBe(false);
  });
});
