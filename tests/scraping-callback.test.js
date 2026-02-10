/**
 * Tests for scraping-service/utils/callback.js
 * All fetch calls mocked — no real HTTP requests
 */

jest.mock('../scraping-service/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../scraping-service/utils/validation', () => ({
    isValidCallbackUrl: jest.fn((url) => {
        if (url.includes('invalid') || url.includes('localhost')) {
            return { valid: false, reason: 'Blocked by SSRF protection' };
        }
        return { valid: true };
    })
}));

jest.mock('../scraping-service/utils/memory', () => ({
    getShutdownState: jest.fn(() => false)
}));

const originalFetch = global.fetch;

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.SCRAPING_API_KEY = 'test-api-key';
});

afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SCRAPING_API_KEY;
});

const { sendCallback } = require('../scraping-service/utils/callback');
const { getShutdownState } = require('../scraping-service/utils/memory');
const logger = require('../scraping-service/utils/logger');

describe('Scraping Callback', () => {

    describe('sendCallback', () => {
        test('should return immediately for null/empty callbackUrl', async () => {
            await sendCallback(null, { data: 'test' });
            await sendCallback('', { data: 'test' });

            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('should send callback with correct payload and auth header', async () => {
            global.fetch.mockResolvedValue({ ok: true, status: 200 });

            const payload = { jobId: 'job-123', content: 'scraped data' };
            await sendCallback('https://app.netlify.app/.netlify/functions/callback', payload);

            expect(global.fetch).toHaveBeenCalledWith(
                'https://app.netlify.app/.netlify/functions/callback',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        'X-API-Key': 'test-api-key'
                    }),
                    body: JSON.stringify(payload)
                })
            );
        });

        test('should send callback without API key header when not configured', async () => {
            delete process.env.SCRAPING_API_KEY;
            global.fetch.mockResolvedValue({ ok: true, status: 200 });

            await sendCallback('https://app.netlify.app/callback', { data: 'test' });

            const callHeaders = global.fetch.mock.calls[0][1].headers;
            expect(callHeaders['X-API-Key']).toBeUndefined();
            expect(callHeaders['Content-Type']).toBe('application/json');
        });

        test('should succeed on first attempt', async () => {
            global.fetch.mockResolvedValue({ ok: true, status: 200 });

            await sendCallback('https://app.netlify.app/callback', { data: 'test' });

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('Callback successful')
            );
        });

        test('should retry on HTTP error and succeed on second attempt', async () => {
            global.fetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 502,
                    text: () => Promise.resolve('Bad Gateway')
                })
                .mockResolvedValueOnce({ ok: true, status: 200 });

            await sendCallback('https://app.netlify.app/callback', { data: 'test' }, 3);

            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        test('should retry on network error and succeed', async () => {
            global.fetch
                .mockRejectedValueOnce(new Error('ECONNREFUSED'))
                .mockResolvedValueOnce({ ok: true, status: 200 });

            await sendCallback('https://app.netlify.app/callback', { data: 'test' }, 3);

            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        test('should throw after all retries exhausted', async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 503,
                text: () => Promise.resolve('Service Unavailable')
            });

            await expect(
                sendCallback('https://app.netlify.app/callback', { data: 'test' }, 2)
            ).rejects.toThrow();

            // 2 attempts total (not 2 retries + 1 initial)
            expect(global.fetch).toHaveBeenCalledTimes(2);
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining('All 2 callback attempts failed')
            );
        });

        test('should block SSRF (unsafe callback URL)', async () => {
            await expect(
                sendCallback('http://localhost:3000/admin', { data: 'test' })
            ).rejects.toThrow('Invalid callback URL');

            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('should block invalid callback URLs', async () => {
            await expect(
                sendCallback('https://invalid-host.com/callback', { data: 'test' })
            ).rejects.toThrow('Invalid callback URL');

            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('should use exponential backoff on retries', async () => {
            global.fetch
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockRejectedValueOnce(new Error('fail 2'))
                .mockResolvedValueOnce({ ok: true, status: 200 });

            // Real backoff: ~2s (attempt 1) + ~4s (attempt 2) = ~6s total
            await sendCallback('https://app.netlify.app/callback', { data: 'test' }, 3);

            expect(global.fetch).toHaveBeenCalledTimes(3);
        }, 15000);

        test('should add extra backoff during shutdown', async () => {
            getShutdownState.mockReturnValue(true);

            global.fetch
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValueOnce({ ok: true, status: 200 });

            // Real backoff with shutdown: ~2s + 3s = ~5s
            await sendCallback('https://app.netlify.app/callback', { data: 'test' }, 3);

            // Should mention restart pending in logs
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('restart pending')
            );
        }, 15000);

        test('should handle response.text() failure gracefully', async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 500,
                text: () => Promise.reject(new Error('Cannot read body'))
            });

            await expect(
                sendCallback('https://app.netlify.app/callback', { data: 'test' }, 1)
            ).rejects.toThrow();
        });
    });
});
