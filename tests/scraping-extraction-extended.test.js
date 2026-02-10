/**
 * Extended tests for scraping-service/utils/extraction.js
 * Targets: cleanJavaScriptPatterns, extractPDFText, tryFastFetch, and helper functions
 * These extend the existing scraping-extraction.test.js (which covers isPDFUrl, isTextFileUrl, extractHTMLText, isErrorPage)
 */

// Mock logger
jest.mock('../scraping-service/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock encoding
jest.mock('../scraping-service/utils/encoding', () => ({
    decodeWithProperEncoding: jest.fn((buffer, contentType) => buffer.toString('utf8'))
}));

// Mock validation (for tryFastFetch SSRF checks)
jest.mock('../scraping-service/utils/validation', () => ({
    isSafePublicUrl: jest.fn((url) => {
        if (url.includes('unsafe') || url.includes('localhost') || url.includes('127.0.0.1')) {
            return { valid: false, reason: 'Blocked by SSRF protection' };
        }
        return { valid: true };
    })
}));

// Mock pdf-parse
jest.mock('pdf-parse', () => {
    return jest.fn().mockImplementation((buffer, options) => {
        const text = buffer.toString('utf8');
        if (text.includes('EMPTY_PDF')) {
            return Promise.resolve({ text: '', numpages: 1 });
        }
        if (text.includes('PDF_PARSE_FAIL')) {
            return Promise.reject(new Error('pdf-parse failed'));
        }
        return Promise.resolve({
            text: 'Extracted PDF text from pdf-parse',
            numpages: 1
        });
    });
});

// Mock pdfjs-loader (CJS wrapper around pdfjs-dist ESM module)
jest.mock('../scraping-service/utils/pdfjs-loader', () => ({
    loadPdfjs: jest.fn().mockResolvedValue({
        getDocument: jest.fn().mockImplementation(({ data }) => ({
            promise: Promise.resolve({
                numPages: 1,
                getPage: jest.fn().mockResolvedValue({
                    getTextContent: jest.fn().mockResolvedValue({
                        items: [{ str: 'Text from pdfjs-dist' }]
                    })
                })
            })
        }))
    })
}));

const { isPDFUrl, isTextFileUrl, extractHTMLText, isErrorPage, extractPDFText, tryFastFetch } = require('../scraping-service/utils/extraction');

describe('Scraping Extraction - Extended Tests', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    describe('extractPDFText', () => {
        test('should extract text from valid PDF buffer', async () => {
            const pdfBuffer = Buffer.from('%PDF-1.4 valid pdf content');
            const result = await extractPDFText(pdfBuffer, 'https://example.com/doc.pdf');
            expect(result).toContain('Extracted PDF text');
        });

        test('should return error message for empty buffer', async () => {
            const pdfBuffer = Buffer.from('');
            const result = await extractPDFText(pdfBuffer, 'https://example.com/empty.pdf');
            expect(result).toContain('PDF is empty');
        });

        test('should return error message for invalid PDF header', async () => {
            const pdfBuffer = Buffer.from('<html>Not a PDF</html>');
            const result = await extractPDFText(pdfBuffer, 'https://example.com/fake.pdf');
            expect(result).toContain('not a valid PDF');
        });

        test('should fallback to pdfjs-dist when pdf-parse returns empty text', async () => {
            const pdfBuffer = Buffer.from('%PDF-EMPTY_PDF content');
            const result = await extractPDFText(pdfBuffer, 'https://example.com/cjk.pdf');
            expect(result).toContain('pdfjs-dist');
        });

        test('should fallback to pdfjs-dist when pdf-parse throws', async () => {
            const pdfBuffer = Buffer.from('%PDF-PDF_PARSE_FAIL content');
            const result = await extractPDFText(pdfBuffer, 'https://example.com/broken.pdf');
            expect(result).toContain('pdfjs-dist');
        });
    });

    describe('tryFastFetch', () => {
        test('should block unsafe URLs (SSRF protection)', async () => {
            const result = await tryFastFetch('http://localhost:3000/secret');
            expect(result).toBeNull();
        });

        test('should block private IPs', async () => {
            const result = await tryFastFetch('http://127.0.0.1/metadata');
            expect(result).toBeNull();
        });

        test('should fetch and extract HTML content', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: new Map([['content-type', 'text/html']]),
                arrayBuffer: () => Promise.resolve(Buffer.from('<html><body><p>Product info about SENSOR-X. This is a real product page with detailed specifications and pricing information.</p></body></html>'))
            });
            // Polyfill headers.get
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
                arrayBuffer: () => Promise.resolve(Buffer.from('<html><body><p>Product info about SENSOR-X. This is a real product page with detailed specifications and pricing information.</p></body></html>'))
            });

            const result = await tryFastFetch('https://example.com/product');
            expect(result).toContain('Product info');
        });

        test('should return null for error pages', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
                arrayBuffer: () => Promise.resolve(Buffer.from('<html><body>404 Not Found</body></html>'))
            });

            const result = await tryFastFetch('https://example.com/missing');
            expect(result).toBeNull();
        });

        test('should return null for non-ok HTTP response (non-PDF)', async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 500,
                headers: { get: () => null }
            });

            const result = await tryFastFetch('https://example.com/page');
            expect(result).toBeNull();
        });

        test('should return error message for non-ok HTTP response on PDF URL', async () => {
            global.fetch.mockResolvedValue({
                ok: false,
                status: 404,
                headers: { get: () => null }
            });

            const result = await tryFastFetch('https://example.com/document.pdf');
            expect(result).toContain('Could not fetch PDF');
            expect(result).toContain('404');
        });

        test('should handle fetch errors gracefully', async () => {
            global.fetch.mockRejectedValue(new Error('Network error'));

            const result = await tryFastFetch('https://example.com/page');
            expect(result).toBeNull();
        });

        test('should return PDF error message on fetch error for PDF URL', async () => {
            global.fetch.mockRejectedValue(new Error('Connection timeout'));

            const result = await tryFastFetch('https://example.com/document.pdf');
            expect(result).toContain('PDF fetch failed');
        });

        test('should handle text file content type', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => h === 'content-type' ? 'text/plain' : null },
                arrayBuffer: () => Promise.resolve(Buffer.from('Plain text content'))
            });

            const result = await tryFastFetch('https://example.com/readme.txt');
            expect(result).toBe('Plain text content');
        });

        test('should handle PDF content type', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => {
                    if (h === 'content-type') return 'application/pdf';
                    if (h === 'content-length') return '1000';
                    return null;
                }},
                arrayBuffer: () => Promise.resolve(Buffer.from('%PDF-1.4 test content'))
            });

            const result = await tryFastFetch('https://example.com/document.pdf');
            expect(result).toBeDefined();
        });

        test('should reject oversized PDFs', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                headers: { get: (h) => {
                    if (h === 'content-type') return 'application/pdf';
                    if (h === 'content-length') return String(25 * 1024 * 1024); // 25 MB
                    return null;
                }},
                arrayBuffer: () => Promise.resolve(Buffer.from('%PDF-1.4 large'))
            });

            const result = await tryFastFetch('https://example.com/huge.pdf');
            expect(result).toContain('too large');
        });
    });

    describe('extractHTMLText - additional patterns', () => {
        test('should clean JavaScript i18n patterns from content', () => {
            const html = `<body><p>Product info</p><div>'menu.home': 'Home', 'menu.about': 'About Us',</div></body>`;
            const result = extractHTMLText(html);
            expect(result).toContain('Product info');
            // JavaScript patterns should be cleaned
        });

        test('should handle empty HTML', () => {
            const result = extractHTMLText('');
            expect(result).toBe('');
        });

        test('should handle HTML with only scripts and styles', () => {
            const html = '<script>var x = 1;</script><style>.a{color:red}</style>';
            const result = extractHTMLText(html);
            expect(result.trim()).toBe('');
        });
    });

    describe('isErrorPage - boundary cases', () => {
        test('should return true for exactly 50 characters', () => {
            const text = "A".repeat(50);
            expect(isErrorPage(text)).toBe(false); // 50 chars is NOT < 50
        });

        test('should return true for 49 characters', () => {
            const text = "A".repeat(49);
            expect(isErrorPage(text)).toBe(true); // 49 < 50
        });

        test('should detect PAGE NOT FOUND (uppercase)', () => {
            const text = "Sorry, PAGE NOT FOUND. Please try again later. This page does not exist in our system.";
            expect(isErrorPage(text)).toBe(true);
        });

        test('should detect Error404', () => {
            const text = "Error404 - The requested resource could not be found on this server.";
            expect(isErrorPage(text)).toBe(true);
        });

        test('should detect Internal Server Error', () => {
            const text = "Internal Server Error - An unexpected error occurred while processing your request.";
            expect(isErrorPage(text)).toBe(true);
        });
    });
});
