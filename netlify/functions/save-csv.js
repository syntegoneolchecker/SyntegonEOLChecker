const fs = require('fs');
const path = require('path');

exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { data } = JSON.parse(event.body);

        if (!data || !Array.isArray(data)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid data format' })
            };
        }

        // Convert data back to CSV format
        const csvContent = data.map(row =>
            row.map(cell => `"${cell}"`).join(',')
        ).join('\n');

        // In Netlify Functions, try multiple possible paths
        const possiblePaths = [
            path.join(process.cwd(), 'database.csv'),
            path.join(process.cwd(), '..', '..', 'database.csv'),
            path.join(__dirname, '..', '..', '..', 'database.csv'),
            '/var/task/database.csv'
        ];

        // Find existing file or use first path
        let filePath = possiblePaths[0];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                filePath = p;
                break;
            }
        }

        fs.writeFileSync(filePath, csvContent, 'utf8');

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Data saved successfully',
                rows: data.length,
                path: filePath
            })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to save CSV file: ' + error.message
            })
        };
    }
};
