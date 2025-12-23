// Main application entry point
const express = require("express");
const cors = require("cors");

// Import utilities
const {
  getMemoryUsageMB,
  getShutdownState,
  getRequestCount,
  getMemoryHistory,
  MEMORY_LIMIT_MB,
  MEMORY_WARNING_MB,
} = require("./utils/memory");

// Import route handlers
const { handleScrapeRequest } = require("./routes/scrape");
const { handleKeyenceScrapeRequest } = require("./routes/scrape-keyence");
const { handleIdecDualScrapeRequest } = require("./routes/scrape-idec-dual");
const { handleBatchScrapeRequest } = require("./routes/scrape-batch");

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

      if (allowedOrigins.includes(origin) === -1) {
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

// Middleware: Reject new scraping requests during shutdown
app.use((req, res, next) => {
  if (
    getShutdownState() &&
    [
      "/scrape",
      "/scrape-keyence",
      "/scrape-idec-dual",
      "/scrape-batch",
    ].includes(req.path)
  ) {
    console.log(`Rejecting ${req.path} request during shutdown`);
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
app.post("/scrape-idec-dual", handleIdecDualScrapeRequest);
app.post("/scrape-batch", handleBatchScrapeRequest);

// Start server
app.listen(PORT, () => {
  console.log(`Scraping service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
