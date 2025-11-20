const { getStore } = require('@netlify/blobs');

exports.handler = async function(event, context) {
    try {
        console.log('Getting Netlify Blobs store...');
        const store = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // Try to get the CSV data from Netlify Blobs
        console.log('Fetching database.csv from Blobs...');
        let csvContent = await store.get('database.csv');
        console.log('Blob fetch result:', csvContent ? 'Data found' : 'No data (empty store)');

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
        console.error('Error in get-csv function:', error);
        console.error('Error stack:', error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to read CSV data: ' + error.message,
                stack: error.stack
            })
        };
    }
};
