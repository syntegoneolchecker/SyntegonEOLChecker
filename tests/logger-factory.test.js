/**
 * Tests for shared/logger-factory.js
 * Covers sanitization functions, formatMessage, extractContext, and createLogger
 */

// Save original env
const originalEnv = { ...process.env };

// We need to access the internal functions directly
// The module exports createLogger and LOG_LEVELS, but the sanitization
// functions are used internally. We'll test them through the logger behavior
// and also import the module to test exports.

let loggerFactory;

beforeEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    // Clear Supabase config to prevent real API calls
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_API_KEY;
    loggerFactory = require('../shared/logger-factory');
});

afterEach(() => {
    process.env = { ...originalEnv };
});

describe('Logger Factory', () => {

    describe('LOG_LEVELS', () => {
        test('should export LOG_LEVELS with correct hierarchy', () => {
            expect(loggerFactory.LOG_LEVELS.DEBUG).toBe(0);
            expect(loggerFactory.LOG_LEVELS.INFO).toBe(1);
            expect(loggerFactory.LOG_LEVELS.WARN).toBe(2);
            expect(loggerFactory.LOG_LEVELS.ERROR).toBe(3);
            expect(loggerFactory.LOG_LEVELS.NONE).toBe(4);
        });

        test('should have DEBUG < INFO < WARN < ERROR < NONE', () => {
            const { LOG_LEVELS } = loggerFactory;
            expect(LOG_LEVELS.DEBUG).toBeLessThan(LOG_LEVELS.INFO);
            expect(LOG_LEVELS.INFO).toBeLessThan(LOG_LEVELS.WARN);
            expect(LOG_LEVELS.WARN).toBeLessThan(LOG_LEVELS.ERROR);
            expect(LOG_LEVELS.ERROR).toBeLessThan(LOG_LEVELS.NONE);
        });
    });

    describe('createLogger', () => {
        test('should create logger with all methods', () => {
            const logger = loggerFactory.createLogger(() => 'test-source');
            expect(typeof logger.debug).toBe('function');
            expect(typeof logger.info).toBe('function');
            expect(typeof logger.warn).toBe('function');
            expect(typeof logger.error).toBe('function');
            expect(typeof logger.getLevel).toBe('function');
        });

        test('should default to INFO level', () => {
            const logger = loggerFactory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('INFO');
        });

        test('should respect LOG_LEVEL env var', () => {
            process.env.LOG_LEVEL = 'DEBUG';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logger = factory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('DEBUG');
        });

        test('should respect LOG_LEVEL=WARN', () => {
            process.env.LOG_LEVEL = 'WARN';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logger = factory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('WARN');
        });

        test('should respect LOG_LEVEL=ERROR', () => {
            process.env.LOG_LEVEL = 'ERROR';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logger = factory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('ERROR');
        });

        test('should respect LOG_LEVEL=NONE', () => {
            process.env.LOG_LEVEL = 'NONE';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logger = factory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('NONE');
        });

        test('should be case-insensitive for LOG_LEVEL', () => {
            process.env.LOG_LEVEL = 'debug';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logger = factory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('DEBUG');
        });

        test('should default to INFO for invalid LOG_LEVEL', () => {
            process.env.LOG_LEVEL = 'INVALID';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logger = factory.createLogger(() => 'test');
            expect(logger.getLevel()).toBe('INFO');
        });
    });

    describe('log level filtering', () => {
        test('should not log DEBUG messages at INFO level', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.debug('debug message');

            expect(consoleSpy).not.toHaveBeenCalled();
        });

        test('should log INFO messages at INFO level', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('info message');

            expect(consoleSpy).toHaveBeenCalledWith('[INFO]', 'info message');
        });

        test('should log WARN messages at INFO level', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.warn('warn message');

            expect(consoleSpy).toHaveBeenCalledWith('[WARN]', 'warn message');
        });

        test('should log ERROR messages at INFO level', () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.error('error message');

            expect(consoleSpy).toHaveBeenCalledWith('[ERROR]', 'error message');
        });

        test('should log DEBUG messages at DEBUG level', () => {
            process.env.LOG_LEVEL = 'DEBUG';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = factory.createLogger(() => 'test');

            logger.debug('debug message');

            expect(consoleSpy).toHaveBeenCalledWith('[DEBUG]', 'debug message');
        });

        test('should not log anything at NONE level', () => {
            process.env.LOG_LEVEL = 'NONE';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const logger = factory.createLogger(() => 'test');

            logger.debug('d');
            logger.info('i');
            logger.warn('w');
            logger.error('e');

            expect(logSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
        });

        test('should not log INFO/DEBUG at WARN level', () => {
            process.env.LOG_LEVEL = 'WARN';
            jest.resetModules();
            const factory = require('../shared/logger-factory');
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const logger = factory.createLogger(() => 'test');

            logger.debug('d');
            logger.info('i');
            logger.warn('w');

            expect(logSpy).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('sanitization through logger (security-critical)', () => {
        test('should sanitize newline injection in log messages', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('normal message\nINJECTED LOG LINE');

            expect(consoleSpy).toHaveBeenCalledWith(
                '[INFO]',
                expect.not.stringContaining('\n')
            );
            // Newlines should be escaped, not removed
            expect(consoleSpy).toHaveBeenCalledWith(
                '[INFO]',
                expect.stringContaining('\\n')
            );
        });

        test('should sanitize carriage return injection', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('message\r\nINJECTED');

            const loggedMsg = consoleSpy.mock.calls[0][1];
            expect(loggedMsg).not.toContain('\r');
            expect(loggedMsg).not.toContain('\n');
        });

        test('should sanitize ANSI escape codes', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('normal \x1b[31mRED TEXT\x1b[0m normal');

            const loggedMsg = consoleSpy.mock.calls[0][1];
            expect(loggedMsg).not.toContain('\x1b');
            expect(loggedMsg).toContain('RED TEXT');
        });

        test('should sanitize null bytes (control characters)', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('hello\x00world\x01test');

            const loggedMsg = consoleSpy.mock.calls[0][1];
            expect(loggedMsg).not.toContain('\x00');
            expect(loggedMsg).not.toContain('\x01');
        });

        test('should preserve tab characters', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('col1\tcol2\tcol3');

            const loggedMsg = consoleSpy.mock.calls[0][1];
            expect(loggedMsg).toContain('\t');
        });

        test('should sanitize objects deeply', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('context:', { key: 'value\nINJECTED', nested: { deep: 'data\x1b[31m' } });

            // The object should be sanitized
            const loggedObj = consoleSpy.mock.calls[0][2];
            expect(loggedObj.key).not.toContain('\n');
            expect(loggedObj.nested.deep).not.toContain('\x1b');
        });

        test('should sanitize Error objects', () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            const error = new Error('error\nINJECTED LINE');
            logger.error('caught:', error);

            const loggedError = consoleSpy.mock.calls[0][2];
            expect(loggedError.message).not.toContain('\n');
            expect(loggedError.message).toContain('\\n');
        });

        test('should handle arrays in log arguments', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('list:', ['item1\nINJECTED', 'item2']);

            const loggedArr = consoleSpy.mock.calls[0][2];
            expect(loggedArr[0]).not.toContain('\n');
        });

        test('should handle circular references', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            const obj = { a: 1 };
            obj.self = obj;

            // Should not throw
            expect(() => logger.info('circular:', obj)).not.toThrow();
        });

        test('should pass through non-string primitives', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('numbers:', 42, true, null);

            expect(consoleSpy).toHaveBeenCalledWith('[INFO]', 'numbers:', 42, true, null);
        });

        test('should handle function values', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            function myFunc() {}
            logger.info('func:', myFunc);

            const loggedFunc = consoleSpy.mock.calls[0][2];
            expect(loggedFunc).toContain('[Function: myFunc]');
        });
    });

    describe('skipSources', () => {
        test('should skip logging for specified sources', () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'view-logs', ['view-logs']);

            // Even though INFO level should log, the source is skipped for central logging
            // Console output should still happen
            logger.info('test message');
            expect(consoleSpy).toHaveBeenCalled();
        });
    });

    describe('central logging (Supabase)', () => {
        test('should not send to Supabase when not configured', () => {
            const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve());
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = loggerFactory.createLogger(() => 'test');

            logger.info('test');

            // fetch should not be called since SUPABASE_URL is not set
            expect(fetchSpy).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        });

        test('should send to Supabase when configured', () => {
            process.env.SUPABASE_URL = 'https://test.supabase.co';
            process.env.SUPABASE_API_KEY = 'test-key';
            jest.resetModules();
            const factory = require('../shared/logger-factory');

            const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => Promise.resolve());
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const logger = factory.createLogger(() => 'test-source');

            logger.info('test message');

            expect(fetchSpy).toHaveBeenCalledWith(
                'https://test.supabase.co/rest/v1/logs',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'apikey': 'test-key',
                        'Content-Type': 'application/json'
                    })
                })
            );

            fetchSpy.mockRestore();
        });
    });
});
