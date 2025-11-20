const { getStore } = require('@netlify/blobs');

exports.handler = async function(event, context) {
    try {
        const store = getStore('eol-database');

        // Try to get the CSV data from Netlify Blobs
        let csvContent = await store.get('database.csv');

        // If no data exists yet, return default headers
        if (!csvContent) {
            const defaultData = [['Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment']];
            return {
                statusCode: 200,
                body: JSON.stringify({ data: defaultData })
            };
        }

        const lines = csvContent.split('\n').filter(line => line.trim());

        // Parse CSV data - handle quoted fields properly
        const data = lines.map(line => {
            // Simple CSV parser for quoted fields
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

        return {
            statusCode: 200,
            body: JSON.stringify({ data: data })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to read CSV data: ' + error.message
            })
        };
    }
};
