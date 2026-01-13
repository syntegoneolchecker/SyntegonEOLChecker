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

    // Progressive removal strategy - Step 1: Truncate tables
    let processedContent = truncateTablesWithProduct(content, productModel);
    logger.info(`After table truncation: ${processedContent.length} chars (target: ${maxLength})`);

    if (processedContent.length <= maxLength) {
        return processedContent;
    }

    // Step 2: Remove excessive whitespace
    processedContent = processedContent.replace(/\n{4,}/g, '\n\n');
    processedContent = processedContent.replace(/ {3,}/g, ' ');
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
    processedContent = removeDistantContent(processedContent, productModel, maxLength);
    logger.info(`After zone extraction: ${processedContent.length} chars`);

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

/**
 * Remove common boilerplate patterns from content
 * @param {string} content - Content to clean
 * @returns {string} Content with boilerplate removed
 */
function removeBoilerplate(content) {
    if (!content) return content;

    // Common boilerplate patterns (case-insensitive)
    const boilerplatePatterns = [
        // Navigation and menu items
        /^(Home|About|Contact|Products|Services|Support|FAQ|Login|Register|Cart|Checkout)[\s\|]*$/gim,
        // Copyright notices
        /Copyright\s*©?\s*\d{4}.*?(\n|$)/gi,
        /All rights reserved.*?(\n|$)/gi,
        // Cookie notices (common phrases)
        /This (site|website) uses cookies.*?(\n|$)/gi,
        /By continuing to use.*?cookies.*?(\n|$)/gi,
        // Social media links
        /^(Facebook|Twitter|LinkedIn|Instagram|YouTube|Follow us)[\s\|]*$/gim,
        // Generic footer text
        /^(Terms|Privacy|Sitemap|Accessibility)[\s\|]*$/gim,
        // Repeated navigation separators
        /^[\s\|>-]{3,}$/gm
    ];

    let cleaned = content;
    boilerplatePatterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
    });

    // Remove excessive blank lines that might result from removal
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned;
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

    // Comprehensive list of important keywords
    const IMPORTANT_KEYWORDS = [
        // Japanese - Discontinuation/End of Life
        '受注終了', '生産終了', '販売終了', '生産中止', '製造中止',
        '取り扱い終了', '供給終了', '出荷終了', '廃番', '廃止',

        // Japanese - Replacement/Successor
        '代替品', '代替製品', '後継品', '後継機種', '後継モデル',
        '推奨代替', '代替機種', '切替', '新製品', '新型',

        // Japanese - Status/Availability
        '在庫', '在庫あり', '在庫なし', '納期', '納入', '出荷',
        '受注可能', '販売中', '発売中', '標準価格', '価格',
        'お届け', '配送', '入荷', '欠品', '品薄',

        // Japanese - Lifecycle
        'ライフサイクル', '製品寿命', 'サポート終了', '保守終了',

        // English - Discontinuation/End of Life
        'discontinued', 'discontinuation', 'end of life', 'EOL',
        'end of sales', 'end of production', 'obsolete', 'obsoleted',
        'no longer available', 'no longer manufactured', 'no longer produced',
        'phased out', 'phase out', 'withdrawn', 'ceased production',

        // English - Replacement/Successor
        'replacement', 'successor', 'alternative', 'substitute',
        'recommended replacement', 'replaced by', 'superseded by',
        'new model', 'upgraded to', 'migration', 'transition',

        // English - Status/Availability
        'stock', 'in stock', 'out of stock', 'availability', 'available',
        'not available', 'delivery', 'lead time', 'shipping',
        'price', 'pricing', 'cost', 'order', 'purchase',
        'backorder', 'back order', 'pre-order', 'reserve',

        // English - Lifecycle
        'lifecycle', 'life cycle', 'product lifecycle', 'support end',
        'maintenance end', 'last time buy', 'last order date',

        // Common date patterns that might indicate EOL dates
        '2019/03', '2020/', '2021/', '2022/', '2023/', '2024/', '2025/',

        // Product series indicators (for OMRON example)
        'S8VM', 'specifications', 'spec', 'datasheet', 'catalog',
        'lineup', 'series', 'family', 'model', 'type',

        // Document section headers
        'notice', 'announcement', 'update', 'information',
        'お知らせ', '告知', '案内', 'ニュース', '情報'
    ];

    // Find all important positions (product mentions + keywords)
    const importantPositions = [];
    const contentLower = content.toLowerCase();
    const productLower = productModel.toLowerCase();

    // Find product mentions
    let idx = contentLower.indexOf(productLower);
    while (idx !== -1) {
        importantPositions.push({ pos: idx, type: 'product' });
        idx = contentLower.indexOf(productLower, idx + 1);
    }

    // Find keyword mentions
    IMPORTANT_KEYWORDS.forEach(keyword => {
        let idx = contentLower.indexOf(keyword.toLowerCase());
        while (idx !== -1) {
            importantPositions.push({ pos: idx, type: 'keyword', keyword: keyword });
            idx = contentLower.indexOf(keyword.toLowerCase(), idx + 1);
        }
    });

    if (importantPositions.length === 0) {
        // No important positions found, fall back to simple truncation
        return content.length <= maxLength ? content : content.substring(0, maxLength - 3) + '...';
    }

    logger.info(`Found ${importantPositions.length} important positions (product mentions and keywords)`);

    // Create zones around important positions
    const ZONE_RADIUS = 1500; // 1.5k chars around each important point
    const zones = importantPositions.map(item => ({
        start: Math.max(0, item.pos - ZONE_RADIUS),
        end: Math.min(content.length, item.pos + ZONE_RADIUS),
        type: item.type
    }));

    // Merge overlapping zones while maintaining order
    const mergedZones = mergeOverlappingSections(zones);
    logger.info(`Merged into ${mergedZones.length} zones`);

    // Extract zones in order, respecting the maxLength limit
    let result = '';
    let firstZone = true;

    for (const zone of mergedZones) {
        const zoneText = content.substring(zone.start, zone.end);
        const separator = firstZone ? '' : '\n\n[...]\n\n';
        const ellipsisBefore = zone.start > 0 ? '...' : '';
        const ellipsisAfter = zone.end < content.length ? '...' : '';

        const fullZoneText = separator + ellipsisBefore + zoneText + ellipsisAfter;

        // Check if adding this zone would exceed limit
        if (result.length + fullZoneText.length > maxLength) {
            // Try to fit partial zone if it's the first zone or we have room
            const remaining = maxLength - result.length;
            if (remaining > 500) { // Only if we can fit meaningful content
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
        const last = merged[merged.length - 1];

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
