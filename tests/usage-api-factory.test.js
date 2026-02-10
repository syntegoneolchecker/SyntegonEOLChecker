/**
 * Tests for usage-api-factory.js
 * Covers createUsageApiHandler, serpApiUsageHandler, groqUsageHandler
 * All fetch calls are mocked — no real API requests
 */

jest.mock('../netlify/functions/lib/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.SERPAPI_API_KEY = 'test-serpapi-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
});

afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
});

const { createUsageApiHandler, serpApiUsageHandler, groqUsageHandler } = require('../netlify/functions/lib/usage-api-factory');

describe('Usage API Factory', () => {

    describe('createUsageApiHandler', () => {
        test('should return a function', () => {
            const handler = createUsageApiHandler({
                serviceName: 'Test',
                fetchUsage: jest.fn(),
                transformResponse: jest.fn(),
                apiKeyEnvVar: 'TEST_KEY'
            });
            expect(typeof handler).toBe('function');
        });

        test('should return 503 when API key is not configured', async () => {
            const handler = createUsageApiHandler({
                serviceName: 'TestService',
                fetchUsage: jest.fn(),
                transformResponse: jest.fn(),
                apiKeyEnvVar: 'NONEXISTENT_KEY'
            });

            const result = await handler({}, {});

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.error.message).toContain('TestService');
        });

        test('should call fetchUsage with API key', async () => {
            process.env.MY_API_KEY = 'my-secret-key';
            const mockFetchUsage = jest.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: 'test' })
            });
            const mockTransform = jest.fn().mockReturnValue({ transformed: true });

            const handler = createUsageApiHandler({
                serviceName: 'Test',
                fetchUsage: mockFetchUsage,
                transformResponse: mockTransform,
                apiKeyEnvVar: 'MY_API_KEY'
            });

            const result = await handler({}, {});

            expect(mockFetchUsage).toHaveBeenCalledWith('my-secret-key');
            expect(mockTransform).toHaveBeenCalledWith({ data: 'test' });
            expect(result.statusCode).toBe(200);
            const body = JSON.parse(result.body);
            expect(body.transformed).toBe(true);
            delete process.env.MY_API_KEY;
        });

        test('should handle API error responses', async () => {
            process.env.MY_API_KEY = 'key';
            const handler = createUsageApiHandler({
                serviceName: 'TestAPI',
                fetchUsage: jest.fn().mockResolvedValue({
                    ok: false,
                    status: 429,
                    text: () => Promise.resolve('Rate limited')
                }),
                transformResponse: jest.fn(),
                apiKeyEnvVar: 'MY_API_KEY'
            });

            const result = await handler({}, {});

            expect(result.statusCode).toBe(429);
            const body = JSON.parse(result.body);
            expect(body.error).toContain('TestAPI');
            expect(body.details).toBe('Rate limited');
            delete process.env.MY_API_KEY;
        });

        test('should handle exceptions gracefully', async () => {
            process.env.MY_API_KEY = 'key';
            const handler = createUsageApiHandler({
                serviceName: 'TestAPI',
                fetchUsage: jest.fn().mockRejectedValue(new Error('Network failure')),
                transformResponse: jest.fn(),
                apiKeyEnvVar: 'MY_API_KEY'
            });

            const result = await handler({}, {});

            expect(result.statusCode).toBe(500);
            const body = JSON.parse(result.body);
            expect(body.error.message).toContain('Network failure');
            delete process.env.MY_API_KEY;
        });
    });

    describe('serpApiUsageHandler', () => {
        test('should return 503 when SERPAPI_API_KEY is not set', async () => {
            delete process.env.SERPAPI_API_KEY;

            const result = await serpApiUsageHandler({}, {});

            expect(result.statusCode).toBe(503);
        });

        test('should fetch and transform SerpAPI usage data', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    searches_per_month: 100,
                    total_searches_left: 75,
                    plan_name: 'Free'
                })
            });

            const result = await serpApiUsageHandler({}, {});

            expect(result.statusCode).toBe(200);
            const body = JSON.parse(result.body);
            expect(body.usage).toBe(25); // 100 - 75
            expect(body.limit).toBe(100);
            expect(body.remaining).toBe(75);
            expect(body.plan).toBe('Free');
        });

        test('should handle missing fields with defaults', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({})
            });

            const result = await serpApiUsageHandler({}, {});

            expect(result.statusCode).toBe(200);
            const body = JSON.parse(result.body);
            expect(body.limit).toBe(100); // default
            expect(body.remaining).toBe(0); // default
            expect(body.plan).toBe('Unknown');
        });

        test('should handle API errors', async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 401,
                text: () => Promise.resolve('Invalid API key')
            });

            const result = await serpApiUsageHandler({}, {});

            expect(result.statusCode).toBe(401);
        });
    });

    describe('groqUsageHandler', () => {
        test('should return 503 when GROQ_API_KEY is not set', async () => {
            delete process.env.GROQ_API_KEY;

            const result = await groqUsageHandler({}, {});

            expect(result.statusCode).toBe(503);
        });

        test('should extract rate limit headers from Groq response', async () => {
            const headers = new Map([
                ['x-ratelimit-remaining-tokens', '7500'],
                ['x-ratelimit-limit-tokens', '8000'],
                ['x-ratelimit-reset-tokens', '3.5s']
            ]);

            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => headers.get(h) || null },
                json: () => Promise.resolve({})
            });

            const result = await groqUsageHandler({}, {});

            expect(result.statusCode).toBe(200);
            const body = JSON.parse(result.body);
            expect(body.remainingTokens).toBe('7500');
            expect(body.limitTokens).toBe('8000');
            expect(body.resetSeconds).toBe(3.5);
        });

        test('should handle missing rate limit headers with defaults', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: () => null },
                json: () => Promise.resolve({})
            });

            const result = await groqUsageHandler({}, {});

            expect(result.statusCode).toBe(200);
            const body = JSON.parse(result.body);
            expect(body.remainingTokens).toBe('0');
            expect(body.limitTokens).toBe('8000');
            expect(body.resetSeconds).toBeNull();
        });

        test('should handle reset tokens without "s" suffix', async () => {
            const headers = new Map([
                ['x-ratelimit-remaining-tokens', '5000'],
                ['x-ratelimit-limit-tokens', '8000'],
                ['x-ratelimit-reset-tokens', '7.66']
            ]);

            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => headers.get(h) || null },
                json: () => Promise.resolve({})
            });

            const result = await groqUsageHandler({}, {});

            const body = JSON.parse(result.body);
            expect(body.resetSeconds).toBe(7.66);
        });

        test('should handle unparseable reset token format', async () => {
            const headers = new Map([
                ['x-ratelimit-remaining-tokens', '5000'],
                ['x-ratelimit-limit-tokens', '8000'],
                ['x-ratelimit-reset-tokens', 'invalid']
            ]);

            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => headers.get(h) || null },
                json: () => Promise.resolve({})
            });

            const result = await groqUsageHandler({}, {});

            const body = JSON.parse(result.body);
            expect(body.resetSeconds).toBeNull();
        });

        test('should handle Groq API errors', async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 429,
                text: () => Promise.resolve('Rate limit exceeded')
            });

            const result = await groqUsageHandler({}, {});

            expect(result.statusCode).toBe(429);
            const body = JSON.parse(result.body);
            expect(body.error).toContain('Groq');
        });

        test('should handle Groq fetch exceptions', async () => {
            global.fetch.mockRejectedValue(new Error('Connection refused'));

            const result = await groqUsageHandler({}, {});

            expect(result.statusCode).toBe(500);
        });

        test('should send correct request to Groq API', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: () => null },
                json: () => Promise.resolve({})
            });

            await groqUsageHandler({}, {});

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.groq.com/openai/v1/chat/completions',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer test-groq-key',
                        'Content-Type': 'application/json'
                    })
                })
            );
        });
    });
});
