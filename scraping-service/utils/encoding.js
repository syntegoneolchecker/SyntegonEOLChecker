// Character encoding detection and decoding utilities
const iconv = require('iconv-lite');
const jschardet = require('jschardet');

/**
 * Detect and decode text with proper character encoding
 * This fixes mojibake (文字化け) issues with Japanese and other non-UTF-8 content
 * @param {Buffer} buffer - Content buffer
 * @param {string} contentTypeHeader - HTTP Content-Type header (optional)
 * @returns {string} Decoded text
 */
function decodeWithProperEncoding(buffer, contentTypeHeader = '') {
    try {
        // Step 1: Try to get encoding from HTTP Content-Type header
        let encoding = null;
        if (contentTypeHeader) {
            const charsetMatch = contentTypeHeader.match(/charset=([^\s;]+)/i);
            if (charsetMatch) {
                encoding = charsetMatch[1].toLowerCase();
                console.log(`Encoding from Content-Type header: ${encoding}`);
            }
        }

        // Step 2: Check HTML meta tags for charset (first 2KB should contain meta tags)
        if (!encoding) {
            const preview = buffer.slice(0, 2048).toString('binary');

            // Look for <meta charset="...">
            const metaCharsetMatch = preview.match(/<meta[^>]+charset=["']?([^"'\s>]+)/i);
            if (metaCharsetMatch) {
                encoding = metaCharsetMatch[1].toLowerCase();
                console.log(`Encoding from meta charset tag: ${encoding}`);
            }

            // Look for <meta http-equiv="Content-Type" content="...charset=...">
            if (!encoding) {
                const httpEquivMatch = preview.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["']?[^"'>]*charset=([^"'\s>]+)/i);
                if (httpEquivMatch) {
                    encoding = httpEquivMatch[1].toLowerCase();
                    console.log(`Encoding from http-equiv meta tag: ${encoding}`);
                }
            }
        }

        // Step 3: Auto-detect encoding if still unknown (especially important for Japanese sites)
        if (!encoding) {
            const detected = jschardet.detect(buffer);
            if (detected && detected.encoding && detected.confidence > 0.7) {
                encoding = detected.encoding.toLowerCase();
                console.log(`Auto-detected encoding: ${encoding} (confidence: ${(detected.confidence * 100).toFixed(1)}%)`);
            }
        }

        // Step 4: Normalize encoding names and use fallbacks
        if (encoding) {
            // Normalize common encoding aliases
            const encodingMap = {
                'shift_jis': 'shift_jis',
                'shift-jis': 'shift_jis',
                'sjis': 'shift_jis',
                'x-sjis': 'shift_jis',
                'euc-jp': 'euc-jp',
                'eucjp': 'euc-jp',
                'iso-2022-jp': 'iso-2022-jp',
                'utf-8': 'utf8',
                'utf8': 'utf8'
            };

            encoding = encodingMap[encoding] || encoding;

            // Try to decode with detected encoding
            if (iconv.encodingExists(encoding)) {
                const decoded = iconv.decode(buffer, encoding);
                console.log(`✓ Successfully decoded content using ${encoding}`);
                return decoded;
            } else {
                console.warn(`⚠️  Encoding '${encoding}' not supported by iconv-lite, falling back to UTF-8`);
            }
        }

        // Step 5: Default fallback to UTF-8
        console.log('Using UTF-8 as fallback encoding');
        return buffer.toString('utf8');

    } catch (error) {
        console.error('Error during encoding detection/decoding:', error.message);
        // Final fallback: UTF-8
        return buffer.toString('utf8');
    }
}

module.exports = {
    decodeWithProperEncoding
};
