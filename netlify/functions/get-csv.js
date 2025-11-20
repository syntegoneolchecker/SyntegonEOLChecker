const fs = require('fs');
const path = require('path');

exports.handler = async function(event, context) {
    try {
        // Read the database.csv file
        const filePath = path.join(process.cwd(), 'database.csv');
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            // Return empty data if file doesn't exist
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    data: [['Col1', 'Col2', 'Col3', 'Col4', 'Col5', 'Col6', 'Col7']] 
                })
            };
        }

        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n').filter(line => line.trim());
        
        // Parse CSV data
        const data = lines.map(line => 
            line.split(',').map(cell => cell.replace(/^"|"$/g, '').trim())
        );

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
