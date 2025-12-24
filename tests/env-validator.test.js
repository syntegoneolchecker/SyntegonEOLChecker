/**
 * Tests for environment variable validation
 */

describe('Environment Validator', () => {
    let envValidator;
    let originalEnv;

    beforeEach(() => {
        // Save original env
        originalEnv = { ...process.env };

        // Clear all relevant env vars
        delete process.env.SITE_ID;
        delete process.env.TAVILY_API_KEY;
        delete process.env.GROQ_API_KEY;
        delete process.env.NETLIFY_BLOBS_TOKEN;
        delete process.env.NETLIFY_TOKEN;
        delete process.env.BROWSERQL_API_KEY;
        delete process.env.SCRAPING_SERVICE_URL;
        delete process.env.IDEC_JP_PROXY;
        delete process.env.IDEC_US_PROXY;

        // Reset modules to get fresh imports
        jest.resetModules();

        // Mock console to reduce test noise
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        envValidator = require('../netlify/functions/lib/env-validator');
    });

    afterEach(() => {
        // Restore original env
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    describe('validateCommonEnvVars', () => {
        test('should throw if SITE_ID is missing', () => {
            process.env.TAVILY_API_KEY = 'test-key';
            process.env.GROQ_API_KEY = 'test-key';

            expect(() => envValidator.validateCommonEnvVars())
                .toThrow('Missing required environment variables');
        });

        test('should throw if TAVILY_API_KEY is missing', () => {
            process.env.SITE_ID = 'test-site';
            process.env.GROQ_API_KEY = 'test-key';

            expect(() => envValidator.validateCommonEnvVars())
                .toThrow('Missing required environment variables');
        });

        test('should throw if GROQ_API_KEY is missing', () => {
            process.env.SITE_ID = 'test-site';
            process.env.TAVILY_API_KEY = 'test-key';

            expect(() => envValidator.validateCommonEnvVars())
                .toThrow('Missing required environment variables');
        });

        test('should not throw if all required vars are present', () => {
            process.env.SITE_ID = 'test-site';
            process.env.TAVILY_API_KEY = 'test-tavily-key';
            process.env.GROQ_API_KEY = 'test-groq-key';

            expect(() => envValidator.validateCommonEnvVars()).not.toThrow();
        });
    });

    describe('validateBlobsToken', () => {
        test('should throw if both tokens are missing', () => {
            expect(() => envValidator.validateBlobsToken())
                .toThrow('NETLIFY_BLOBS_TOKEN or NETLIFY_TOKEN');
        });

        test('should not throw if NETLIFY_BLOBS_TOKEN is present', () => {
            process.env.NETLIFY_BLOBS_TOKEN = 'test-blob-token';

            expect(() => envValidator.validateBlobsToken()).not.toThrow();
        });

        test('should not throw if NETLIFY_TOKEN is present', () => {
            process.env.NETLIFY_TOKEN = 'test-netlify-token';

            expect(() => envValidator.validateBlobsToken()).not.toThrow();
        });
    });

    describe('validateScrapingServiceUrl', () => {
        test('should throw if URL is missing', () => {
            expect(() => envValidator.validateScrapingServiceUrl())
                .toThrow('SCRAPING_SERVICE_URL environment variable is required');
        });

        test('should throw if URL format is invalid', () => {
            process.env.SCRAPING_SERVICE_URL = 'invalid-url';

            expect(() => envValidator.validateScrapingServiceUrl())
                .toThrow('Invalid SCRAPING_SERVICE_URL format');
        });

        test('should not throw for valid HTTP URL', () => {
            process.env.SCRAPING_SERVICE_URL = 'http://localhost:3000';

            expect(() => envValidator.validateScrapingServiceUrl()).not.toThrow();
        });

        test('should not throw for valid HTTPS URL', () => {
            process.env.SCRAPING_SERVICE_URL = 'https://example.onrender.com';

            expect(() => envValidator.validateScrapingServiceUrl()).not.toThrow();
        });
    });

    describe('validateBrowserQLKey', () => {
        test('should return false and warn if key is missing', () => {
            const result = envValidator.validateBrowserQLKey();

            expect(result).toBe(false);
            expect(console.warn).toHaveBeenCalledWith(
                '[WARN]',
                expect.stringContaining('BROWSERQL_API_KEY not set')
            );
        });

        test('should return true if key is present', () => {
            process.env.BROWSERQL_API_KEY = 'test-browserql-key';

            const result = envValidator.validateBrowserQLKey();

            expect(result).toBe(true);
        });
    });

    describe('validateIdecProxies', () => {
        test('should return false if both proxies are missing', () => {
            const result = envValidator.validateIdecProxies();

            expect(result).toBe(false);
            expect(console.warn).toHaveBeenCalledWith(
                '[WARN]',
                expect.stringContaining('IDEC proxy URLs not configured')
            );
        });

        test('should return false if only JP proxy is present', () => {
            process.env.IDEC_JP_PROXY = 'http://jp-proxy.com';

            const result = envValidator.validateIdecProxies();

            expect(result).toBe(false);
        });

        test('should return false if only US proxy is present', () => {
            process.env.IDEC_US_PROXY = 'http://us-proxy.com';

            const result = envValidator.validateIdecProxies();

            expect(result).toBe(false);
        });

        test('should return true if both proxies are present', () => {
            process.env.IDEC_JP_PROXY = 'http://jp-proxy.com';
            process.env.IDEC_US_PROXY = 'http://us-proxy.com';

            const result = envValidator.validateIdecProxies();

            expect(result).toBe(true);
        });
    });
});
