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

        // Save to database.csv file
        const filePath = path.join(process.cwd(), 'database.csv');
        fs.writeFileSync(filePath, csvContent, 'utf8');

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: 'Data saved successfully',
                rows: data.length 
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
