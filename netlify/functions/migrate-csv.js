const { getStore } = require('@netlify/blobs');
const fs = require('fs');
const path = require('path');

exports.handler = async function(event, context) {
    try {
        // Try to read the existing database.csv from the static files
        const possiblePaths = [
            path.join(process.cwd(), 'database.csv'),
            path.join(process.cwd(), '..', '..', 'database.csv'),
            path.join(__dirname, '..', '..', '..', 'database.csv'),
            '/var/task/database.csv'
        ];

        let csvContent = null;
        let foundPath = null;

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                csvContent = fs.readFileSync(p, 'utf8');
                foundPath = p;
                break;
            }
        }

        if (!csvContent) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: 'database.csv not found in any location',
                    searchedPaths: possiblePaths
                })
            };
        }

        // Save to Netlify Blobs
        const store = getStore('eol-database');
        await store.set('database.csv', csvContent);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Migration successful! Data has been copied to Netlify Blobs.',
                source: foundPath,
                dataSize: csvContent.length
            })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Migration failed: ' + error.message
            })
        };
    }
};
