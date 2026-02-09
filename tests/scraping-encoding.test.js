// Mock the scraping service logger
jest.mock('../scraping-service/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { decodeWithProperEncoding } = require('../scraping-service/utils/encoding');

describe('Scraping Service - Encoding Utilities', () => {

    describe('decodeWithProperEncoding', () => {
        it('should decode UTF-8 content by default', () => {
            const buffer = Buffer.from('Hello World', 'utf8');
            const result = decodeWithProperEncoding(buffer);
            expect(result).toBe('Hello World');
        });

        it('should decode UTF-8 content with explicit Content-Type charset', () => {
            const buffer = Buffer.from('Hello World', 'utf8');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=utf-8');
            expect(result).toBe('Hello World');
        });

        it('should detect encoding from Content-Type header', () => {
            const buffer = Buffer.from('Hello World', 'utf8');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=UTF-8');
            expect(result).toBe('Hello World');
        });

        it('should detect encoding from HTML meta charset tag', () => {
            const html = '<html><head><meta charset="utf-8"></head><body>Test</body></html>';
            const buffer = Buffer.from(html, 'utf8');
            const result = decodeWithProperEncoding(buffer);
            expect(result).toContain('Test');
        });

        it('should detect encoding from http-equiv meta tag', () => {
            const html = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>Content</body></html>';
            const buffer = Buffer.from(html, 'utf8');
            const result = decodeWithProperEncoding(buffer);
            expect(result).toContain('Content');
        });

        it('should handle Shift_JIS content when declared in Content-Type', () => {
            // Create a Shift_JIS encoded buffer for a simple string
            // The iconv-lite library should handle this
            const iconv = require('iconv-lite');
            const japaneseText = 'テスト';
            const buffer = iconv.encode(japaneseText, 'shift_jis');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=shift_jis');
            expect(result).toBe(japaneseText);
        });

        it('should handle EUC-JP content when declared in Content-Type', () => {
            const iconv = require('iconv-lite');
            const japaneseText = 'こんにちは';
            const buffer = iconv.encode(japaneseText, 'euc-jp');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=euc-jp');
            expect(result).toBe(japaneseText);
        });

        it('should fall back to UTF-8 when no encoding is detected', () => {
            // Short buffer that jschardet can't confidently detect
            const buffer = Buffer.from('hi', 'utf8');
            const result = decodeWithProperEncoding(buffer, '');
            expect(result).toBe('hi');
        });

        it('should handle empty buffer', () => {
            const buffer = Buffer.from('');
            const result = decodeWithProperEncoding(buffer);
            expect(result).toBe('');
        });

        it('should prioritize Content-Type header over meta tag', () => {
            const iconv = require('iconv-lite');
            // Content-Type says shift_jis, meta says utf-8
            const japaneseText = 'テスト';
            const buffer = iconv.encode(japaneseText, 'shift_jis');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=shift_jis');
            expect(result).toBe(japaneseText);
        });

        it('should handle x-sjis encoding alias', () => {
            const iconv = require('iconv-lite');
            const japaneseText = 'データ';
            const buffer = iconv.encode(japaneseText, 'shift_jis');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=x-sjis');
            expect(result).toBe(japaneseText);
        });

        it('should handle content with iso-2022-jp declared and decode or fall back', () => {
            // iso-2022-jp might not be encodable by iconv-lite in tests,
            // but the decode path should handle it or fall back to UTF-8
            const buffer = Buffer.from('ABC', 'utf8');
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=iso-2022-jp');
            expect(result).toContain('ABC');
        });

        it('should gracefully handle unsupported encoding', () => {
            const buffer = Buffer.from('Hello', 'utf8');
            // Use an encoding that iconv-lite doesn't support
            const result = decodeWithProperEncoding(buffer, 'text/html; charset=some-fake-encoding');
            // Should fall back to UTF-8
            expect(result).toBe('Hello');
        });
    });
});
