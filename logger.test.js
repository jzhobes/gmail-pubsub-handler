import { jest } from '@jest/globals';
import { Logger } from './logger.js';

describe('Logger', () => {
  let logSpy, warnSpy, errorSpy;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('Environment Detection', () => {
    it('detects deployed environment via K_SERVICE', () => {
      process.env.K_SERVICE = 'test-service';
      const logger = new Logger();
      expect(logger.isDeployed).toBe(true);
    });

    it('detects deployed environment via FUNCTION_TARGET', () => {
      process.env.FUNCTION_TARGET = 'test-func';
      const logger = new Logger();
      expect(logger.isDeployed).toBe(true);
    });

    it('detects local environment when no GCP vars are present', () => {
      delete process.env.K_SERVICE;
      delete process.env.FUNCTION_TARGET;
      delete process.env.FUNCTION_NAME;
      const logger = new Logger();
      expect(logger.isDeployed).toBe(false);
    });
  });

  describe('Deployed Behavior (Structured Logging)', () => {
    let logger;

    beforeEach(() => {
      process.env.K_SERVICE = 'test-service';
      logger = new Logger();
    });

    it('info() logs JSON with severity INFO', () => {
      logger.info('Hello World');
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ severity: 'INFO', message: 'Hello World' }));
    });

    it('error() logs JSON with severity ERROR', () => {
      logger.error('Breaking news');
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ severity: 'ERROR', message: 'Breaking news' }));
    });

    it('warn() logs JSON with severity WARNING', () => {
      logger.warn('Careful now');
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ severity: 'WARNING', message: 'Careful now' }));
    });

    it('log() defaults to severity DEFAULT', () => {
      logger.log('Just a log');
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ severity: 'DEFAULT', message: 'Just a log' }));
    });

    it('handles object payloads by stringifying them', () => {
      const payload = { user: 123, action: 'login' };
      logger.info(payload);
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ severity: 'INFO', message: JSON.stringify(payload) }));
    });
  });

  describe('Local Behavior (Simple Logging)', () => {
    let logger;

    beforeEach(() => {
      delete process.env.K_SERVICE;
      delete process.env.FUNCTION_TARGET;
      delete process.env.FUNCTION_NAME;
      logger = new Logger();
    });

    it('info() calls console.log directly', () => {
      logger.info('Local info');
      expect(logSpy).toHaveBeenCalledWith('Local info');
    });

    it('warn() calls console.warn directly', () => {
      logger.warn('Local warn');
      expect(warnSpy).toHaveBeenCalledWith('Local warn');
    });

    it('error() calls console.error directly', () => {
      logger.error('Local error');
      expect(errorSpy).toHaveBeenCalledWith('Local error');
    });

    it('debug() calls console.log directly', () => {
      logger.debug('Local debug');
      expect(logSpy).toHaveBeenCalledWith('Local debug');
    });
  });
});
