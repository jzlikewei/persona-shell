import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { setLogLevel, getLogLevel, log } from './logger.js';

describe('logger', () => {
  // Save originals
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  let logCalls: unknown[][];
  let warnCalls: unknown[][];
  let errorCalls: unknown[][];

  beforeEach(() => {
    logCalls = [];
    warnCalls = [];
    errorCalls = [];
    console.log = (...args: unknown[]) => { logCalls.push(args); };
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    // Reset to default level
    setLogLevel('info');
    // Clear the setLogLevel's own console.log call
    logCalls = [];
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    // Restore default
    setLogLevel('info');
  });

  describe('setLogLevel / getLogLevel', () => {
    test('sets valid level and returns it', () => {
      setLogLevel('debug');
      expect(getLogLevel()).toBe('debug');
    });

    test('ignores invalid level', () => {
      setLogLevel('info');
      logCalls = [];
      setLogLevel('nonsense');
      expect(getLogLevel()).toBe('info');
      // no console.log call for invalid level
      expect(logCalls).toHaveLength(0);
    });

    test('accepts all valid levels', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        setLogLevel(level);
        expect(getLogLevel()).toBe(level);
      }
    });
  });

  describe('log filtering', () => {
    test('level=error: only error outputs', () => {
      setLogLevel('error');
      logCalls = [];

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(logCalls).toHaveLength(0);    // debug+info go to console.log
      expect(warnCalls).toHaveLength(0);   // warn goes to console.warn
      expect(errorCalls).toHaveLength(1);  // error always prints
      expect(errorCalls[0]).toEqual(['e']);
    });

    test('level=warn: warn and error output', () => {
      setLogLevel('warn');
      logCalls = [];

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      expect(logCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toEqual(['w']);
      expect(errorCalls).toHaveLength(1);
    });

    test('level=info: info, warn, error output', () => {
      setLogLevel('info');
      logCalls = [];

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      // debug filtered, info goes through console.log
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toEqual(['i']);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    test('level=debug: all outputs', () => {
      setLogLevel('debug');
      logCalls = [];

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');

      // debug + info both go through console.log
      expect(logCalls).toHaveLength(2);
      expect(logCalls[0]).toEqual(['d']);
      expect(logCalls[1]).toEqual(['i']);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    test('error always outputs regardless of level', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        errorCalls = [];
        setLogLevel(level);
        log.error('always');
        expect(errorCalls).toHaveLength(1);
      }
    });

    test('log functions accept multiple arguments', () => {
      setLogLevel('debug');
      logCalls = [];

      log.debug('a', 'b', 123);
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]).toEqual(['a', 'b', 123]);
    });
  });
});
