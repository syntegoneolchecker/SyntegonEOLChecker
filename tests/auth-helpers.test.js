// Mock rate-limiter to avoid Netlify Blobs dependency
jest.mock('../netlify/functions/lib/rate-limiter', () => ({
    checkRateLimit: jest.fn(),
    getClientIP: jest.fn()
}));

// Mock response-builder
jest.mock('../netlify/functions/lib/response-builder', () => ({
    getCorsOrigin: jest.fn(() => '*')
}));

// Mock logger
jest.mock('../netlify/functions/lib/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { validateAuthRequest } = require('../netlify/functions/lib/auth-helpers');
const { checkRateLimit, getClientIP } = require('../netlify/functions/lib/rate-limiter');

describe('Auth Helpers', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        getClientIP.mockReturnValue('1.2.3.4');
        checkRateLimit.mockResolvedValue({ allowed: true });
    });

    describe('validateAuthRequest', () => {
        it('should return CORS preflight response for OPTIONS requests', async () => {
            const event = { httpMethod: 'OPTIONS', headers: {} };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).not.toBeNull();
            expect(result.error.statusCode).toBe(204);
            expect(result.error.headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
        });

        it('should reject non-POST requests', async () => {
            const event = { httpMethod: 'GET', headers: {} };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).not.toBeNull();
            expect(result.error.statusCode).toBe(405);
        });

        it('should reject invalid JSON body', async () => {
            const event = {
                httpMethod: 'POST',
                headers: {},
                body: 'not-json'
            };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).not.toBeNull();
            expect(result.error.statusCode).toBe(400);
            const body = JSON.parse(result.error.body);
            expect(body.message).toContain('Invalid JSON');
        });

        it('should reject missing email', async () => {
            const event = {
                httpMethod: 'POST',
                headers: {},
                body: JSON.stringify({ password: 'secret' })
            };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).not.toBeNull();
            expect(result.error.statusCode).toBe(400);
            const body = JSON.parse(result.error.body);
            expect(body.message).toContain('Email and password are required');
        });

        it('should reject missing password', async () => {
            const event = {
                httpMethod: 'POST',
                headers: {},
                body: JSON.stringify({ email: 'user@syntegon.com' })
            };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).not.toBeNull();
            expect(result.error.statusCode).toBe(400);
        });

        it('should reject when rate limited', async () => {
            checkRateLimit.mockResolvedValue({
                allowed: false,
                retryAfter: 300,
                message: 'Too many attempts. Please try again in 5 minute(s).'
            });

            const event = {
                httpMethod: 'POST',
                headers: {},
                body: JSON.stringify({ email: 'user@syntegon.com', password: 'Password1' })
            };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).not.toBeNull();
            expect(result.error.statusCode).toBe(429);
            expect(result.error.headers['Retry-After']).toBe('300');
        });

        it('should return parsed credentials on success', async () => {
            const event = {
                httpMethod: 'POST',
                headers: {},
                body: JSON.stringify({ email: 'user@syntegon.com', password: 'SecurePass1' })
            };
            const result = await validateAuthRequest(event, 'login');

            expect(result.error).toBeNull();
            expect(result.email).toBe('user@syntegon.com');
            expect(result.password).toBe('SecurePass1');
            expect(result.clientIP).toBe('1.2.3.4');
        });

        it('should call checkRateLimit with correct action and IP', async () => {
            const event = {
                httpMethod: 'POST',
                headers: {},
                body: JSON.stringify({ email: 'user@syntegon.com', password: 'Password1' })
            };
            await validateAuthRequest(event, 'register');

            expect(checkRateLimit).toHaveBeenCalledWith('register', '1.2.3.4');
        });
    });
});
