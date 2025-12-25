/**
 * Log viewer endpoint
 * Retrieves and displays logs from Netlify Blobs
 * Supports filtering by date, source, level, and search term
 * Returns logs sorted chronologically
 */

const { getStore } = require("@netlify/blobs");
const { URLSearchParams } = require("url");
const logger = require("./lib/logger");

// Parameter parsing - separate concern
const parseParams = (params) => ({
    date: params.date,
    source: params.source,
    level: params.level,
    search: params.search,
    days: Math.max(1, Number.parseInt(params.days) || 1),
    format: params.format === "json" ? "json" : "html",
    offset: Math.max(0, Number.parseInt(params.offset) || 0),
    limit: Math.min(1000, Math.max(1, Number.parseInt(params.limit) || 100)),
});

// Date calculation - separate concern
const getDatesToFetch = (specifiedDate, days) => {
    if (specifiedDate) {
        return [specifiedDate];
    }

    const dates = [];
    for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        dates.push(date.toISOString().split("T")[0]);
    }
    return dates;
};

// Log filtering - separate concern with clear predicates
const filterLogs = (logs, filters) => {
    const { source, level, search } = filters;
    let filtered = logs;

    if (source) {
        const sourceLower = source.toLowerCase();
        filtered = filtered.filter((log) =>
            log.source.toLowerCase().includes(sourceLower)
        );
    }

    if (level) {
        const levelUpper = level.toUpperCase();
        filtered = filtered.filter(
            (log) => log.level.toUpperCase() === levelUpper
        );
    }

    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter((log) => {
            const message =
                typeof log.message === "string"
                    ? log.message
                    : JSON.stringify(log.message);
            const context = log.context ? JSON.stringify(log.context) : "";
            return (
                message.toLowerCase().includes(searchLower) ||
                context.toLowerCase().includes(searchLower) ||
                log.source.toLowerCase().includes(searchLower)
            );
        });
    }

    return filtered;
};

// Log fetching - separate concern (parallelized for performance)
const fetchLogsForDates = async (store, dates) => {
    const logPromises = dates.map((dateKey) =>
        fetchLogsForDate(store, dateKey)
    );
    const logsArrays = await Promise.all(logPromises);
    return logsArrays.flat();
};

const fetchLogsForDate = async (store, dateKey) => {
    try {
        const { blobs } = await store.list({ prefix: `logs-${dateKey}-` });
        return await fetchLogBlobs(store, blobs);
    } catch {
        return [];
    }
};

const fetchLogBlobs = async (store, blobs) => {
    const logPromises = blobs.map((blob) =>
        store.get(blob.key, { type: "json" }).catch(() => null)
    );

    const results = await Promise.allSettled(logPromises);
    return results
        .filter((result) => result.status === "fulfilled" && result.value)
        .map((result) => result.value);
};

// Response formatting - separate concern
const formatResponse = (paginatedData, filters, format) => {
    if (format === "json") {
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                {
                    count: paginatedData.logs.length,
                    totalCount: paginatedData.totalCount,
                    offset: paginatedData.offset,
                    limit: paginatedData.limit,
                    hasMore: paginatedData.hasMore,
                    logs: paginatedData.logs,
                },
                null,
                2
            ),
        };
    }

    const html = generateHTML(paginatedData, filters);
    return {
        statusCode: 200,
        headers: { "Content-Type": "text/html" },
        body: html,
    };
};

// Error response - separate concern
const errorResponse = (error) => {
    logger.error("Error viewing logs:", error);
    return {
        statusCode: 500,
        headers: { "Content-Type": "text/plain" },
        body: `Error viewing logs: ${error.message}`,
    };
};

// Main handler - orchestrates the workflow
exports.handler = async (event) => {
    try {
        const params = event.queryStringParameters || {};
        const { date, source, level, search, days, format, offset, limit } =
            parseParams(params);

        const store = getStore({
            name: "logs",
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN,
        });

        const datesToFetch = getDatesToFetch(date, days);
        const allLogs = await fetchLogsForDates(store, datesToFetch);

        const filters = { source, level, search, days };
        const filteredLogs = filterLogs(allLogs, filters);

        // Sort descending (newest first) for pagination
        filteredLogs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        // Apply pagination and reverse each page slice
        // This shows newest logs on page 1, with oldest at top and newest at bottom within each page
        const totalCount = filteredLogs.length;
        const paginatedLogs = filteredLogs
            .slice(offset, offset + limit)
            .reverse();
        const hasMore = offset + limit < totalCount;

        const paginatedData = {
            logs: paginatedLogs,
            totalCount,
            offset,
            limit,
            hasMore,
        };

        return formatResponse(paginatedData, filters, format);
    } catch (error) {
        return errorResponse(error);
    }
};

function generateHTML(paginatedData, filters) {
    const { logs, totalCount, offset, limit, hasMore } = paginatedData;
    const levelColors = {
        DEBUG: "#6c757d",
        INFO: "#0d6efd",
        WARN: "#ffc107",
        ERROR: "#dc3545",
    };

    const logRows = logs
        .map((log) => {
            const color = levelColors[log.level] || "#000";
            // Convert UTC timestamp to GMT+9 (JST)
            const utcDate = new Date(log.timestamp);
            const jstDate = new Date(utcDate);
            const time =
                jstDate.toLocaleString("en-US", {
                    timeZone: "Asia/Tokyo",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                }) + " JST";

            const messageStr =
                typeof log.message === "string"
                    ? log.message
                    : JSON.stringify(log.message);
            const contextStr = log.context
                ? `<pre style="margin: 5px 0 0 0; padding: 8px; background: #f8f9fa; border-radius: 4px; font-size: 12px;">${JSON.stringify(
                      log.context,
                      null,
                      2
                  )}</pre>`
                : "";

            return `
      <tr>
        <td style="white-space: nowrap; font-size: 12px; color: #6c757d;">${time}</td>
        <td style="white-space: nowrap; font-weight: bold; color: ${color};">${
                log.level
            }</td>
        <td style="white-space: nowrap; font-size: 13px;">${log.source}</td>
        <td style="font-family: monospace; font-size: 13px;">
          ${escapeHtml(messageStr)}
          ${contextStr}
        </td>
      </tr>
    `;
        })
        .join("");

    const filterInfo = [];
    if (filters.source) filterInfo.push(`Source: ${filters.source}`);
    if (filters.level) filterInfo.push(`Level: ${filters.level}`);
    if (filters.search) filterInfo.push(`Search: "${filters.search}"`);
    if (filters.days > 1) filterInfo.push(`Last ${filters.days} days`);

    const currentPage = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(totalCount / limit);
    const showingFrom = totalCount > 0 ? offset + 1 : 0;
    const showingTo = Math.min(offset + limit, totalCount);

    // Build query string helper for pagination
    const buildQueryString = (newOffset, newLimit) => {
        const params = new URLSearchParams();
        if (filters.days) params.set("days", filters.days);
        if (filters.source) params.set("source", filters.source);
        if (filters.level) params.set("level", filters.level);
        if (filters.search) params.set("search", filters.search);
        if (newOffset) params.set("offset", newOffset);
        if (newLimit !== 100) params.set("limit", newLimit);
        return params.toString() ? "?" + params.toString() : "?";
    };

    const prevOffset = Math.max(0, offset - limit);
    const nextOffset = offset + limit;
    const prevLink = buildQueryString(prevOffset, limit);
    const nextLink = buildQueryString(nextOffset, limit);

    // Build export JSON link with current filters and pagination
    const exportJsonLink =
        buildQueryString(offset, limit) +
        (buildQueryString(offset, limit).includes("?") ? "&" : "?") +
        "format=json";

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Centralized Logs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      max-width: 90%;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 24px;
    }
    .header h1 {
      font-size: 28px;
      margin-bottom: 8px;
    }
    .header .meta {
      font-size: 14px;
      opacity: 0.9;
    }
    .filters {
      background: #f8f9fa;
      padding: 16px 24px;
      border-bottom: 1px solid #dee2e6;
    }
    .filters form {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: end;
    }
    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .filter-group label {
      font-size: 12px;
      font-weight: 600;
      color: #495057;
      text-transform: uppercase;
    }
    .filter-group input,
    .filter-group select {
      padding: 8px 12px;
      border: 1px solid #ced4da;
      border-radius: 4px;
      font-size: 14px;
    }
    .filter-group button {
      padding: 8px 16px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .filter-group button:hover {
      background: #5568d3;
    }
    .pagination {
      background: #f8f9fa;
      padding: 16px 24px;
      border-bottom: 1px solid #dee2e6;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .pagination-info {
      font-size: 14px;
      color: #495057;
    }
    .pagination-controls {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .pagination-controls button,
    .pagination-controls a {
      padding: 6px 12px;
      background: #fff;
      color: #667eea;
      border: 1px solid #667eea;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    .pagination-controls button:hover,
    .pagination-controls a:hover {
      background: #667eea;
      color: white;
    }
    .pagination-controls button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .pagination-controls button:disabled:hover {
      background: #fff;
      color: #667eea;
    }
    .pagination-controls .current-page {
      padding: 6px 12px;
      background: #667eea;
      color: white;
      border: 1px solid #667eea;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
    }
    .page-size-select {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #495057;
    }
    .page-size-select select {
      padding: 6px 10px;
      border: 1px solid #ced4da;
      border-radius: 4px;
      font-size: 14px;
    }
    .logs-container {
      overflow-x: auto;
      max-height: calc(100vh - 300px);
      overflow-y: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      position: sticky;
      top: 0;
      background: #343a40;
      color: white;
      padding: 12px;
      text-align: left;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      z-index: 10;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #dee2e6;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .empty {
      text-align: center;
      padding: 60px 20px;
      color: #6c757d;
    }
    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Centralized Logs</h1>
      <div class="meta">
        Showing ${showingFrom}-${showingTo} of ${totalCount} log entries
        ${totalPages > 1 ? ` · Page ${currentPage} of ${totalPages}` : ""}
        ${filterInfo.length > 0 ? " · Filtered: " + filterInfo.join(", ") : ""}
      </div>
    </div>

    <div class="filters">
      <form method="GET" onsubmit="resetPagination(event)">
        <input type="hidden" name="offset" id="offset-input" value="${offset}">
        <input type="hidden" name="limit" value="${limit}">
        <div class="filter-group">
          <label>Days</label>
          <input type="number" name="days" value="${
              filters.days || 1
          }" min="1" max="30">
        </div>
        <div class="filter-group">
          <label>Source</label>
          <input type="text" name="source" value="${
              filters.source || ""
          }" placeholder="e.g., netlify, render">
        </div>
        <div class="filter-group">
          <label>Level</label>
          <select name="level">
            <option value="">All</option>
            <option value="DEBUG" ${
                filters.level === "DEBUG" ? "selected" : ""
            }>DEBUG</option>
            <option value="INFO" ${
                filters.level === "INFO" ? "selected" : ""
            }>INFO</option>
            <option value="WARN" ${
                filters.level === "WARN" ? "selected" : ""
            }>WARN</option>
            <option value="ERROR" ${
                filters.level === "ERROR" ? "selected" : ""
            }>ERROR</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Search</label>
          <input type="text" name="search" value="${
              filters.search || ""
          }" placeholder="Search in logs">
        </div>
        <div class="filter-group">
          <button type="submit">Apply Filters</button>
        </div>
        <div class="filter-group">
          <a href="${exportJsonLink}" style="padding: 8px 16px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; font-size: 14px; font-weight: 600;">Export JSON</a>
        </div>
        <div class="filter-group">
          <button type="button" onclick="clearAllLogs()" style="padding: 8px 16px; background: #dc3545; color: white; border: none; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer;">Clear Logs</button>
        </div>
      </form>
    </div>

    <div class="pagination">
      ${
          totalPages > 1
              ? `
      <div class="pagination-info">
        Page ${currentPage} of ${totalPages}
      </div>
      <div class="pagination-controls">
        <a href="${prevLink}" ${
                    offset === 0
                        ? 'style="opacity: 0.5; pointer-events: none;"'
                        : ""
                }>← Previous</a>
        <span class="current-page">${currentPage}</span>
        <a href="${nextLink}" ${
                    !hasMore
                        ? 'style="opacity: 0.5; pointer-events: none;"'
                        : ""
                }>Next →</a>
      </div>
      `
              : "<div></div>"
      }
      <div class="page-size-select">
        <label>Show:</label>
        <select onchange="changePageSize(this.value)">
          <option value="50" ${limit === 50 ? "selected" : ""}>50</option>
          <option value="100" ${limit === 100 ? "selected" : ""}>100</option>
          <option value="250" ${limit === 250 ? "selected" : ""}>250</option>
          <option value="500" ${limit === 500 ? "selected" : ""}>500</option>
        </select>
      </div>
    </div>

    <div class="logs-container">
      ${
          logs.length > 0
              ? `
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Level</th>
              <th>Source</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            ${logRows}
          </tbody>
        </table>
      `
              : `
        <div class="empty">
          <div class="empty-icon">📭</div>
          <h3>No logs found</h3>
          <p>No logs match your current filters or no logs have been generated yet.</p>
        </div>
      `
      }
    </div>
  </div>
  <script>
    // Auto-scroll to bottom on page load to show newest logs first
    window.addEventListener('DOMContentLoaded', function() {
      const logsContainer = document.querySelector('.logs-container');
      if (logsContainer) {
        logsContainer.scrollTop = logsContainer.scrollHeight;
      }
    });

    function resetPagination(event) {
      // Reset offset to 0 when applying new filters
      const offsetInput = document.getElementById('offset-input');
      if (offsetInput) {
        offsetInput.value = '0';
      }
    }

    function changePageSize(newLimit) {
      const url = new URL(window.location);
      url.searchParams.set('limit', newLimit);
      url.searchParams.set('offset', '0'); // Reset to first page when changing page size
      window.location.href = url.toString();
    }

    async function clearAllLogs() {
      if (!confirm('Are you sure you want to delete ALL logs? This action cannot be undone.')) {
        return;
      }

      const button = event.target;
      const originalText = button.textContent;
      button.textContent = 'Clearing...';
      button.disabled = true;

      try {
        const response = await fetch('/.netlify/functions/clear-logs', {
          method: 'POST'
        });

        const result = await response.json();

        if (result.success) {
          alert(\`Successfully cleared \${result.deletedCount} log(s).\`);
          // Reload the page to show empty logs
          window.location.reload();
        } else {
          alert(\`Error clearing logs: \${result.error}\`);
          button.textContent = originalText;
          button.disabled = false;
        }
      } catch (error) {
        alert(\`Error clearing logs: \${error.message}\`);
        button.textContent = originalText;
        button.disabled = false;
      }
    }
  </script>
</body>
</html>
  `;
}

function escapeHtml(text) {
    const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    };
    return text.replaceAll(/[&<>"']/g, (m) => map[m]);
}
