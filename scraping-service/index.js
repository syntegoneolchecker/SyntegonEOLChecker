// Main application entry point
const express = require("express");
const cors = require("cors");

// Import utilities
const {
  getMemoryUsageMB,
  getShutdownState,
  getRequestCount,
  MEMORY_LIMIT_MB,
  MEMORY_WARNING_MB,
} = require("./utils/memory");

const {
  validateEnvironmentVariables,
  validateAllowedOrigins
} = require("./utils/env-validator");

// Import route handlers
const { handleScrapeRequest } = require("./routes/scrape");
const { handleKeyenceScrapeRequest } = require("./routes/scrape-keyence");
const { handleBatchScrapeRequest } = require("./routes/scrape-batch");
const logger = require('./utils/logger');

// Validate environment variables at startup
try {
  validateEnvironmentVariables();
  validateAllowedOrigins();
} catch (error) {
  logger.error('Environment validation failed:', error.message);
  process.exit(1);
}

const app = express();

// Security: Disable X-Powered-By header to prevent framework version disclosure
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;

// Middleware
// Security: Configure CORS to only allow requests from trusted origins
// In production, set ALLOWED_ORIGINS environment variable to your frontend domain
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", "http://localhost:5000"]; // Default for local development

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      if (!allowedOrigins.includes(origin)) {
        const msg =
          "The CORS policy for this site does not allow access from the specified origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    credentials: true, // Allow cookies if needed
  })
);
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  const memory = getMemoryUsageMB();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      limit: MEMORY_LIMIT_MB,
      warning: MEMORY_WARNING_MB,
      percentUsed: Math.round((memory.rss / MEMORY_LIMIT_MB) * 100),
    },
    requestCount: getRequestCount(),
    isShuttingDown: getShutdownState(),
  });
});

// Status endpoint (includes shutdown state)
app.get("/status", (req, res) => {
  const memory = getMemoryUsageMB();
  res.json({
    status: getShutdownState() ? "shutting_down" : "ok",
    requestCount: getRequestCount(),
    memoryMB: memory.rss,
    memoryLimitMB: MEMORY_LIMIT_MB,
    timestamp: new Date().toISOString(),
  });
});

// Middleware: API Key authentication for scraping endpoints
const PROTECTED_ENDPOINTS = ["/scrape", "/scrape-keyence", "/scrape-batch"];

app.use((req, res, next) => {
  // Only protect scraping endpoints, not health/status
  if (!PROTECTED_ENDPOINTS.includes(req.path)) {
    return next();
  }

  const apiKey = req.headers["x-api-key"];
  const expectedKey = process.env.SCRAPING_API_KEY;

  if (!expectedKey) {
    logger.error("SCRAPING_API_KEY not configured - rejecting all scraping requests");
    return res.status(500).json({ error: "Service misconfigured" });
  }

  if (!apiKey || apiKey !== expectedKey) {
    logger.warn(`Unauthorized request to ${req.path} - invalid or missing API key`);
    return res.status(401).json({ error: "Unauthorized - invalid API key" });
  }

  next();
});

// Middleware: Reject new scraping requests during shutdown
app.use((req, res, next) => {
  if (
    getShutdownState() &&
    PROTECTED_ENDPOINTS.includes(req.path)
  ) {
    logger.info(`Rejecting ${req.path} request during shutdown`);
    return res.status(503).json({
      error: "Service restarting",
      retryAfter: 30, // seconds
    });
  }
  next();
});

// Route handlers
app.post("/scrape", handleScrapeRequest);
app.post("/scrape-keyence", handleKeyenceScrapeRequest);
app.post("/scrape-batch", handleBatchScrapeRequest);

// Start server
app.listen(PORT, () => {
  logger.info(`Scraping service running on port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});
