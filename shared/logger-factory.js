/**
 * Shared logger factory
 * Creates a logger instance with centralized logging capabilities
 *
 * Both Netlify Functions and Render service use this factory,
 * each providing their own function source identifier
 */

const LOG_LEVELS = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3,
	NONE: 4
};

// Pre-compiled regex patterns for sanitization
// Using new RegExp() with String.raw to avoid control characters in regex literals (S6324)
const ANSI_ESCAPE_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const CONTROL_CHARS_RE = new RegExp(String.raw`[\x00-\x08\x0B-\x1F\x7F]`, "g");

/**
 * Sanitize string for safe logging (prevents log injection attacks)
 * Removes:
 * - Newline characters (\n, \r) - prevents fake log entry injection
 * - ANSI escape codes - prevents terminal manipulation
 * - Control characters (0x00-0x1F except tab) - prevents other injection attacks
 *
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string safe for logging
 */
function sanitizeForLog(str) {
	if (typeof str !== "string") {
		return str;
	}

	return (
		str
			// Remove ANSI escape codes (e.g., \x1b[31m for colors)
			.replaceAll(ANSI_ESCAPE_RE, "")
			// Replace newlines with escaped versions to prevent log injection
			.replaceAll("\r\n", String.raw`\r\n`)
			.replaceAll("\n", String.raw`\n`)
			.replaceAll("\r", String.raw`\r`)
			// Remove other control characters except tab (0x09)
			.replaceAll(CONTROL_CHARS_RE, "")
	);
}

/**
 * Sanitize an Error object for safe logging
 * Converts to a plain object with sanitized properties
 *
 * @param {Error} error - Error to sanitize
 * @param {WeakSet} seen - Set to track visited objects for cycle detection
 * @returns {Object} Sanitized error as a plain object
 */
function sanitizeErrorForLog(error, seen) {
	const sanitizedError = {
		name: sanitizeForLog(error.name),
		message: sanitizeForLog(error.message),
		stack: sanitizeForLog(error.stack || "")
	};

	// Include any enumerable properties on the error
	for (const key in error) {
		if (Object.hasOwn(error, key)) {
			sanitizedError[key] = sanitizeValueForLog(error[key], seen);
		}
	}

	return sanitizedError;
}

/**
 * Sanitize a plain object for safe logging
 * Sanitizes both keys and values
 *
 * @param {Object} obj - Object to sanitize
 * @param {WeakSet} seen - Set to track visited objects for cycle detection
 * @returns {Object} Sanitized object
 */
function sanitizeObjectForLog(obj, seen) {
	const sanitized = {};
	for (const key in obj) {
		if (Object.hasOwn(obj, key)) {
			const sanitizedKey = sanitizeForLog(String(key));
			sanitized[sanitizedKey] = sanitizeValueForLog(obj[key], seen);
		}
	}
	return sanitized;
}

/**
 * Deep sanitize a value for safe logging
 * Recursively sanitizes all strings in objects and arrays
 * Handles cycles with WeakSet to prevent infinite loops
 *
 * @param {*} value - Value to sanitize
 * @param {WeakSet} seen - Set to track visited objects for cycle detection
 * @returns {*} Sanitized value safe for logging
 */
function sanitizeValueForLog(value, seen = new WeakSet()) {
	// Handle primitives (number, boolean, bigint, symbol, undefined, null)
	if (value === null || value === undefined) {
		return value;
	}

	const type = typeof value;
	if (type === "number" || type === "boolean" || type === "bigint" || type === "symbol") {
		return value;
	}

	// Handle strings
	if (type === "string") {
		return sanitizeForLog(value);
	}

	// Handle functions (return string representation, sanitized)
	if (type === "function") {
		return sanitizeForLog("[Function: " + (value.name || "anonymous") + "]");
	}

	// Handle Errors - convert to plain object with sanitized properties
	if (value instanceof Error) {
		return sanitizeErrorForLog(value, seen);
	}

	// Cycle detection for objects and arrays
	if (type === "object") {
		if (seen.has(value)) {
			return "[Circular Reference]";
		}
		seen.add(value);

		if (Array.isArray(value)) {
			return value.map((item) => sanitizeValueForLog(item, seen));
		}

		return sanitizeObjectForLog(value, seen);
	}

	// Fallback for any other types
	return value;
}

/**
 * Sanitize all arguments for safe logging
 * Returns deeply sanitized copies suitable for console output
 */
function sanitizeArgs(...args) {
	return args.map((arg) => sanitizeValueForLog(arg));
}

/**
 * Format arguments for logging
 * Used for central logging (Supabase)
 *
 * Note: Expects already-sanitized arguments from sanitizeArgs()
 * The sanitization functions are idempotent, so double-sanitization is safe
 */
function formatMessage(...args) {
	return args
		.map((arg) => {
			if (typeof arg === "string") {
				return sanitizeForLog(arg);
			}
			if (arg instanceof Error) {
				// Sanitize error messages and stack traces
				const name = sanitizeForLog(arg.name);
				const message = sanitizeForLog(arg.message);
				const stack = sanitizeForLog(arg.stack || "");
				return `${name}: ${message}\n${stack}`;
			}
			// Sanitize the value deeply before JSON stringifying
			// This ensures no raw tainted strings slip through in objects/arrays
			const sanitized = sanitizeValueForLog(arg);
			return JSON.stringify(sanitized);
		})
		.join(" ");
}

/**
 * Extract context object from arguments
 * Returns a context object safe for central logging
 *
 * Note: Expects already-sanitized arguments from sanitizeArgs()
 * The sanitization functions are idempotent, so double-sanitization is safe
 */
function extractContext(...args) {
	const contextObj = {};
	args.forEach((arg, _index) => {
		if (typeof arg === "object" && arg !== null && !(arg instanceof Error)) {
			Object.assign(contextObj, arg);
		}
	});
	if (Object.keys(contextObj).length === 0) {
		return undefined;
	}
	// Deep sanitize the context to remove any tainted strings
	return sanitizeValueForLog(contextObj);
}

/**
 * Create a logger instance
 *
 * @param {Function} getFunctionSource - Function that returns the source identifier
 * @param {Array<string>} skipSources - Optional list of source identifiers to skip logging for (prevents recursion)
 * @returns {Object} Logger instance with debug, info, warn, error, and getLevel methods
 */
function createLogger(getFunctionSource, skipSources = []) {
	// Get current log level from environment, default to INFO
	const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

	/**
	 * Send log to Supabase PostgreSQL
	 * This is fire-and-forget to avoid blocking the main application
	 * Uses Supabase REST API with publishable API key
	 */
	async function sendToCentralLog(level, message, context) {
		try {
			// Get function source dynamically for each log
			const functionSource = getFunctionSource();

			// Skip logging for specified sources (prevents recursion)
			if (skipSources.some((skip) => functionSource.includes(skip))) {
				return;
			}

			// Check if Supabase is configured
			if (!process.env.SUPABASE_URL || !process.env.SUPABASE_API_KEY) {
				// Silently skip if not configured (allows graceful degradation)
				return;
			}

			const timestamp = new Date().toISOString();
			const logEntry = {
				timestamp,
				level,
				source: functionSource,
				message,
				context: context || null
			};

			// Send to Supabase via REST API - fire and forget (don't await)
			// Note: Only 'apikey' header is needed. The API Gateway handles auth for both
			// legacy keys (anon/service_role) and new keys (sb_secret_/sb_publishable_)
			fetch(`${process.env.SUPABASE_URL}/rest/v1/logs`, {
				method: "POST",
				headers: {
					apikey: process.env.SUPABASE_API_KEY,
					"Content-Type": "application/json",
					Prefer: "return=minimal" // Don't return inserted data (faster)
				},
				body: JSON.stringify(logEntry),
				signal: AbortSignal.timeout(5000) // 5 second timeout
			}).catch(() => {
				// Silently ignore errors in central logging to avoid cascading failures
			});
		} catch {
			// Silently ignore errors in central logging
		}
	}

	return {
		/**
		 * Debug-level logging (most verbose)
		 * Use for detailed diagnostic information
		 */
		debug: (...args) => {
			if (currentLevel <= LOG_LEVELS.DEBUG) {
				const sanitized = sanitizeArgs(...args);
				console.log("[DEBUG]", ...sanitized);
				const message = formatMessage(...sanitized);
				const context = extractContext(...sanitized);
				sendToCentralLog("DEBUG", message, context);
			}
		},

		/**
		 * Info-level logging
		 * Use for general informational messages about application flow
		 */
		info: (...args) => {
			if (currentLevel <= LOG_LEVELS.INFO) {
				const sanitized = sanitizeArgs(...args);
				console.log("[INFO]", ...sanitized);
				const message = formatMessage(...sanitized);
				const context = extractContext(...sanitized);
				sendToCentralLog("INFO", message, context);
			}
		},

		/**
		 * Warning-level logging
		 * Use for potentially harmful situations that aren't errors
		 */
		warn: (...args) => {
			if (currentLevel <= LOG_LEVELS.WARN) {
				const sanitized = sanitizeArgs(...args);
				console.warn("[WARN]", ...sanitized);
				const message = formatMessage(...sanitized);
				const context = extractContext(...sanitized);
				sendToCentralLog("WARN", message, context);
			}
		},

		/**
		 * Error-level logging
		 * Use for error events that might still allow the application to continue
		 */
		error: (...args) => {
			if (currentLevel <= LOG_LEVELS.ERROR) {
				const sanitized = sanitizeArgs(...args);
				console.error("[ERROR]", ...sanitized);
				const message = formatMessage(...sanitized);
				const context = extractContext(...sanitized);
				sendToCentralLog("ERROR", message, context);
			}
		},

		/**
		 * Get current log level
		 * @returns {string} Current log level name
		 */
		getLevel: () => {
			return (
				Object.keys(LOG_LEVELS).find((key) => LOG_LEVELS[key] === currentLevel) || "INFO"
			);
		}
	};
}

module.exports = {
	createLogger,
	LOG_LEVELS
};
