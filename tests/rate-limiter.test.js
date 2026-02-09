// Mock @netlify/blobs
const mockStore = {
    get: jest.fn(),
    setJSON: jest.fn()
};
jest.mock('@netlify/blobs', () => ({
    getStore: jest.fn(() => mockStore)
}));

const {
    checkRateLimit,
    recordAttempt,
    clearRateLimit,
    cleanupExpiredRecords,
    getClientIP
} = require('../netlify/functions/lib/rate-limiter');

describe('Rate Limiter', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.SITE_ID = 'test-site';
        process.env.NETLIFY_BLOBS_TOKEN = 'test-token';
        jest.clearAllMocks();
        mockStore.get.mockResolvedValue(null);
        mockStore.setJSON.mockResolvedValue(undefined);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('getClientIP', () => {
        it('should extract IP from x-forwarded-for header', () => {
            const event = { headers: { 'x-forwarded-for': '1.2.3.4' } };
            expect(getClientIP(event)).toBe('1.2.3.4');
        });

        it('should take first IP from comma-separated x-forwarded-for', () => {
            const event = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' } };
            expect(getClientIP(event)).toBe('1.2.3.4');
        });

        it('should fall back to x-real-ip', () => {
            const event = { headers: { 'x-real-ip': '5.6.7.8' } };
            expect(getClientIP(event)).toBe('5.6.7.8');
        });

        it('should fall back to client-ip', () => {
            const event = { headers: { 'client-ip': '9.10.11.12' } };
            expect(getClientIP(event)).toBe('9.10.11.12');
        });

        it('should return unknown when no IP headers present', () => {
            const event = { headers: {} };
            expect(getClientIP(event)).toBe('unknown');
        });

        it('should prefer x-forwarded-for over other headers', () => {
            const event = {
                headers: {
                    'x-forwarded-for': '1.1.1.1',
                    'x-real-ip': '2.2.2.2',
                    'client-ip': '3.3.3.3'
                }
            };
            expect(getClientIP(event)).toBe('1.1.1.1');
        });
    });

    describe('checkRateLimit', () => {
        it('should throw for unknown endpoint', async () => {
            await expect(checkRateLimit('unknown-endpoint', '1.2.3.4'))
                .rejects.toThrow('Unknown rate limit endpoint');
        });

        it('should allow when no previous attempts', async () => {
            mockStore.get.mockResolvedValue(null);
            const result = await checkRateLimit('login', '1.2.3.4');
            expect(result.allowed).toBe(true);
        });

        it('should allow when window has expired', async () => {
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 10,
                    firstAttempt: Date.now() - 20 * 60 * 1000 // 20 minutes ago (beyond 15 min window)
                }
            });
            const result = await checkRateLimit('login', '1.2.3.4');
            expect(result.allowed).toBe(true);
        });

        it('should allow when under limit within window', async () => {
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 3, // Under 5 max
                    firstAttempt: Date.now() - 5 * 60 * 1000 // 5 minutes ago
                }
            });
            const result = await checkRateLimit('login', '1.2.3.4');
            expect(result.allowed).toBe(true);
        });

        it('should deny when login limit exceeded', async () => {
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 5, // At 5 max
                    firstAttempt: Date.now() - 5 * 60 * 1000 // 5 minutes ago (within 15 min window)
                }
            });
            const result = await checkRateLimit('login', '1.2.3.4');
            expect(result.allowed).toBe(false);
            expect(result.retryAfter).toBeGreaterThan(0);
            expect(result.message).toContain('minute');
        });

        it('should deny when register limit exceeded', async () => {
            mockStore.get.mockResolvedValue({
                'register:1.2.3.4': {
                    count: 3, // At 3 max
                    firstAttempt: Date.now() - 30 * 60 * 1000 // 30 minutes ago (within 1 hour window)
                }
            });
            const result = await checkRateLimit('register', '1.2.3.4');
            expect(result.allowed).toBe(false);
        });

        it('should deny when password-reset limit exceeded', async () => {
            mockStore.get.mockResolvedValue({
                'password-reset:1.2.3.4': {
                    count: 1, // At 1 max
                    firstAttempt: Date.now() - 5 * 60 * 1000 // 5 minutes ago (within 15 min window)
                }
            });
            const result = await checkRateLimit('password-reset', '1.2.3.4');
            expect(result.allowed).toBe(false);
        });

        it('should not affect other IPs', async () => {
            mockStore.get.mockResolvedValue({
                'login:5.5.5.5': {
                    count: 10,
                    firstAttempt: Date.now()
                }
            });
            const result = await checkRateLimit('login', '1.2.3.4');
            expect(result.allowed).toBe(true);
        });
    });

    describe('recordAttempt', () => {
        it('should throw for unknown endpoint', async () => {
            await expect(recordAttempt('unknown-endpoint', '1.2.3.4'))
                .rejects.toThrow('Unknown rate limit endpoint');
        });

        it('should create new record for first attempt', async () => {
            mockStore.get.mockResolvedValue({});
            await recordAttempt('login', '1.2.3.4');

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'rate-limits',
                expect.objectContaining({
                    'login:1.2.3.4': expect.objectContaining({
                        count: 1
                    })
                })
            );
        });

        it('should increment existing record within window', async () => {
            const now = Date.now();
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 2,
                    firstAttempt: now - 1000,
                    lastAttempt: now - 500
                }
            });
            await recordAttempt('login', '1.2.3.4');

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'rate-limits',
                expect.objectContaining({
                    'login:1.2.3.4': expect.objectContaining({
                        count: 3
                    })
                })
            );
        });

        it('should reset record when window has expired', async () => {
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 5,
                    firstAttempt: Date.now() - 20 * 60 * 1000 // expired
                }
            });
            await recordAttempt('login', '1.2.3.4');

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'rate-limits',
                expect.objectContaining({
                    'login:1.2.3.4': expect.objectContaining({
                        count: 1 // Reset to 1
                    })
                })
            );
        });
    });

    describe('clearRateLimit', () => {
        it('should remove rate limit record for endpoint and IP', async () => {
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': { count: 3, firstAttempt: Date.now() },
                'login:5.5.5.5': { count: 2, firstAttempt: Date.now() }
            });

            await clearRateLimit('login', '1.2.3.4');

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'rate-limits',
                expect.not.objectContaining({
                    'login:1.2.3.4': expect.anything()
                })
            );
            // Should still have the other record
            const savedData = mockStore.setJSON.mock.calls[0][1];
            expect(savedData['login:5.5.5.5']).toBeDefined();
        });
    });

    describe('cleanupExpiredRecords', () => {
        it('should remove expired records', async () => {
            const now = Date.now();
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 5,
                    firstAttempt: now - 20 * 60 * 1000 // Expired (>15 min)
                },
                'login:5.5.5.5': {
                    count: 2,
                    firstAttempt: now - 5 * 60 * 1000 // Not expired
                }
            });

            const removedCount = await cleanupExpiredRecords();

            expect(removedCount).toBe(1);
            const savedData = mockStore.setJSON.mock.calls[0][1];
            expect(savedData['login:1.2.3.4']).toBeUndefined();
            expect(savedData['login:5.5.5.5']).toBeDefined();
        });

        it('should return 0 when no records expired', async () => {
            mockStore.get.mockResolvedValue({
                'login:1.2.3.4': {
                    count: 2,
                    firstAttempt: Date.now() - 1000 // Very recent
                }
            });

            const removedCount = await cleanupExpiredRecords();
            expect(removedCount).toBe(0);
            expect(mockStore.setJSON).not.toHaveBeenCalled();
        });

        it('should handle empty store', async () => {
            mockStore.get.mockResolvedValue(null);
            const removedCount = await cleanupExpiredRecords();
            expect(removedCount).toBe(0);
        });
    });
});
