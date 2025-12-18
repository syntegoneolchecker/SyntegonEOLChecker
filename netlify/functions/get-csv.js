const { getStore } = require('@netlify/blobs');
const { parseCSV } = require('./lib/csv-parser');

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

        // If no data exists yet, return default headers (13 columns)
        if (!csvContent) {
            const defaultData = [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']];
            return {
                statusCode: 200,
                body: JSON.stringify({ data: defaultData })
            };
        }

        // Parse CSV data using shared utility
        const parseResult = parseCSV(csvContent);

        if (!parseResult.success) {
            console.error('CSV parsing failed:', parseResult.error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'CSV parsing failed',
                    details: parseResult.error
                })
            };
        }

        // Log warnings if present (non-fatal errors)
        if (parseResult.error) {
            console.warn('CSV parsing completed with warnings:', parseResult.error);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                data: parseResult.data,
                warnings: parseResult.error || null
            })
        };
    } catch (error) {
        console.error('Error in get-csv function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to read CSV data: ' + error.message
            })
        };
    }
};
