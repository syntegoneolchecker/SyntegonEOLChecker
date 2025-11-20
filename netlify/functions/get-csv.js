const fs = require('fs');
const path = require('path');

exports.handler = async function(event, context) {
    try {
        // In Netlify Functions, files are in the parent directories
        // Try multiple possible paths
        const possiblePaths = [
            path.join(process.cwd(), 'database.csv'),
            path.join(process.cwd(), '..', '..', 'database.csv'),
            path.join(__dirname, '..', '..', '..', 'database.csv'),
            '/var/task/database.csv'
        ];

        let filePath = null;
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                filePath = p;
                break;
            }
        }

        if (!filePath) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: 'database.csv not found',
                    searchedPaths: possiblePaths,
                    cwd: process.cwd(),
                    dirname: __dirname
                })
            };
        }

        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n').filter(line => line.trim());

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
                error: 'Failed to read CSV file: ' + error.message
            })
        };
    }
};
