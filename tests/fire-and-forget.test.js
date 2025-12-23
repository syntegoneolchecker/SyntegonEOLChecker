/**
 * Tests for fire-and-forget helper functions
 */

// Mock config before requiring fire-and-forget
jest.mock('../netlify/functions/lib/config', () => ({
    FIRE_AND_FORGET_MAX_RETRIES: 2,
    FIRE_AND_FORGET_RETRY_DELAY_MS: 10, // Use short delay for tests
    FIRE_AND_FORGET_TIMEOUT_MS: 5000
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Fire and Forget', () => {
    let fireAndForget;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
        fireAndForget = require('../netlify/functions/lib/fire-and-forget');
        // Mock console to reduce test noise
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('fireAndForgetFetch', () => {
        test('should succeed on first attempt', async () => {
            fetch.mockResolvedValueOnce({ ok: true });

            await fireAndForget.fireAndForgetFetch(
                'http://test.com',
                { method: 'POST' },
                { operationName: 'test-operation' }
            );

            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledWith(
                'http://test.com',
                expect.objectContaining({
                    method: 'POST'
                })
            );
        });

        test('should retry on failure and eventually succeed', async () => {
            const mockResponse = { ok: false, status: 500, text: jest.fn().mockResolvedValue('Server error') };

            fetch
                .mockResolvedValueOnce(mockResponse)
                .mockResolvedValueOnce(mockResponse)
                .mockResolvedValueOnce({ ok: true });

            await fireAndForget.fireAndForgetFetch(
                'http://test.com',
                {},
                { maxRetries: 2, retryDelayMs: 10, operationName: 'test-retry' }
            );

            expect(fetch).toHaveBeenCalledTimes(3);
        });

        test('should give up after max retries', async () => {
            const mockResponse = { ok: false, status: 500, text: jest.fn().mockResolvedValue('Server error') };

            fetch
                .mockResolvedValueOnce(mockResponse)
                .mockResolvedValueOnce(mockResponse)
                .mockResolvedValueOnce(mockResponse);

            await fireAndForget.fireAndForgetFetch(
                'http://test.com',
                {},
                { maxRetries: 2, retryDelayMs: 10, operationName: 'test-fail' }
            );

            expect(fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('test-fail failed after 3 attempts'),
                expect.any(String)
            );
        });

        test('should handle network errors with retry', async () => {
            fetch
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce({ ok: true });

            await fireAndForget.fireAndForgetFetch(
                'http://test.com',
                {},
                { maxRetries: 2, retryDelayMs: 10, operationName: 'network-test' }
            );

            expect(fetch).toHaveBeenCalledTimes(2);
        });
    });

    describe('triggerFetchUrl', () => {
        test('should call fireAndForgetFetch with correct parameters', async () => {
            fetch.mockResolvedValueOnce({ ok: true });

            const payload = {
                jobId: 'test-job-123',
                urlIndex: 0,
                url: 'http://example.com'
            };

            await fireAndForget.triggerFetchUrl('http://base.com', payload);

            expect(fetch).toHaveBeenCalledWith(
                'http://base.com/.netlify/functions/fetch-url',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
            );
        });
    });

    describe('triggerAnalyzeJob', () => {
        test('should call fireAndForgetFetch with correct parameters', async () => {
            fetch.mockResolvedValueOnce({ ok: true });

            await fireAndForget.triggerAnalyzeJob('http://base.com', 'test-job-456');

            expect(fetch).toHaveBeenCalledWith(
                'http://base.com/.netlify/functions/analyze-job',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId: 'test-job-456' })
                })
            );
        });
    });
});
