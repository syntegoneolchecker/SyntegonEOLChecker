// Character encoding detection and decoding utilities
const iconv = require('iconv-lite');
const jschardet = require('jschardet');
const logger = require('./logger');

/**
 * Detect and decode text with proper character encoding
 * This fixes mojibake (文字化け) issues with Japanese and other non-UTF-8 content
 * @param {Buffer} buffer - Content buffer
 * @param {string} contentTypeHeader - HTTP Content-Type header (optional)
 * @returns {string} Decoded text
 */
function decodeWithProperEncoding(buffer, contentTypeHeader = '') {
    try {
        const encoding = detectEncoding(buffer, contentTypeHeader);
        return decodeBufferWithEncoding(buffer, encoding);
    } catch (error) {
        logger.error('Error during encoding detection/decoding:', error.message);
        // Final fallback: UTF-8
        return buffer.toString('utf8');
    }
}

/**
 * Detect encoding from various sources
 * @param {Buffer} buffer - Content buffer
 * @param {string} contentTypeHeader - HTTP Content-Type header
 * @returns {string|null} Detected encoding or null
 */
function detectEncoding(buffer, contentTypeHeader) {
    let encoding = extractEncodingFromContentType(contentTypeHeader);

    if (!encoding) {
        encoding = extractEncodingFromHtmlMeta(buffer);
    }

    if (!encoding) {
        encoding = autoDetectEncoding(buffer);
    }

    return encoding;
}

/**
 * Extract encoding from Content-Type header
 * @param {string} contentTypeHeader - HTTP Content-Type header
 * @returns {string|null} Encoding or null
 */
function extractEncodingFromContentType(contentTypeHeader) {
    if (!contentTypeHeader) return null;

    const charsetMatch = new RegExp(/charset=([^\s;]+)/i).exec(contentTypeHeader);
    if (charsetMatch) {
        const encoding = charsetMatch[1].toLowerCase();
        logger.info(`Encoding from Content-Type header: ${encoding}`);
        return encoding;
    }

    return null;
}

/**
 * Extract encoding from HTML meta tags
 * @param {Buffer} buffer - Content buffer
 * @returns {string|null} Encoding or null
 */
function extractEncodingFromHtmlMeta(buffer) {
    const preview = buffer.slice(0, 2048).toString('binary');

    // Look for <meta charset="...">
    const metaCharsetMatch = preview.match(/<meta[^>]+charset=["']?([^"'\s>]+)/i);
    if (metaCharsetMatch) {
        const encoding = metaCharsetMatch[1].toLowerCase();
        logger.info(`Encoding from meta charset tag: ${encoding}`);
        return encoding;
    }

    // Look for <meta http-equiv="Content-Type" content="...charset=...">
    const httpEquivMatch = preview.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["']?[^"'>]*charset=([^"'\s>]+)/i);
    if (httpEquivMatch) {
        const encoding = httpEquivMatch[1].toLowerCase();
        logger.info(`Encoding from http-equiv meta tag: ${encoding}`);
        return encoding;
    }

    return null;
}

/**
 * Auto-detect encoding using jschardet
 * @param {Buffer} buffer - Content buffer
 * @returns {string|null} Detected encoding or null
 */
function autoDetectEncoding(buffer) {
    const detected = jschardet.detect(buffer);
    if (detected?.encoding && detected.confidence > 0.7) {
        const encoding = detected.encoding.toLowerCase();
        logger.info(`Auto-detected encoding: ${encoding} (confidence: ${(detected.confidence * 100).toFixed(1)}%)`);
        return encoding;
    }

    return null;
}

/**
 * Normalize encoding name for iconv-lite compatibility
 * @param {string} encoding - Raw encoding name
 * @returns {string} Normalized encoding name
 */
function normalizeEncoding(encoding) {
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

    return encodingMap[encoding] || encoding;
}

/**
 * Decode buffer with specified encoding
 * @param {Buffer} buffer - Content buffer
 * @param {string|null} encoding - Encoding to use
 * @returns {string} Decoded text
 */
function decodeBufferWithEncoding(buffer, encoding) {
    if (!encoding) {
        logger.info('No encoding detected, using UTF-8 as fallback');
        return buffer.toString('utf8');
    }

    const normalizedEncoding = normalizeEncoding(encoding);

    if (iconv.encodingExists(normalizedEncoding)) {
        const decoded = iconv.decode(buffer, normalizedEncoding);
        logger.info(`✓ Successfully decoded content using ${normalizedEncoding}`);
        return decoded;
    } else {
        logger.warn(`⚠️  Encoding '${normalizedEncoding}' not supported by iconv-lite, falling back to UTF-8`);
        return buffer.toString('utf8');
    }
}

module.exports = {
    decodeWithProperEncoding
};
