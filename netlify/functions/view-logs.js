/**
 * Log viewer endpoint
 * Retrieves and displays logs from Netlify Blobs
 * Supports filtering by date, source, level, and search term
 * Returns logs sorted chronologically
 */

const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');

// Parameter parsing - separate concern
const parseParams = (params) => ({
  date: params.date,
  source: params.source,
  level: params.level,
  search: params.search,
  days: Math.max(1, Number.parseInt(params.days) || 1),
  format: params.format === 'json' ? 'json' : 'html'
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
    dates.push(date.toISOString().split('T')[0]);
  }
  return dates;
};

// Log filtering - separate concern with clear predicates
const filterLogs = (logs, filters) => {
  const { source, level, search } = filters;
  let filtered = logs;

  if (source) {
    const sourceLower = source.toLowerCase();
    filtered = filtered.filter(log =>
      log.source.toLowerCase().includes(sourceLower)
    );
  }

  if (level) {
    const levelUpper = level.toUpperCase();
    filtered = filtered.filter(log =>
      log.level.toUpperCase() === levelUpper
    );
  }

  if (search) {
    const searchLower = search.toLowerCase();
    filtered = filtered.filter(log =>
      JSON.stringify(log).toLowerCase().includes(searchLower)
    );
  }

  return filtered;
};

// Log fetching - separate concern
const fetchLogsForDates = async (store, dates) => {
  const allLogs = [];

  for (const dateKey of dates) {
    const dateLogs = await fetchLogsForDate(store, dateKey);
    allLogs.push(...dateLogs);
  }

  return allLogs;
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
  const logPromises = blobs.map(blob =>
    store.get(blob.key, { type: 'json' }).catch(() => null)
  );

  const results = await Promise.allSettled(logPromises);
  return results
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);
};

// Response formatting - separate concern
const formatResponse = (filteredLogs, filters, format) => {
  if (format === 'json') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: filteredLogs.length,
        logs: filteredLogs
      }, null, 2)
    };
  }

  const html = generateHTML(filteredLogs, filters);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: html
  };
};

// Error response - separate concern
const errorResponse = (error) => {
  logger.error('Error viewing logs:', error);
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'text/plain' },
    body: `Error viewing logs: ${error.message}`
  };
};

// Main handler - orchestrates the workflow
exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const { date, source, level, search, days, format } = parseParams(params);

    const store = getStore({
      name: 'logs',
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });

    const datesToFetch = getDatesToFetch(date, days);
    const allLogs = await fetchLogsForDates(store, datesToFetch);

    const filters = { source, level, search, days };
    const filteredLogs = filterLogs(allLogs, filters);

    filteredLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return formatResponse(filteredLogs, filters, format);
  } catch (error) {
    return errorResponse(error);
  }
};

function generateHTML(logs, filters) {
  const levelColors = {
    DEBUG: '#6c757d',
    INFO: '#0d6efd',
    WARN: '#ffc107',
    ERROR: '#dc3545'
  };

  const logRows = logs.map(log => {
    const color = levelColors[log.level] || '#000';
    // Convert UTC timestamp to GMT+9 (JST)
    const utcDate = new Date(log.timestamp);
    const jstDate = new Date(utcDate);
    const time = jstDate.toLocaleString('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }) + ' JST';

    const messageStr = typeof log.message === 'string'
      ? log.message
      : JSON.stringify(log.message);
    const contextStr = log.context
      ? `<pre style="margin: 5px 0 0 0; padding: 8px; background: #f8f9fa; border-radius: 4px; font-size: 12px;">${JSON.stringify(log.context, null, 2)}</pre>`
      : '';

    return `
      <tr>
        <td style="white-space: nowrap; font-size: 12px; color: #6c757d;">${time}</td>
        <td style="white-space: nowrap; font-weight: bold; color: ${color};">${log.level}</td>
        <td style="white-space: nowrap; font-size: 13px;">${log.source}</td>
        <td style="font-family: monospace; font-size: 13px;">
          ${escapeHtml(messageStr)}
          ${contextStr}
        </td>
      </tr>
    `;
  }).join('');

  const filterInfo = [];
  if (filters.source) filterInfo.push(`Source: ${filters.source}`);
  if (filters.level) filterInfo.push(`Level: ${filters.level}`);
  if (filters.search) filterInfo.push(`Search: "${filters.search}"`);
  if (filters.days > 1) filterInfo.push(`Last ${filters.days} days`);

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
        ${logs.length} log entries
        ${filterInfo.length > 0 ? ' · Filtered: ' + filterInfo.join(', ') : ''}
      </div>
    </div>

    <div class="filters">
      <form method="GET">
        <div class="filter-group">
          <label>Days</label>
          <input type="number" name="days" value="${filters.days || 1}" min="1" max="30">
        </div>
        <div class="filter-group">
          <label>Source</label>
          <input type="text" name="source" value="${filters.source || ''}" placeholder="e.g., netlify, render">
        </div>
        <div class="filter-group">
          <label>Level</label>
          <select name="level">
            <option value="">All</option>
            <option value="DEBUG" ${filters.level === 'DEBUG' ? 'selected' : ''}>DEBUG</option>
            <option value="INFO" ${filters.level === 'INFO' ? 'selected' : ''}>INFO</option>
            <option value="WARN" ${filters.level === 'WARN' ? 'selected' : ''}>WARN</option>
            <option value="ERROR" ${filters.level === 'ERROR' ? 'selected' : ''}>ERROR</option>
          </select>
        </div>
        <div class="filter-group">
          <label>Search</label>
          <input type="text" name="search" value="${filters.search || ''}" placeholder="Search in logs">
        </div>
        <div class="filter-group">
          <button type="submit">Apply Filters</button>
        </div>
        <div class="filter-group">
          <a href="?format=json${filters.days ? '&days=' + filters.days : ''}" style="padding: 8px 16px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; font-size: 14px; font-weight: 600;">Export JSON</a>
        </div>
        <div class="filter-group">
          <button type="button" onclick="clearAllLogs()" style="padding: 8px 16px; background: #dc3545; color: white; border: none; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer;">Clear Logs</button>
        </div>
      </form>
    </div>

    <div class="logs-container">
      ${logs.length > 0 ? `
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
      ` : `
        <div class="empty">
          <div class="empty-icon">📭</div>
          <h3>No logs found</h3>
          <p>No logs match your current filters or no logs have been generated yet.</p>
        </div>
      `}
    </div>
  </div>
  <script>
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
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replaceAll(/[&<>"']/g, m => map[m]);
}
