/**
 * Input validation utilities for Netlify functions
 */

/**
 * Validate job initialization input
 * @param {Object} input - Request body
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateInitializeJob(input) {
    const errors = [];

    if (!input) {
        return { valid: false, errors: ['Request body is required'] };
    }

    // Model validation
    if (!input.model || typeof input.model !== 'string') {
        errors.push('Model is required and must be a string');
    } else if (input.model.trim().length === 0) {
        errors.push('Model cannot be empty');
    } else if (input.model.length > 200) {
        errors.push('Model name too long (max 200 characters)');
    }

    // Maker validation
    if (!input.maker || typeof input.maker !== 'string') {
        errors.push('Maker is required and must be a string');
    } else if (input.maker.trim().length === 0) {
        errors.push('Maker cannot be empty');
    } else if (input.maker.length > 200) {
        errors.push('Maker name too long (max 200 characters)');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate CSV data array
 * @param {Array} data - CSV data to validate
 * @returns {Object} - { valid: boolean, error: string|null }
 */
function validateCsvData(data) {
    if (!data) {
        return { valid: false, error: 'Data is required' };
    }

    if (!Array.isArray(data)) {
        return { valid: false, error: 'Data must be an array' };
    }

    if (data.length === 0) {
        return { valid: false, error: 'Data cannot be empty' };
    }

    // Validate each row is an array
    for (let i = 0; i < data.length; i++) {
        if (!Array.isArray(data[i])) {
            return { valid: false, error: `Row ${i} is not an array` };
        }
    }

    // Validate all rows have same column count
    const expectedColumns = data[0].length;
    for (let i = 1; i < data.length; i++) {
        if (data[i].length !== expectedColumns) {
            return {
                valid: false,
                error: `Row ${i} has ${data[i].length} columns, expected ${expectedColumns}`
            };
        }
    }

    return { valid: true, error: null };
}

/**
 * Sanitize string input (prevent injection attacks)
 * @param {string} input - String to sanitize
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} - Sanitized string
 */
function sanitizeString(input, maxLength = 1000) {
    if (typeof input !== 'string') {
        return '';
    }

    // Trim whitespace
    let sanitized = input.trim();

    // Truncate to max length
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }

    // Remove null bytes (common in injection attacks)
    sanitized = sanitized.replaceAll('\0', '');

    return sanitized;
}

module.exports = {
    validateInitializeJob,
    validateCsvData,
    sanitizeString
};
