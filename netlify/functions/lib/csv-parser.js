const logger = require('./logger');

/**
 * Parse a single CSV line into an array of cell values.
 * Handles quoted fields properly (e.g., "field with, comma")
 *
 * @param {string} line - A single CSV line
 * @returns {{ cells: Array<string>, hasUnclosedQuote: boolean }}
 */
function parseLine(line) {
    const cells = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"' && !inQuotes) {
            inQuotes = true;
        } else if (char === '"' && inQuotes && nextChar === '"') {
            current += '"';
            i++; // Skip next quote
        } else if (char === '"' && inQuotes) {
            inQuotes = false;
        } else if (char === ',' && !inQuotes) {
            cells.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current.trim()); // Add last cell

    return { cells, hasUnclosedQuote: inQuotes };
}

/**
 * Validate that all rows have the same number of columns.
 *
 * @param {Array<Array<string>>} data - Parsed CSV rows
 * @returns {string|null} Error message if inconsistent, null otherwise
 */
function validateColumnConsistency(data) {
    if (data.length <= 1) {
        return null;
    }

    const expectedColumns = data[0].length;
    const inconsistentRows = [];

    for (let i = 1; i < data.length; i++) {
        if (data[i].length !== expectedColumns) {
            inconsistentRows.push(i + 1);
        }
    }

    if (inconsistentRows.length > 0) {
        return (
            `Column count mismatch: Expected ${expectedColumns} columns, ` +
            `but rows [${inconsistentRows.join(', ')}] have different counts`
        );
    }

    return null;
}

/**
 * Parse CSV content into array of arrays
 * Handles quoted fields properly (e.g., "field with, comma")
 *
 * @param {string} csvContent - Raw CSV content as string
 * @returns {Object} - {success: boolean, data: Array<Array<string>>, error: string|null}
 * @throws {Error} If CSV is malformed beyond recovery
 */
function parseCSV(csvContent) {
    try {
        if (!csvContent) {
            return { success: true, data: [], error: null };
        }

        if (typeof csvContent !== 'string') {
            return {
                success: false,
                data: [],
                error: `Invalid CSV content type: expected string, got ${typeof csvContent}`
            };
        }

        const lines = csvContent.split('\n').filter(line => line.trim());

        if (lines.length === 0) {
            return { success: true, data: [], error: null };
        }

        const data = [];
        const errors = [];

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const { cells, hasUnclosedQuote } = parseLine(lines[lineNum]);

            if (hasUnclosedQuote) {
                errors.push(`Line ${lineNum + 1}: Unclosed quote detected`);
            }

            data.push(cells);
        }

        const consistencyError = validateColumnConsistency(data);
        if (consistencyError) {
            errors.push(consistencyError);
        }

        // Return with warnings if there were non-fatal errors
        if (errors.length > 0) {
            logger.warn('CSV parsing warnings:', errors);
            return {
                success: true, // Still return data, but with warnings
                data: data,
                error: errors.join('; ')
            };
        }

        return { success: true, data: data, error: null };

    } catch (error) {
        logger.error('CSV parsing error:', error);
        return {
            success: false,
            data: [],
            error: `CSV parsing failed: ${error.message}`
        };
    }
}

/**
 * Convert array of arrays to CSV string
 * Quotes all fields to handle commas and special characters
 *
 * @param {Array<Array<string>>} data - 2D array of data
 * @returns {string} - CSV string
 */
function toCSV(data) {
    if (!data || !Array.isArray(data)) {
        return '';
    }

    return data.map(row =>
        row.map(cell => `"${cell}"`).join(',')
    ).join('\n');
}

module.exports = {
    parseCSV,
    toCSV
};
