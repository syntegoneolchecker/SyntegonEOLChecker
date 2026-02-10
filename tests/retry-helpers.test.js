/**
 * Tests for retry-helpers.js
 * Covers retryWithBackoff and simpleRetry with fake timers
 */

jest.mock('../netlify/functions/lib/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../netlify/functions/lib/config', () => ({
    CALLBACK_MAX_RETRIES: 3,
    CALLBACK_RETRY_BASE_MS: 100
}));

const { retryWithBackoff, simpleRetry } = require('../netlify/functions/lib/retry-helpers');

describe('Retry Helpers', () => {

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Helper to advance timers and flush promises
    async function flushPromisesAndTimers() {
        await Promise.resolve();
        jest.advanceTimersByTime(100000);
        await Promise.resolve();
    }

    describe('retryWithBackoff', () => {
        test('should succeed on first attempt', async () => {
            const operation = jest.fn().mockResolvedValue({ ok: true, data: 'result' });

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 3,
                timeoutMs: 5000
            });

            await flushPromisesAndTimers();
            const result = await resultPromise;

            expect(result.success).toBe(true);
            expect(result.result).toEqual({ ok: true, data: 'result' });
            expect(result.error).toBeNull();
            expect(result.timedOut).toBe(false);
            expect(operation).toHaveBeenCalledTimes(1);
        });

        test('should retry on exception and succeed', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce('success');

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 3,
                timeoutMs: 5000
            });

            // Let first attempt fail and backoff timer fire
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10000);
            }

            const result = await resultPromise;

            expect(result.success).toBe(true);
            expect(result.result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(2);
        });

        test('should return failure after all retries exhausted', async () => {
            const error = new Error('Persistent error');
            const operation = jest.fn().mockRejectedValue(error);

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 2,
                timeoutMs: 5000
            });

            for (let i = 0; i < 20; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(60000);
            }

            const result = await resultPromise;

            expect(result.success).toBe(false);
            expect(result.error).toBe(error);
            expect(result.timedOut).toBe(false);
            expect(operation).toHaveBeenCalledTimes(2);
        });

        test('should handle timeout with breakOnTimeout=true', async () => {
            // Operation that never resolves
            const operation = jest.fn().mockReturnValue(new Promise(() => {}));

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 3,
                timeoutMs: 100,
                breakOnTimeout: true
            });

            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(1000);
            }

            const result = await resultPromise;

            expect(result.success).toBe(false);
            expect(result.timedOut).toBe(true);
            expect(result.error).toBeNull();
            // Should not retry after timeout with breakOnTimeout
            expect(operation).toHaveBeenCalledTimes(1);
        });

        test('should call onError callback on failure', async () => {
            const onError = jest.fn();
            const error = new Error('fail');
            const operation = jest.fn()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce('ok');

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 3,
                timeoutMs: 5000,
                onError
            });

            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10000);
            }

            await resultPromise;

            expect(onError).toHaveBeenCalledWith(error, 1);
        });

        test('should call onSuccess callback on success', async () => {
            const onSuccess = jest.fn();
            const operation = jest.fn().mockResolvedValue('result');

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 3,
                timeoutMs: 5000,
                onSuccess
            });

            await flushPromisesAndTimers();
            await resultPromise;

            expect(onSuccess).toHaveBeenCalledWith(1);
        });

        test('should treat resolved HTTP response as success (caller checks .ok)', async () => {
            // retryWithBackoff treats any resolved promise as success
            // The caller is responsible for checking response.ok and throwing if needed
            const mockResponse = {
                ok: false,
                status: 503,
                text: jest.fn().mockResolvedValue('Service Unavailable')
            };
            const operation = jest.fn().mockResolvedValue(mockResponse);

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 2,
                timeoutMs: 5000
            });

            await flushPromisesAndTimers();
            const result = await resultPromise;

            // The response is treated as "success" at the retry level
            expect(result.success).toBe(true);
            expect(result.result).toBe(mockResponse);
        });

        test('should retry when operation throws on HTTP error', async () => {
            const logger = require('../netlify/functions/lib/logger');
            // Proper pattern: operation checks response.ok and throws
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('HTTP 503 - Service Unavailable'))
                .mockResolvedValueOnce({ ok: true, data: 'success' });

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                maxRetries: 3,
                timeoutMs: 5000
            });

            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10000);
            }

            const result = await resultPromise;

            expect(result.success).toBe(true);
            expect(operation).toHaveBeenCalledTimes(2);
            // Should have logged the error on first attempt
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('test-op failed on attempt 1'),
                expect.stringContaining('503')
            );
        });

        test('should use config defaults for maxRetries', async () => {
            const operation = jest.fn().mockResolvedValue('result');

            const resultPromise = retryWithBackoff({
                operation,
                operationName: 'test-op',
                timeoutMs: 5000
            });

            await flushPromisesAndTimers();
            const result = await resultPromise;

            expect(result.success).toBe(true);
        });
    });

    describe('simpleRetry', () => {
        test('should succeed on first attempt', async () => {
            const operation = jest.fn().mockResolvedValue('result');

            const resultPromise = simpleRetry(operation, 3, 'test-op');

            await flushPromisesAndTimers();
            const result = await resultPromise;

            expect(result).toBe('result');
            expect(operation).toHaveBeenCalledTimes(1);
        });

        test('should retry and succeed on second attempt', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValueOnce('success');

            const resultPromise = simpleRetry(operation, 3, 'test-op');

            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10000);
            }

            const result = await resultPromise;

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(2);
        });

        test('should throw last error after all retries exhausted', async () => {
            const error = new Error('persistent failure');
            const operation = jest.fn().mockRejectedValue(error);

            const resultPromise = simpleRetry(operation, 2, 'test-op');

            for (let i = 0; i < 20; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(60000);
            }

            await expect(resultPromise).rejects.toThrow('persistent failure');
            expect(operation).toHaveBeenCalledTimes(2);
        });

        test('should use exponential backoff (1s, 2s, 4s)', async () => {
            const operation = jest.fn()
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockRejectedValueOnce(new Error('fail 2'))
                .mockResolvedValueOnce('success');

            const resultPromise = simpleRetry(operation, 3, 'test-op');

            // First attempt fails immediately
            await Promise.resolve();
            expect(operation).toHaveBeenCalledTimes(1);

            // Backoff 1s (2^0 * 1000)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect(operation).toHaveBeenCalledTimes(2);

            // Backoff 2s (2^1 * 1000)
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();

            const result = await resultPromise;
            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(3);
        });
    });
});
