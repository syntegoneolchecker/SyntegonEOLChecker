const { getStore } = require('@netlify/blobs');
const { toCSV } = require('./lib/csv-parser');
const { validateCsvData } = require('./lib/validators');

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

        // Validate CSV data
        const validation = validateCsvData(data);
        if (!validation.valid) {
            console.error('CSV validation failed:', validation.error);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: validation.error })
            };
        }

        console.log('Converting data to CSV format...');
        // Convert data back to CSV format using shared utility
        const csvContent = toCSV(data);

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
