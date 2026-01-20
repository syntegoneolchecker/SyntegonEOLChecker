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
 * Find all tables in content and mark which contain the product model
 */
function findAllTables(content, productModel) {
    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    const tables = [];
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
        const tableContent = match[0];
        tables.push({
            content: tableContent,
            start: match.index,
            end: match.index + tableContent.length,
            containsProduct: tableContent.toLowerCase().includes(productModel.toLowerCase())
        });
    }

    return tables;
}

/**
 * Check if a table at given index is adjacent to a product table
 */
function isAdjacentToProductTable(tables, tableIndex, productTableIndex, threshold) {
    const table = tables[tableIndex];
    const productTable = tables[productTableIndex];

    const gap = tableIndex < productTableIndex
        ? productTable.start - table.end
        : table.start - productTable.end;

    return gap <= threshold;
}

/**
 * Determine which tables to keep (product tables and their adjacent tables)
 */
function determineTablesToKeep(tables, adjacentThreshold) {
    const tablesToKeep = new Set();

    tables.forEach((table, i) => {
        if (!table.containsProduct) {
            return;
        }

        tablesToKeep.add(i);

        // Check previous table
        if (i > 0 && isAdjacentToProductTable(tables, i - 1, i, adjacentThreshold)) {
            tablesToKeep.add(i - 1);
            logger.debug(`Keeping table ${i - 1} as adjacent (before) to product table ${i}`);
        }

        // Check next table
        if (i < tables.length - 1 && isAdjacentToProductTable(tables, i + 1, i, adjacentThreshold)) {
            tablesToKeep.add(i + 1);
            logger.debug(`Keeping table ${i + 1} as adjacent (after) to product table ${i}`);
        }
    });

    return tablesToKeep;
}

/**
 * Remove specified tables from content (in reverse order to preserve indices)
 */
function removeTablesFromContent(content, tablesToRemove) {
    let result = content;

    for (let i = tablesToRemove.length - 1; i >= 0; i--) {
        const table = tablesToRemove[i];
        result = result.substring(0, table.start) + result.substring(table.end);
    }

    return result.replaceAll(/\n{3,}/g, '\n\n');
}

/**
 * Remove tables that don't contain the product model and aren't adjacent to product tables
 * Adjacent tables (within ADJACENT_TABLE_THRESHOLD chars) are kept as they often contain
 * related product info like pricing, delivery dates, or specifications
 * @param {string} content - Content with table delimiters
 * @param {string} productModel - Product model to search for
 * @returns {string} Filtered content
 */
function filterIrrelevantTables(content, productModel) {
    if (!content || !productModel) return content;

    const ADJACENT_TABLE_THRESHOLD = 200;
    const allTables = findAllTables(content, productModel);

    if (allTables.length === 0) {
        return content;
    }

    const tablesToKeep = determineTablesToKeep(allTables, ADJACENT_TABLE_THRESHOLD);
    const tablesToRemove = allTables.filter((_, index) => !tablesToKeep.has(index));

    if (tablesToRemove.length === 0) {
        return content;
    }

    logger.debug(`filterIrrelevantTables: kept ${tablesToKeep.size}/${allTables.length} tables, removed ${tablesToRemove.length}`);
    return removeTablesFromContent(content, tablesToRemove);
}

/**
 * Simple truncation from end at sentence boundary
 */
function simpleTruncate(content, maxLength) {
    const TRUNCATION_MSG = '\n\n[Content truncated due to length]';
    const targetLength = maxLength - TRUNCATION_MSG.length;

    let truncated = content.substring(0, targetLength);

    // Try to cut at sentence boundary
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);

    if (cutPoint > targetLength * 0.7) {
        truncated = truncated.substring(0, cutPoint + 1);
    }

    return truncated + TRUNCATION_MSG;
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

    // Progressive removal strategy - Step 1: Truncate tables
    let processedContent = truncateTablesWithProduct(content, productModel);
    logger.info(`After table truncation: ${processedContent.length} chars (target: ${maxLength})`);

    if (processedContent.length <= maxLength) {
        return processedContent;
    }

    // Step 2: Remove excessive whitespace
    processedContent = processedContent.replaceAll(/\n{4,}/g, '\n\n');
    processedContent = processedContent.replaceAll(/ {3,}/g, ' ');
    logger.info(`After whitespace removal: ${processedContent.length} chars`);

    if (processedContent.length <= maxLength) {
        return processedContent;
    }

    // Step 3: Remove boilerplate patterns (footers, nav, etc.)
    processedContent = removeBoilerplate(processedContent);
    logger.info(`After boilerplate removal: ${processedContent.length} chars`);

    if (processedContent.length <= maxLength) {
        return processedContent;
    }

    // Step 4: Remove content far from important areas
    // Reserve space for truncation message (50 chars)
    const TRUNCATION_MSG = '\n\n[Content truncated to preserve product mentions]';
    processedContent = removeDistantContent(processedContent, productModel, maxLength - TRUNCATION_MSG.length);
    logger.info(`After zone extraction: ${processedContent.length} chars`);

    // Final safety check: ensure we're within the limit (accounting for truncation message)
    if (processedContent.length + TRUNCATION_MSG.length > maxLength) {
        logger.warn(`Content still over limit after all stages (${processedContent.length + TRUNCATION_MSG.length} > ${maxLength}), applying hard truncation`);
        processedContent = processedContent.substring(0, maxLength - TRUNCATION_MSG.length);
    }

    return processedContent + TRUNCATION_MSG;
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
 * Remove common boilerplate patterns from content
 * @param {string} content - Content to clean
 * @returns {string} Content with boilerplate removed
 */
function removeBoilerplate(content) {
    if (!content) return content;

    // Common boilerplate patterns (case-insensitive)
    const RE2 = require('re2');

    const boilerplatePatterns = [
        // Navigation and menu items
        new RE2(String.raw`^(Home|About|Contact|Products|Services|Support|FAQ|Login|Register|Cart|Checkout)[\s|]*$`, 'gim'),
        // Copyright notices
        new RE2(String.raw`Copyright\s*©?\s*\d{4}.*?(\n|$)`, 'gi'),
        new RE2(String.raw`All rights reserved.*?(\n|$)`, 'gi'),
        // Cookie notices (common phrases)
        new RE2(String.raw`This (site|website) uses cookies.*?(\n|$)`, 'gi'),
        new RE2(String.raw`By continuing to use.*?cookies.*?(\n|$)`, 'gi'),
        // Social media links
        new RE2(String.raw`^(Facebook|Twitter|LinkedIn|Instagram|YouTube|Follow us)[\s|]*$`, 'gim'),
        // Generic footer text
        new RE2(String.raw`^(Terms|Privacy|Sitemap|Accessibility)[\s|]*$`, 'gim'),
        // Repeated navigation separators
        new RE2(String.raw`^[\s|>-]{3,}$`, 'gm')
    ];


    let cleaned = content;
    boilerplatePatterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
    });

    // Remove excessive blank lines that might result from removal
    cleaned = cleaned.replaceAll(/\n{3,}/g, '\n\n');

    return cleaned;
}

// HIGH-CONFIDENCE EOL keywords only - removed generic terms that appear everywhere
const IMPORTANT_KEYWORDS = [
    // Japanese - Discontinuation/End of Life (high confidence)
    '受注終了', '生産終了', '販売終了', '生産中止', '製造中止',
    '供給終了', '出荷終了', '廃番', '廃止',
    // Japanese - Replacement/Successor (high confidence)
    '代替品', '後継品', '後継機種', '推奨代替',
    // English - Discontinuation/End of Life (high confidence)
    'discontinued', 'end of life', 'EOL',
    'end of sales', 'obsolete',
    'no longer available', 'phased out',
    // English - Replacement/Successor (high confidence)
    'replacement', 'successor', 'replaced by', 'superseded by',
    // Lifecycle indicators
    'last time buy', 'last order date'
];

/**
 * Find all product mention positions in content
 */
function findProductPositions(contentLower, productLower) {
    const positions = [];
    let idx = contentLower.indexOf(productLower);
    while (idx !== -1) {
        positions.push({ pos: idx, type: 'product', priority: 1 });
        idx = contentLower.indexOf(productLower, idx + 1);
    }
    return positions;
}

/**
 * Find keyword positions with frequency limiting
 */
function findKeywordPositions(contentLower, maxOccurrences = 3, maxTotal = 20) {
    const positions = [];
    let totalCount = 0;

    for (const keyword of IMPORTANT_KEYWORDS) {
        if (totalCount >= maxTotal) break;

        let occurrences = 0;
        let idx = contentLower.indexOf(keyword.toLowerCase());
        while (idx !== -1 && occurrences < maxOccurrences && totalCount < maxTotal) {
            positions.push({ pos: idx, type: 'keyword', keyword: keyword, priority: 2 });
            occurrences++;
            totalCount++;
            idx = contentLower.indexOf(keyword.toLowerCase(), idx + 1);
        }
    }
    return positions;
}

/**
 * Calculate adaptive zone radius based on number of positions
 */
function calculateZoneRadius(positionCount, maxLength) {
    const estimatedMergedZones = Math.max(1, Math.floor(positionCount / 3));
    const separatorOverhead = estimatedMergedZones * 15;
    const availableSpace = maxLength - separatorOverhead - 100;
    const idealZoneSize = availableSpace / estimatedMergedZones;
    return {
        radius: Math.max(400, Math.min(2000, Math.floor(idealZoneSize / 2))),
        estimatedZones: estimatedMergedZones
    };
}

/**
 * Extract zone content with proper ellipses and separators
 */
function extractZoneContent(content, mergedZones, maxLength) {
    let result = '';
    let firstZone = true;

    for (const zone of mergedZones) {
        const zoneText = content.substring(zone.start, zone.end);
        const separator = firstZone ? '' : '\n\n[...]\n\n';
        const ellipsisBefore = zone.start > 0 ? '...' : '';
        const ellipsisAfter = zone.end < content.length ? '...' : '';

        const fullZoneText = separator + ellipsisBefore + zoneText + ellipsisAfter;

        if (result.length + fullZoneText.length > maxLength) {
            const remaining = maxLength - result.length;
            if (remaining > 500) {
                const partialZone = zoneText.substring(0, remaining - separator.length - 50);
                result += separator + ellipsisBefore + partialZone + '...';
            }
            break;
        }

        result += fullZoneText;
        firstZone = false;
    }

    return result;
}

/**
 * Remove content far from important areas (zones around product and keywords)
 * @param {string} content - Content to truncate
 * @param {string} productModel - Product model to preserve
 * @param {number} maxLength - Maximum length in characters
 * @returns {string} Content with distant areas removed
 */
function removeDistantContent(content, productModel, maxLength) {
    if (!content || !productModel) return content;

    const contentLower = content.toLowerCase();
    const productLower = productModel.toLowerCase();

    // Find all important positions
    const productPositions = findProductPositions(contentLower, productLower);
    const keywordPositions = findKeywordPositions(contentLower);
    const importantPositions = [...productPositions, ...keywordPositions];

    if (importantPositions.length === 0) {
        logger.info('No important positions found, truncating from end');
        if (content.length <= maxLength) return content;
        return content.substring(0, maxLength - 50) + '\n\n[Content truncated]';
    }

    logger.info(`Found ${importantPositions.length} important positions (${productPositions.length} product mentions, ${keywordPositions.length} keywords)`);

    // Calculate adaptive zone radius
    const { radius: ZONE_RADIUS, estimatedZones } = calculateZoneRadius(importantPositions.length, maxLength);
    logger.info(`Using adaptive zone radius: ${ZONE_RADIUS} chars (estimated ${estimatedZones} zones after merging)`);

    // Create and merge zones
    const zones = importantPositions.map(item => ({
        start: Math.max(0, item.pos - ZONE_RADIUS),
        end: Math.min(content.length, item.pos + ZONE_RADIUS),
        type: item.type
    }));
    const mergedZones = mergeOverlappingSections(zones);
    logger.info(`Merged into ${mergedZones.length} zones`);

    return extractZoneContent(content, mergedZones, maxLength);
}

/**
 * Merge overlapping sections while maintaining order
 * @param {Array} sections - Array of {start, end} objects
 * @returns {Array} Merged sections in original order
 */
function mergeOverlappingSections(sections) {
    if (!sections || sections.length === 0) return [];

    // Sort by start position (maintains left-to-right order)
    const sorted = [...sections].sort((a, b) => a.start - b.start);

    const merged = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const last = merged.at(-1);

        // Check if current overlaps with last merged section
        if (current.start <= last.end) {
            // Merge: extend the end if current goes further
            last.end = Math.max(last.end, current.end);
        } else {
            // No overlap: add as new section
            merged.push(current);
        }
    }

    return merged;
}

module.exports = {
    processTablesInContent,
    filterIrrelevantTables,
    smartTruncate
};
