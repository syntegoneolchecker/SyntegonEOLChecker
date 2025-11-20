const { getStore } = require('@netlify/blobs');

exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        console.log('Parsing request body...');
        const { data } = JSON.parse(event.body);

        if (!data || !Array.isArray(data)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid data format' })
            };
        }

        console.log('Converting data to CSV format...');
        // Convert data back to CSV format
        const csvContent = data.map(row =>
            row.map(cell => `"${cell}"`).join(',')
        ).join('\n');

        // Save to Netlify Blobs
        console.log('Getting Netlify Blobs store...');
        const store = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });
        console.log('Saving to Blobs...');
        await store.set('database.csv', csvContent);
        console.log('Save successful!');

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Data saved successfully',
                rows: data.length
            })
        };
    } catch (error) {
        console.error('Error in save-csv function:', error);
        console.error('Error stack:', error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to save CSV data: ' + error.message,
                stack: error.stack
            })
        };
    }
};
