const { getStore } = require('@netlify/blobs');
const { toCSV } = require('./lib/csv-parser');
const { validateCsvData } = require('./lib/validators');
const config = require('./lib/config');
const logger = require('./lib/logger');

exports.handler = async function(event, _context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        logger.info('Parsing request body...');
        const requestBody = JSON.parse(event.body);

        // Validate request body has 'data' field
        if (!requestBody?.data) {
            logger.error('Missing data field in request body');
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Request body must contain a "data" field' })
            };
        }

        const { data } = requestBody;

        // Validate CSV data structure
        const validation = validateCsvData(data);
        if (!validation.valid) {
            logger.error('CSV validation failed:', validation.error);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: validation.error })
            };
        }

        // Validate column count matches expected schema (13 columns)
        if (data.length > 0 && data[0].length !== config.CSV_COLUMN_COUNT) {
            const error = `Invalid column count: expected ${config.CSV_COLUMN_COUNT} columns, got ${data[0].length}`;
            logger.error(error);
            return {
                statusCode: 400,
                body: JSON.stringify({ error })
            };
        }

        logger.info('Converting data to CSV format...');
        // Convert data back to CSV format using shared utility
        const csvContent = toCSV(data);

        // Save to Netlify Blobs
        logger.info('Getting Netlify Blobs store...');
        const store = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });
        logger.info('Saving to Blobs...');
        await store.set('database.csv', csvContent);
        logger.info('Save successful!');

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Data saved successfully',
                rows: data.length
            })
        };
    } catch (error) {
        logger.error('Error in save-csv function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to save CSV data: ' + error.message
            })
        };
    }
};
