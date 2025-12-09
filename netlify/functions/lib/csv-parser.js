/**
 * Parse CSV content into array of arrays
 * Handles quoted fields properly (e.g., "field with, comma")
 *
 * @param {string} csvContent - Raw CSV content as string
 * @returns {Array<Array<string>>} - Parsed data as 2D array
 */
function parseCSV(csvContent) {
    if (!csvContent) {
        return [];
    }

    const lines = csvContent.split('\n').filter(line => line.trim());

    // Parse CSV data - handle quoted fields properly
    const data = lines.map(line => {
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

        return cells;
    });

    return data;
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
