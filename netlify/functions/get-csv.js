const { getStore } = require('@netlify/blobs');
const { parseCSV } = require('./lib/csv-parser');
const logger = require('./lib/logger');
const { requireAuth } = require('./lib/auth-middleware');

const getCsvHandler = async function(_event, _context) {
    try {
        logger.info('Getting Netlify Blobs store...');
        const store = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // Try to get the CSV data from Netlify Blobs
        logger.info('Fetching database.csv from Blobs...');
        const csvContent = await store.get('database.csv');
        logger.info('Blob fetch result:', csvContent ? 'Data found' : 'No data (empty store)');

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
            logger.error('CSV parsing failed:', parseResult.error);
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
            logger.warn('CSV parsing completed with warnings:', parseResult.error);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                data: parseResult.data,
                warnings: parseResult.error || null
            })
        };
    } catch (error) {
        logger.error('Error in get-csv function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to read CSV data: ' + error.message
            })
        };
    }
};

// Protect with authentication
exports.handler = requireAuth(getCsvHandler);
