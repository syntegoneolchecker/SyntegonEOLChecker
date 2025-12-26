const logger = require('./logger');

/**
 * Content truncation utilities for analyze-job
 * Extracts and truncates scraped content while preserving product mentions
 */

const config = require('./config');

/**
 * Process tables in content - mark with delimiters
 * @param {string} content - Raw content with tables
 * @returns {string} Content with table delimiters
 */
function processTablesInContent(content) {
    if (!content) return content;

    const lines = content.split('\n');
    const processedLines = [];
    let inTable = false;
    let tableLines = [];

    for (const element of lines) {
        const line = element;
        const isTableLine = isTableRow(line);
        const isSeparatorLine = isTableSeparator(line);

        if (isTableLine || (inTable && isSeparatorLine)) {
            if (!inTable) {
                processedLines.push('\n=== TABLE START ===');
            }
            inTable = true;
            tableLines.push(line);
            processedLines.push(line);
        } else {
            if (inTable && tableLines.length > 0) {
                processedLines.push('=== TABLE END ===\n');
            }
            inTable = false;
            tableLines = [];
            processedLines.push(line);
        }
    }

    // Handle table that ends at the end of content
    if (inTable && tableLines.length > 0) {
        processedLines.push('=== TABLE END ===\n');
    }

    return processedLines.join('\n');
}

/**
 * Check if a line is a table row
 */
function isTableRow(line) {
    const trimmed = line.trim();
    const pipeCount = (trimmed.match(/\|/g) || []).length;
    return trimmed.includes('|') && pipeCount >= 2;
}

/**
 * Check if a line is a table separator
 */
function isTableSeparator(line) {
    const trimmed = line.trim();
    return /^[\s\-|]+$/.test(trimmed) && trimmed.length > 0;
}

/**
 * Remove tables that don't contain the product model
 * @param {string} content - Content with table delimiters
 * @param {string} productModel - Product model to search for
 * @returns {string} Filtered content
 */
function filterIrrelevantTables(content, productModel) {
    if (!content || !productModel) return content;

    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    const tablesToRemove = [];
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
        const tableContent = match[0];

        if (!tableContent.toLowerCase().includes(productModel.toLowerCase())) {
            tablesToRemove.push({
                content: tableContent,
                start: match.index,
                end: match.index + tableContent.length
            });
        }
    }

    let filteredContent = content;
    for (let i = tablesToRemove.length - 1; i >= 0; i--) {
        const table = tablesToRemove[i];
        filteredContent = filteredContent.substring(0, table.start) +
                         filteredContent.substring(table.end);
    }

    filteredContent = filteredContent.replaceAll(/\n{3,}/g, '\n\n');

    return filteredContent;
}

/**
 * Simple truncation from end at sentence boundary
 */
function simpleTruncate(content, maxLength) {
    let truncated = content.substring(0, maxLength);

    // Try to cut at sentence boundary
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);

    if (cutPoint > maxLength * 0.7) {
        truncated = truncated.substring(0, cutPoint + 1);
    }

    return truncated + '\n\n[Content truncated due to length]';
}

/**
 * Advanced smart truncation that preserves product mentions
 * @param {string} content - Content to truncate
 * @param {number} maxLength - Maximum length in characters
 * @param {string} productModel - Product model to preserve
 * @returns {string} Truncated content
 */
function smartTruncate(content, maxLength, productModel) {
    if (content.length <= maxLength) return content;
    if (!productModel) {
        return simpleTruncate(content, maxLength);
    }

    const productLower = productModel.toLowerCase();
    const contentLower = content.toLowerCase();

    // Check if product name is present in content
    if (!contentLower.includes(productLower)) {
        logger.info(`Product "${productModel}" not found in content, using simple truncation`);
        return simpleTruncate(content, maxLength);
    }

    logger.info(`Product "${productModel}" found in content, using advanced truncation`);

    // Step 1: Process tables (remove non-product tables, truncate product tables)
    let processedContent = truncateTablesWithProduct(content, productModel);

    // Step 2: If still too long, extract product mention sections
    if (processedContent.length > maxLength) {
        processedContent = extractProductSections(processedContent, productModel, maxLength);
    }

    // Step 3: Final check - if STILL too long, hard truncate but preserve first product mention
    if (processedContent.length > maxLength) {
        logger.info(`Content still too long after section extraction, applying final truncation`);
        processedContent = finalTruncate(processedContent, productModel, maxLength);
    }

    return processedContent + '\n\n[Content truncated to preserve product mentions]';
}

/**
 * Truncate tables intelligently (keep product mentions, remove others)
 */
function truncateTablesWithProduct(content, productModel) {
    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    let result = content;
    const tables = [];
    let match;

    // Find all tables
    while ((match = tableRegex.exec(content)) !== null) {
        tables.push({
            content: match[0],
            start: match.index,
            end: match.index + match[0].length
        });
    }

    // Process tables in reverse order (to preserve indices)
    for (let i = tables.length - 1; i >= 0; i--) {
        const table = tables[i];
        const tableContent = table.content;

        if (!tableContent.toLowerCase().includes(productModel.toLowerCase())) {
            continue;
        }

        // Table contains product - truncate to keep only relevant rows
        const truncatedTable = truncateTableRows(tableContent, productModel);

        // Replace original table with truncated version
        result = result.substring(0, table.start) + truncatedTable + result.substring(table.end);
    }

    return result;
}

/**
 * Truncate table to keep only rows around product mentions
 */
function truncateTableRows(tableContent, productModel) {
    const lines = tableContent.split('\n');
    const productLower = productModel.toLowerCase();
    const ROWS_BEFORE = config.TABLE_CONTEXT_ROWS_BEFORE;
    const ROWS_AFTER = config.TABLE_CONTEXT_ROWS_AFTER;

    // Find table boundaries
    let tableStart = -1;
    let tableEnd = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('=== TABLE START ===')) tableStart = i;
        if (lines[i].includes('=== TABLE END ===')) tableEnd = i;
    }

    if (tableStart === -1 || tableEnd === -1) return tableContent;

    // Find rows containing product
    const productRows = [];
    for (let i = tableStart + 1; i < tableEnd; i++) {
        if (lines[i].toLowerCase().includes(productLower)) {
            productRows.push(i);
        }
    }

    if (productRows.length === 0) return tableContent;

    // Determine rows to keep
    const rowsToKeep = new Set();

    // Always keep header row
    if (tableStart + 1 < tableEnd) {
        rowsToKeep.add(tableStart + 1);
    }

    // Keep rows around each product mention
    productRows.forEach(productRow => {
        const startRow = Math.max(tableStart + 1, productRow - ROWS_BEFORE);
        const endRow = Math.min(tableEnd - 1, productRow + ROWS_AFTER);

        for (let i = startRow; i <= endRow; i++) {
            rowsToKeep.add(i);
        }
    });

    // Build truncated table
    const keptLines = [];
    keptLines.push(lines[tableStart]); // TABLE START marker

    let lastKeptRow = tableStart;
    const sortedRows = Array.from(rowsToKeep).sort((a, b) => a - b);

    sortedRows.forEach(row => {
        // Add ellipsis if we skipped rows
        if (row - lastKeptRow > 1) {
            keptLines.push('| ... | ... |');
        }
        keptLines.push(lines[row]);
        lastKeptRow = row;
    });

    keptLines.push(lines[tableEnd]); // TABLE END marker

    logger.info(`Truncated table from ${lines.length} rows to ${keptLines.length} rows`);
    return keptLines.join('\n');
}

/**
 * Extract sections containing product mentions with context
 */
function extractProductSections(content, productModel, maxLength) {
    const CONTEXT_CHARS = config.PRODUCT_MENTION_CONTEXT_CHARS;

    if (!content) return content;

    const contentLower = content.toLowerCase();
    const productLower = productModel.toLowerCase();
    const mentions = [];

    // Find all product mentions
    let index = contentLower.indexOf(productLower);
    while (index !== -1) {
        mentions.push(index);
        index = contentLower.indexOf(productLower, index + 1);
    }

    if (mentions.length === 0) {
        return content.length <= maxLength ? content : content.substring(0, maxLength - 3) + '...';
    }

    logger.info(`Found ${mentions.length} product mentions, extracting sections`);

    // Extract sections with context
    const sections = mentions.map(mentionIndex => {
        const start = Math.max(0, mentionIndex - CONTEXT_CHARS);
        const end = Math.min(content.length, mentionIndex + productModel.length + CONTEXT_CHARS);

        let section = content.substring(start, end);
        if (start > 0) section = '...' + section;
        if (end < content.length) section = section + '...';

        return section;
    });

    const combined = sections.join('\n\n[...]\n\n');

    // If combined is still too long, prioritize first mentions
    if (combined.length > maxLength) {
        let result = '';
        for (const section of sections) {
            if (result.length + section.length + 20 > maxLength) {
                break;
            }
            if (result.length > 0) {
                result += '\n\n[...]\n\n';
            }
            result += section;
        }
        return result;
    }

    return combined;
}

/**
 * Final hard truncation while preserving first product mention
 */
function finalTruncate(content, productModel, maxLength) {
    const productLower = productModel.toLowerCase();
    const contentLower = content.toLowerCase();
    const firstMention = contentLower.indexOf(productLower);

    if (firstMention === -1 || firstMention > maxLength) {
        return simpleTruncate(content, maxLength);
    }

    // Keep content centered around first mention
    const CONTEXT = 200;
    const start = Math.max(0, firstMention - CONTEXT);
    const end = Math.min(content.length, start + maxLength);

    let result = content.substring(start, end);
    if (start > 0) result = '...' + result;
    if (end < content.length) result = result + '...';

    return result;
}

module.exports = {
    processTablesInContent,
    filterIrrelevantTables,
    smartTruncate
};
