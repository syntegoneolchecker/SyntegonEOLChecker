/**
 * Log viewer endpoint
 * Retrieves and displays logs from Netlify Blobs
 * Supports filtering by date, source, level, and search term
 * Returns logs sorted chronologically
 */

import { getStore } from '@netlify/blobs';

export const handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const date = params.date; // YYYY-MM-DD format, defaults to today
    const source = params.source; // 'netlify' or 'render' or specific function name
    const level = params.level; // 'DEBUG', 'INFO', 'WARN', 'ERROR'
    const search = params.search; // Search term in message
    const days = parseInt(params.days || '1'); // Number of days to fetch (default: 1)
    const format = params.format || 'html'; // 'html' or 'json'

    // Get the logs store
    const store = getStore({
      name: 'logs',
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });

    // Determine which date(s) to fetch
    const datesToFetch = [];
    if (date) {
      // Specific date requested
      datesToFetch.push(date);
    } else {
      // Fetch last N days
      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        datesToFetch.push(d.toISOString().split('T')[0]);
      }
    }

    // Fetch all logs from requested dates
    let allLogs = [];
    for (const dateKey of datesToFetch) {
      const logKey = `logs-${dateKey}.jsonl`;
      try {
        const logsContent = await store.get(logKey, { type: 'text' });
        if (logsContent) {
          // Parse each line as JSON
          const lines = logsContent.trim().split('\n');
          const parsedLogs = lines
            .filter(line => line.trim())
            .map(line => {
              try {
                return JSON.parse(line);
              } catch (e) {
                return null;
              }
            })
            .filter(log => log !== null);
          allLogs = allLogs.concat(parsedLogs);
        }
      } catch (err) {
        // Log file doesn't exist for this date, skip
        continue;
      }
    }

    // Apply filters
    let filteredLogs = allLogs;

    if (source) {
      filteredLogs = filteredLogs.filter(log =>
        log.source.toLowerCase().includes(source.toLowerCase())
      );
    }

    if (level) {
      filteredLogs = filteredLogs.filter(log =>
        log.level.toUpperCase() === level.toUpperCase()
      );
    }

    if (search) {
      filteredLogs = filteredLogs.filter(log =>
        JSON.stringify(log).toLowerCase().includes(search.toLowerCase())
      );
    }

    // Sort chronologically (oldest first)
    filteredLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Return based on format
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

    // HTML format
    const html = generateHTML(filteredLogs, { source, level, search, days });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: html
    };
  } catch (error) {
    console.error('Error viewing logs:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: `Error viewing logs: ${error.message}`
    };
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
    const jstDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000));
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
  return text.replace(/[&<>"']/g, m => map[m]);
}
