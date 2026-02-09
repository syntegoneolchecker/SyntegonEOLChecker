// Mock the scraping service logger before requiring the module
jest.mock('../scraping-service/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { isSafePublicUrl, isValidCallbackUrl } = require('../scraping-service/utils/validation');

describe('Scraping Service - URL Validation', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.ALLOWED_ORIGINS;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('isSafePublicUrl', () => {
        describe('valid public URLs', () => {
            it('should accept HTTPS URLs', () => {
                expect(isSafePublicUrl('https://www.example.com')).toEqual({ valid: true });
            });

            it('should accept HTTP URLs', () => {
                expect(isSafePublicUrl('http://www.example.com')).toEqual({ valid: true });
            });

            it('should accept URLs with paths', () => {
                expect(isSafePublicUrl('https://example.com/path/to/page')).toEqual({ valid: true });
            });

            it('should accept URLs with query parameters', () => {
                expect(isSafePublicUrl('https://example.com?q=test&page=1')).toEqual({ valid: true });
            });

            it('should accept manufacturer URLs', () => {
                expect(isSafePublicUrl('https://www.keyence.co.jp/products/sensor/model-abc')).toEqual({ valid: true });
            });
        });

        describe('protocol restrictions', () => {
            it('should reject file:// protocol', () => {
                const result = isSafePublicUrl('file:///etc/passwd');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('HTTP/HTTPS');
            });

            it('should reject ftp:// protocol', () => {
                const result = isSafePublicUrl('ftp://ftp.example.com');
                expect(result.valid).toBe(false);
            });

            it('should reject data: protocol', () => {
                const result = isSafePublicUrl('data:text/html,<h1>hi</h1>');
                expect(result.valid).toBe(false);
            });

            it('should reject javascript: protocol', () => {
                const result = isSafePublicUrl('javascript:alert(1)');
                expect(result.valid).toBe(false);
            });
        });

        describe('SSRF protection - localhost', () => {
            it('should block localhost', () => {
                const result = isSafePublicUrl('http://localhost/admin');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('localhost');
            });

            it('should block 127.0.0.1', () => {
                const result = isSafePublicUrl('http://127.0.0.1:8080');
                expect(result.valid).toBe(false);
            });

            it('should block 0.0.0.0', () => {
                const result = isSafePublicUrl('http://0.0.0.0');
                expect(result.valid).toBe(false);
            });

            it('should block IPv6 loopback ::1', () => {
                const result = isSafePublicUrl('http://[::1]');
                expect(result.valid).toBe(false);
            });
        });

        describe('SSRF protection - private IP ranges (RFC 1918)', () => {
            it('should block 10.x.x.x range', () => {
                const result = isSafePublicUrl('http://10.0.0.1');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('private');
            });

            it('should block 172.16-31.x.x range', () => {
                expect(isSafePublicUrl('http://172.16.0.1').valid).toBe(false);
                expect(isSafePublicUrl('http://172.20.0.1').valid).toBe(false);
                expect(isSafePublicUrl('http://172.31.255.255').valid).toBe(false);
            });

            it('should allow 172.15.x.x (not private)', () => {
                // 172.15.x.x is NOT in the private range, but let's check the regex
                // The regex checks 172.(16-31), so 172.15 should pass
                const result = isSafePublicUrl('http://172.15.0.1');
                // This might be blocked by other rules (starts with numbers, etc.)
                // but not by the private IP check specifically
                expect(result.valid).toBe(true);
            });

            it('should block 192.168.x.x range', () => {
                const result = isSafePublicUrl('http://192.168.1.1');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('private');
            });
        });

        describe('SSRF protection - link-local and cloud metadata', () => {
            it('should block 169.254.x.x (AWS metadata)', () => {
                const result = isSafePublicUrl('http://169.254.169.254/latest/meta-data/');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('link-local');
            });
        });

        describe('SSRF protection - reserved IP ranges', () => {
            it('should block 0.x.x.x range', () => {
                const result = isSafePublicUrl('http://0.0.0.1');
                expect(result.valid).toBe(false);
            });

            it('should block 127.x.x.x loopback range', () => {
                const result = isSafePublicUrl('http://127.0.0.2');
                expect(result.valid).toBe(false);
            });

            it('should block 224.x.x.x multicast', () => {
                const result = isSafePublicUrl('http://224.0.0.1');
                expect(result.valid).toBe(false);
            });

            it('should block 240.x.x.x reserved', () => {
                const result = isSafePublicUrl('http://240.0.0.1');
                expect(result.valid).toBe(false);
            });

            it('should block CGNAT range 100.64-127.x.x', () => {
                expect(isSafePublicUrl('http://100.64.0.1').valid).toBe(false);
                expect(isSafePublicUrl('http://100.127.255.255').valid).toBe(false);
            });
        });

        describe('SSRF protection - IPv6 private', () => {
            it('should block fc00::/7 unique local addresses', () => {
                expect(isSafePublicUrl('http://[fc00::1]').valid).toBe(false);
                expect(isSafePublicUrl('http://[fd00::1]').valid).toBe(false);
            });

            it('should block fe80:: link-local addresses', () => {
                expect(isSafePublicUrl('http://[fe80::1]').valid).toBe(false);
            });
        });

        describe('invalid URLs', () => {
            it('should reject empty string', () => {
                const result = isSafePublicUrl('');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('Invalid URL');
            });

            it('should reject malformed URLs', () => {
                const result = isSafePublicUrl('not-a-url');
                expect(result.valid).toBe(false);
            });
        });
    });

    describe('isValidCallbackUrl', () => {
        describe('with no callbackUrl', () => {
            it('should return valid for null/empty callback URL', () => {
                expect(isValidCallbackUrl(null)).toEqual({ valid: true });
                expect(isValidCallbackUrl('')).toEqual({ valid: true });
                expect(isValidCallbackUrl(undefined)).toEqual({ valid: true });
            });
        });

        describe('with default localhost origins (no ALLOWED_ORIGINS)', () => {
            it('should accept localhost:3000', () => {
                const result = isValidCallbackUrl('http://localhost:3000/callback');
                expect(result.valid).toBe(true);
            });

            it('should accept localhost:5000', () => {
                const result = isValidCallbackUrl('http://localhost:5000/callback');
                expect(result.valid).toBe(true);
            });

            it('should accept localhost:8888', () => {
                const result = isValidCallbackUrl('http://localhost:8888/callback');
                expect(result.valid).toBe(true);
            });

            it('should reject localhost with wrong port', () => {
                const result = isValidCallbackUrl('http://localhost:9999/callback');
                expect(result.valid).toBe(false);
            });

            it('should reject external domains', () => {
                const result = isValidCallbackUrl('https://evil.com/callback');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('not in allowed list');
            });
        });

        describe('with custom ALLOWED_ORIGINS', () => {
            it('should accept matching domain', () => {
                process.env.ALLOWED_ORIGINS = 'https://syntegoneolchecker.netlify.app';
                const result = isValidCallbackUrl('https://syntegoneolchecker.netlify.app/.netlify/functions/scraping-callback');
                expect(result.valid).toBe(true);
            });

            it('should accept subdomain of allowed domain', () => {
                process.env.ALLOWED_ORIGINS = 'https://netlify.app';
                const result = isValidCallbackUrl('https://syntegoneolchecker.netlify.app/callback');
                expect(result.valid).toBe(true);
            });

            it('should reject domains not in allowed list', () => {
                process.env.ALLOWED_ORIGINS = 'https://syntegoneolchecker.netlify.app';
                const result = isValidCallbackUrl('https://evil.com/callback');
                expect(result.valid).toBe(false);
            });
        });

        describe('protocol restrictions', () => {
            it('should reject non-HTTP/HTTPS callback URLs', () => {
                process.env.ALLOWED_ORIGINS = 'https://example.com';
                const result = isValidCallbackUrl('ftp://example.com/callback');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('HTTP/HTTPS');
            });
        });

        describe('invalid URLs', () => {
            it('should reject malformed callback URLs', () => {
                const result = isValidCallbackUrl('not-a-url');
                expect(result.valid).toBe(false);
                expect(result.reason).toContain('Invalid callback URL');
            });
        });
    });
});
