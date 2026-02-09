// Mock the scraping service logger and its transitive deps
jest.mock('../scraping-service/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock encoding module to avoid iconv-lite/jschardet dependency issues in this test
jest.mock('../scraping-service/utils/encoding', () => ({
    decodeWithProperEncoding: jest.fn((buffer, contentType) => buffer.toString('utf8'))
}));

const { isPDFUrl, isTextFileUrl, extractHTMLText, isErrorPage } = require('../scraping-service/utils/extraction');

describe('Scraping Service - Extraction Utilities', () => {

    describe('isPDFUrl', () => {
        it('should detect .pdf extension', () => {
            expect(isPDFUrl('https://example.com/document.pdf')).toBe(true);
        });

        it('should detect .PDF extension (case insensitive)', () => {
            expect(isPDFUrl('https://example.com/document.PDF')).toBe(true);
        });

        it('should detect pdf in URL path', () => {
            expect(isPDFUrl('https://example.com/pdf/document')).toBe(true);
        });

        it('should detect pdf in query string', () => {
            expect(isPDFUrl('https://example.com/doc?format=pdf')).toBe(true);
        });

        it('should return false for non-PDF URLs', () => {
            expect(isPDFUrl('https://example.com/page.html')).toBe(false);
        });

        it('should return false for URLs without pdf', () => {
            expect(isPDFUrl('https://example.com/products/sensor-xyz')).toBe(false);
        });
    });

    describe('isTextFileUrl', () => {
        it('should detect .txt files', () => {
            expect(isTextFileUrl('https://example.com/readme.txt')).toBe(true);
        });

        it('should detect .log files', () => {
            expect(isTextFileUrl('https://example.com/error.log')).toBe(true);
        });

        it('should detect .md files', () => {
            expect(isTextFileUrl('https://example.com/README.md')).toBe(true);
        });

        it('should detect .csv files', () => {
            expect(isTextFileUrl('https://example.com/data.csv')).toBe(true);
        });

        it('should be case insensitive', () => {
            expect(isTextFileUrl('https://example.com/README.TXT')).toBe(true);
        });

        it('should return false for HTML files', () => {
            expect(isTextFileUrl('https://example.com/page.html')).toBe(false);
        });

        it('should return false for PDF files', () => {
            expect(isTextFileUrl('https://example.com/doc.pdf')).toBe(false);
        });
    });

    describe('isErrorPage', () => {
        it('should detect 404 Not Found pages', () => {
            expect(isErrorPage('404 Not Found - The page you are looking for does not exist')).toBe(true);
        });

        it('should detect 500 Internal Server Error pages', () => {
            expect(isErrorPage('500 Internal Server Error - Something went wrong on our end')).toBe(true);
        });

        it('should detect 403 Forbidden pages', () => {
            expect(isErrorPage('403 Forbidden - You do not have permission to access this resource')).toBe(true);
        });

        it('should detect "Page Not Found" text', () => {
            expect(isErrorPage('Sorry, Page Not Found on this website')).toBe(true);
        });

        it('should detect "Access Denied" text', () => {
            expect(isErrorPage('Access Denied - You are not authorized to view this content')).toBe(true);
        });

        it('should detect Japanese error pages', () => {
            expect(isErrorPage('ページが見つかりませんでした。お探しのページは存在しません。')).toBe(true);
        });

        it('should detect another Japanese error pattern', () => {
            expect(isErrorPage('申し訳ございませんが、ご指定のページが見つかりませんでした。別のページをお試しください。')).toBe(true);
        });

        it('should return true for very short text (under 50 chars)', () => {
            expect(isErrorPage('Short text')).toBe(true);
        });

        it('should return true for null/empty input', () => {
            expect(isErrorPage(null)).toBe(true);
            expect(isErrorPage('')).toBe(true);
        });

        it('should return false for normal content', () => {
            const normalContent = 'This is a product specification page for the XYZ-100 sensor. ' +
                'It provides detailed information about the sensor capabilities and pricing.';
            expect(isErrorPage(normalContent)).toBe(false);
        });

        it('should return false for content with product information', () => {
            const content = 'Model: ABC-123 | Status: Available | Price: $199.99 | ' +
                'This product is currently in production and available for purchase.';
            expect(isErrorPage(content)).toBe(false);
        });
    });

    describe('extractHTMLText', () => {
        it('should extract plain text from HTML', () => {
            const html = '<html><body><p>Hello World</p></body></html>';
            const result = extractHTMLText(html);
            expect(result).toContain('Hello World');
        });

        it('should remove script tags and their content', () => {
            const html = '<p>Content</p><script>alert("xss")</script><p>More</p>';
            const result = extractHTMLText(html);
            expect(result).toContain('Content');
            expect(result).toContain('More');
            expect(result).not.toContain('alert');
        });

        it('should remove style tags and their content', () => {
            const html = '<p>Content</p><style>.hidden { display: none; }</style>';
            const result = extractHTMLText(html);
            expect(result).toContain('Content');
            expect(result).not.toContain('display');
        });

        it('should remove nav elements', () => {
            const html = '<nav><a href="/">Home</a><a href="/about">About</a></nav><p>Main content</p>';
            const result = extractHTMLText(html);
            expect(result).toContain('Main content');
            expect(result).not.toContain('Home');
        });

        it('should remove footer elements', () => {
            const html = '<p>Content</p><footer>Copyright 2024</footer>';
            const result = extractHTMLText(html);
            expect(result).toContain('Content');
            expect(result).not.toContain('Copyright');
        });

        it('should remove header elements', () => {
            const html = '<header><h1>Site Title</h1></header><p>Main content</p>';
            const result = extractHTMLText(html);
            expect(result).toContain('Main content');
        });

        it('should remove HTML comments', () => {
            const html = '<p>Content</p><!-- This is a comment --><p>More</p>';
            const result = extractHTMLText(html);
            expect(result).toContain('Content');
            expect(result).not.toContain('comment');
        });

        it('should remove template tags', () => {
            const html = '<p>Content</p><template><div>Template content</div></template>';
            const result = extractHTMLText(html);
            expect(result).toContain('Content');
            expect(result).not.toContain('Template content');
        });

        it('should remove noscript tags', () => {
            const html = '<p>Content</p><noscript>Enable JavaScript</noscript>';
            const result = extractHTMLText(html);
            expect(result).toContain('Content');
            expect(result).not.toContain('Enable JavaScript');
        });

        it('should decode HTML entities', () => {
            const html = '<p>A &amp; B &lt; C &gt; D &quot;E&quot;</p>';
            const result = extractHTMLText(html);
            expect(result).toContain('A & B < C > D "E"');
        });

        it('should replace &nbsp; with space', () => {
            const html = '<p>Hello&nbsp;World</p>';
            const result = extractHTMLText(html);
            expect(result).toContain('Hello World');
        });

        it('should preserve table structure with pipe delimiters', () => {
            const html = '<table><tr><th>Model</th><th>Status</th></tr><tr><td>ABC-123</td><td>Active</td></tr></table>';
            const result = extractHTMLText(html);
            // Table cells are converted to pipe-delimited format (with possible extra spaces)
            expect(result).toMatch(/\|\s*Model/);
            expect(result).toMatch(/\|\s*ABC-123/);
        });

        it('should handle complex HTML with mixed content', () => {
            const html = `
                <html>
                <head><title>Product Page</title></head>
                <body>
                    <header><nav>Menu</nav></header>
                    <main>
                        <h1>Product ABC-123</h1>
                        <p>This product is available for purchase.</p>
                        <table>
                            <tr><th>Feature</th><th>Value</th></tr>
                            <tr><td>Voltage</td><td>24V</td></tr>
                        </table>
                    </main>
                    <footer>Copyright 2024</footer>
                    <script>var x = 1;</script>
                </body>
                </html>
            `;
            const result = extractHTMLText(html);
            expect(result).toContain('Product ABC-123');
            expect(result).toContain('available for purchase');
            expect(result).not.toContain('var x = 1');
        });
    });
});
