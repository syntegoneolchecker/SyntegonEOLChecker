// Background function for automatic EOL checking (chains itself)
// Checks ONE product and triggers next check if counter < MAX_AUTO_CHECKS_PER_DAY
const { getStore } = require("@netlify/blobs");
const { parseCSV, toCSV } = require("./lib/csv-parser");
const logger = require("./lib/logger");
const config = require("./lib/config");
const { requireHybridAuth } = require("./lib/auth-middleware");

// Helper: Get internal API key header for authenticated internal calls
function getInternalAuthHeaders() {
	const headers = { "Content-Type": "application/json" };
	if (process.env.INTERNAL_API_KEY) {
		headers["x-internal-key"] = process.env.INTERNAL_API_KEY;
	}
	return headers;
}

// Helper: Get current date in GMT+9 timezone
function getGMT9Date() {
	const now = new Date();
	const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	return gmt9Time.toISOString().split("T")[0];
}

// Helper: Get current date and time in GMT+9 timezone (formatted like manual checks)
function getGMT9DateTime() {
	const now = new Date();
	// Use Asia/Tokyo timezone to match GMT+9
	return now.toLocaleString("en-GB", { timeZone: "Asia/Tokyo" });
}

// Helper: Wake up Render scraping service (cold start)
// Tries for up to 5 minutes with health checks every 15 seconds
// Increased from former 2 minutes with health checks every 30 seconds to increase stability
async function wakeRenderService() {
	logger.info("Waking up Render scraping service...");
	const overallStartTime = Date.now();
	const maxDuration = 300000; // 5 minutes total
	const healthCheckInterval = 15000; // Check every 15 seconds
	let attempt = 0;

	while (Date.now() - overallStartTime < maxDuration) {
		attempt++;
		const attemptStartTime = Date.now();

		try {
			logger.info(
				`Health check attempt ${attempt} (elapsed: ${((Date.now() - overallStartTime) / 1000).toFixed(1)}s)...`
			);

			const scrapingServiceUrl =
				process.env.SCRAPING_SERVICE_URL || config.DEFAULT_SCRAPING_SERVICE_URL;
			const response = await fetch(`${scrapingServiceUrl}/health`, {
				signal: AbortSignal.timeout(healthCheckInterval)
			});

			if (response.ok) {
				const elapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);
				logger.info(
					`✓ Render service responded successfully in ${elapsed}s (attempt ${attempt})`
				);
				return true;
			}

			logger.warn(`Attempt ${attempt} returned HTTP ${response.status}, will retry...`);
		} catch (error) {
			const elapsed = ((Date.now() - attemptStartTime) / 1000).toFixed(1);
			logger.warn(`Attempt ${attempt} failed after ${elapsed}s: ${error.message}`);
		}

		// Wait before next attempt (unless we've exceeded total duration)
		const remainingTime = maxDuration - (Date.now() - overallStartTime);
		if (remainingTime > 0) {
			const waitTime = Math.min(healthCheckInterval, remainingTime);
			logger.info(`Waiting ${(waitTime / 1000).toFixed(1)}s before next health check...`);
			await new Promise((resolve) => setTimeout(resolve, waitTime));
		}
	}

	const totalElapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);
	logger.error(`❌ Failed to wake Render service after ${totalElapsed}s (${attempt} attempts)`);
	return false;
}

// Helper: Check if Groq tokens are ready (N/A means fully reset)
async function waitForGroqTokens(siteUrl) {
	try {
		const response = await fetch(`${siteUrl}/.netlify/functions/get-groq-usage`, {
			headers: getInternalAuthHeaders()
		});
		if (!response.ok) return; // Assume OK if can't check

		const data = await response.json();

		// Check if resetSeconds is null or undefined (means N/A)
		if (data.resetSeconds === null || data.resetSeconds === undefined) {
			logger.info("Groq tokens fully reset (N/A)");
			return;
		}

		// Wait for reset if needed
		if (data.resetSeconds > 0) {
			logger.info(`Groq tokens reset in ${data.resetSeconds}s, waiting...`);
			await new Promise((resolve) => setTimeout(resolve, (data.resetSeconds + 1) * 1000));
			logger.info("Groq tokens should be reset now");
			return;
		}

		return true;
	} catch (error) {
		logger.error("Error checking Groq tokens:", error.message);
		return; // Proceed anyway
	}
}

// Helper: Check if Auto Check is enabled for a product row
function isAutoCheckEnabled(row) {
	const autoCheckValue = (row[12] || "").trim().toUpperCase();

	// Auto Check column (column 12):
	// - "NO": disabled (skip this product)
	return autoCheckValue !== "NO";
}

// Helper: Check if product has a final EOL status that won't change
// DISCONTINUED products should not be re-checked as their status is permanent
function hasFinalEOLStatus(row) {
	const eolStatus = (row[5] || "").trim().toUpperCase();

	// EOL Status column (column 5):
	// - "DISCONTINUED": product is discontinued, status won't change
	return eolStatus === "DISCONTINUED";
}

// Helper: Find next product to check
async function findNextProduct() {
	try {
		// Get database
		const csvStore = getStore({
			name: "eol-database",
			siteID: process.env.SITE_ID,
			token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
		});
		const csvContent = await csvStore.get("database.csv");

		if (!csvContent) {
			logger.info("No products in database");
			return null;
		}

		// Parse CSV using shared utility
		const parseResult = parseCSV(csvContent);

		if (!parseResult.success) {
			logger.error("CSV parsing failed:", parseResult.error);
			throw new Error(`CSV parsing failed: ${parseResult.error}`);
		}

		if (parseResult.error) {
			logger.warn("CSV parsing warnings:", parseResult.error);
		}

		const data = parseResult.data;

		if (data.length <= 1) {
			logger.info("No products in database (only headers)");
			return null;
		}

		const rows = data.slice(1); // Skip header

		// Filter out products with Auto Check = NO
		const autoCheckEnabledRows = rows.filter((row) => isAutoCheckEnabled(row));

		if (autoCheckEnabledRows.length === 0) {
			logger.info("No products with Auto Check enabled");
			return null;
		}

		// Filter out products with final EOL status (DISCONTINUED)
		// These products have a permanent status that won't change
		const checkableRows = autoCheckEnabledRows.filter((row) => !hasFinalEOLStatus(row));
		const discontinuedCount = autoCheckEnabledRows.length - checkableRows.length;

		if (checkableRows.length === 0) {
			logger.info(
				"No products to check (all are either Auto Check disabled or DISCONTINUED)"
			);
			return null;
		}

		logger.info(
			`Total products: ${rows.length}, Auto Check enabled: ${autoCheckEnabledRows.length}, DISCONTINUED (skipped): ${discontinuedCount}, Checkable: ${checkableRows.length}`
		);

		// Priority 1: Products with empty Information Date (column 11)
		const unchecked = checkableRows.filter((row) => !row[11] || row[11].trim() === "");
		if (unchecked.length > 0) {
			logger.info(
				`Found ${unchecked.length} unchecked products (checkable), selecting first`
			);
			return unchecked[0];
		}

		// Priority 2: Product with oldest Information Date
		const checked = checkableRows.filter((row) => row[11] && row[11].trim() !== "");
		if (checked.length === 0) {
			logger.info("All checkable products checked, no oldest found");
			return null;
		}

		// Sort by date (oldest first)
		checked.sort((a, b) => {
			const dateA = new Date(a[11]);
			const dateB = new Date(b[11]);
			return dateA - dateB;
		});

		logger.info(
			`Found ${checked.length} checked products (checkable), selecting oldest: ${checked[0][11]}`
		);
		return checked[0];
	} catch (error) {
		logger.error("Error finding next product:", error);
		return null;
	}
}

// Helper: Execute EOL check for a product
async function executeEOLCheck(product, siteUrl) {
	const model = product[3]; // Column 3
	const manufacturer = product[4]; // Column 4
	const sapNumber = product[0]; // Column 0

	logger.info(`Executing EOL check for: ${manufacturer} ${model} (SAP: ${sapNumber})`);

	if (!model || !manufacturer) {
		const missingModelOrManufacturer = model ? "manufacturer" : "model";
		const missingField =
			!model && !manufacturer ? "manufacturer/model" : missingModelOrManufacturer;
		logger.info(`Missing ${missingField}, disabling Auto Check for this product`);

		// Disable Auto Check and update database with explanation
		await disableAutoCheckForMissingData(sapNumber, missingField);

		return "skipped";
	}

	try {
		logger.info(`Using site URL: ${siteUrl}`);

		// Initialize job
		const initUrl = `${siteUrl}/.netlify/functions/initialize-job`;
		logger.info(`Calling initialize-job at: ${initUrl}`);

		const initResponse = await fetch(initUrl, {
			method: "POST",
			headers: getInternalAuthHeaders(),
			body: JSON.stringify({ model, maker: manufacturer })
		});

		if (!initResponse.ok) {
			const errorText = await initResponse.text();
			logger.error("Job initialization failed:", initResponse.status, errorText);
			return false;
		}

		const initData = await initResponse.json();
		const jobId = initData.jobId;

		if (!jobId) {
			logger.error("No job ID received");
			return false;
		}

		logger.info(`Job initialized: ${jobId}`);

		// Poll for completion (max 60 attempts = 2 minutes)
		const result = await pollJobStatus(jobId, manufacturer, model, siteUrl);

		if (!result) {
			logger.error("Job polling failed");
			return false;
		}

		// Update the product in database
		await updateProduct(sapNumber, result);

		logger.info(`✓ EOL check completed for ${manufacturer} ${model}`);
		return true;
	} catch (error) {
		logger.error("EOL check error:", error);
		return false;
	}
}

// Helper: Poll job by checking Blobs directly and orchestrating workflow
async function pollJobStatus(jobId, manufacturer, model, siteUrl) {
	const poller = new JobPoller(jobId, manufacturer, model, siteUrl);
	return poller.poll();
}

class JobPoller {
	constructor(jobId, manufacturer, model, siteUrl) {
		this.jobId = jobId;
		this.manufacturer = manufacturer;
		this.model = model;
		this.siteUrl = siteUrl;

		this.maxAttempts = 60;
		this.attempts = 0;
		this.analyzeTriggered = false;
		this.fetchTriggered = false;
		this.completionResult = null; // Store result when job completes

		this.initializeStorage();
	}

	initializeStorage() {
		const { getStore } = require("@netlify/blobs");
		const { updateJobStatus } = require("./lib/job-storage");

		this.jobStore = getStore({
			name: "eol-jobs",
			siteID: process.env.SITE_ID,
			token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
		});
		this.updateJobStatus = updateJobStatus;
	}

	async poll() {
		logger.info(`Polling job ${this.jobId} (max ${this.maxAttempts} attempts, 2 minutes)`);

		while (this.attempts < this.maxAttempts && !this.completionResult) {
			this.attempts++;
			await this.pollAttempt();
		}

		// Return result if job completed, otherwise return timeout
		if (this.completionResult) {
			return this.completionResult;
		}

		return this.handleTimeout();
	}

	async pollAttempt() {
		this.logProgress();
		await this.checkRenderHealthIfNeeded();

		try {
			const job = await this.jobStore.get(this.jobId, { type: "json" });

			if (!job) {
				await this.handleMissingJob();
				await this.waitForNextPoll();
				return;
			}

			// Check for job completion
			const completionResult = await this.handleJobCompletion(job);
			if (completionResult) {
				this.completionResult = completionResult;
				return; // Exit immediately without waiting (loop will break)
			}

			// Check for job error
			const errorResult = await this.handleJobError(job);
			if (errorResult) {
				this.completionResult = errorResult;
				return; // Exit immediately without waiting (loop will break)
			}

			await this.orchestrateWorkflow(job);
		} catch (error) {
			await this.handlePollingError(error);
		}

		// Always wait 2 seconds before next poll (if not completed)
		if (!this.completionResult) {
			await this.waitForNextPoll();
		}
	}

	logProgress() {
		if (this.attempts % 30 === 0) {
			const elapsedMinutes = Math.round((this.attempts * 2) / 60);
			logger.info(
				`Polling attempt ${this.attempts}/${this.maxAttempts} (~${elapsedMinutes} min elapsed)...`
			);
		}
	}

	async checkRenderHealthIfNeeded() {
		if (this.attempts !== 15) return;

		logger.info("Polling attempt 15/60 (~30s elapsed) - checking Render service health...");

		try {
			await this.performHealthCheck();
		} catch (healthError) {
			await this.handleHealthCheckFailure(healthError);
		}
	}

	async performHealthCheck() {
		const scrapingServiceUrl =
			process.env.SCRAPING_SERVICE_URL || config.DEFAULT_SCRAPING_SERVICE_URL;
		const healthResponse = await fetch(`${scrapingServiceUrl}/health`, {
			signal: AbortSignal.timeout(5000)
		});

		if (!healthResponse.ok) {
			throw new Error(`Render service unhealthy (HTTP ${healthResponse.status})`);
		}

		const healthData = await healthResponse.json();
		logger.info(
			`✓ Render service healthy (memory: ${healthData.memory?.rss || "N/A"}MB, requests: ${healthData.requestCount || "N/A"})`
		);
	}

	async handleHealthCheckFailure(error) {
		logger.error(`⚠️  Render health check failed at attempt 15: ${error.message}`);
		logger.info("Assuming Render crashed. Skipping this check to save time.");

		const healthCheckError = new Error("Render health check failed");
		healthCheckError.isHealthCheckFailure = true;
		healthCheckError.result = {
			status: "UNKNOWN",
			explanation:
				"EOL check skipped - scraping service appears to have crashed (health check failed at 30s). This product will be retried on the next check cycle.",
			successor: { status: "UNKNOWN", model: null, explanation: "" }
		};

		throw healthCheckError;
	}

	async handleMissingJob() {
		logger.error(`Job ${this.jobId} not found in Blobs storage`);
		await this.waitForNextPoll();
	}

	async handleJobCompletion(job) {
		if (job.status === "complete" && job.finalResult) {
			const elapsedMinutes = Math.round((this.attempts * 2) / 60);
			logger.info(`✓ Job complete after ${this.attempts} attempts (~${elapsedMinutes} min)`);
			return job.finalResult;
		}
		return null;
	}

	async handleJobError(job) {
		if (job.status === "error") {
			logger.error(`Job failed with error: ${job.error}`);
			return {
				status: "UNKNOWN",
				explanation: `Job failed: ${job.error}`,
				successor: { status: "UNKNOWN", model: null, explanation: "" }
			};
		}
		return null;
	}

	async orchestrateWorkflow(job) {
		await this.triggerFetchIfNeeded(job);
		await this.triggerAnalysisIfNeeded(job);
	}

	async triggerFetchIfNeeded(job) {
		if (job.status === "urls_ready" && !this.fetchTriggered) {
			await this.triggerFetchUrl(job);
			this.fetchTriggered = true;
		}
	}

	async triggerFetchUrl(job) {
		logger.info(`✓ URLs ready, triggering fetch-url (attempt ${this.attempts})`);

		await this.updateJobStatus(this.jobId, "fetching", null, {});

		const firstUrl = job.urls[0];
		if (!firstUrl) return;

		try {
			await this.fireFetchUrlRequest(firstUrl);
			logger.info(`✓ fetch-url triggered for ${firstUrl.url}`);
		} catch (error) {
			logger.error(`Error triggering fetch-url: ${error.message}`);
		}
	}

	async fireFetchUrlRequest(firstUrl) {
		const fetchUrl = `${this.siteUrl}/.netlify/functions/fetch-url`;
		const payload = this.buildFetchPayload(firstUrl);

		// Fire-and-forget
		fetch(fetchUrl, {
			method: "POST",
			headers: getInternalAuthHeaders(),
			body: JSON.stringify(payload)
		}).catch((err) => {
			logger.error(`Failed to trigger fetch-url: ${err.message}`);
		});
	}

	buildFetchPayload(firstUrl) {
		const payload = {
			jobId: this.jobId,
			urlIndex: firstUrl.index,
			url: firstUrl.url,
			title: firstUrl.title,
			snippet: firstUrl.snippet,
			scrapingMethod: firstUrl.scrapingMethod
		};

		if (firstUrl.model) {
			payload.model = firstUrl.model;
		}

		return payload;
	}

	async triggerAnalysisIfNeeded(job) {
		const allUrlsComplete =
			job.urls && job.urls.length > 0 && job.urls.every((u) => u.status === "complete");

		const shouldTriggerAnalysis =
			allUrlsComplete &&
			!this.analyzeTriggered &&
			job.status !== "analyzing" &&
			job.status !== "complete";

		if (shouldTriggerAnalysis) {
			await this.triggerAnalyzeJob();
			this.analyzeTriggered = true;
		}
	}

	async triggerAnalyzeJob() {
		logger.info(
			`✓ All URLs scraped, triggering analyze-job synchronously (attempt ${this.attempts})`
		);

		try {
			const result = await this.callAnalyzeJob();

			if (result) {
				logger.info(`✓ Analysis completed successfully: ${result.status}`);
				return result;
			}
		} catch (error) {
			this.handleAnalyzeJobError(error);
		}
	}

	async callAnalyzeJob() {
		const analyzeUrl = `${this.siteUrl}/.netlify/functions/analyze-job`;
		const analyzeResponse = await fetch(analyzeUrl, {
			method: "POST",
			headers: getInternalAuthHeaders(),
			body: JSON.stringify({ jobId: this.jobId }),
			signal: AbortSignal.timeout(25000)
		});

		if (!analyzeResponse.ok) {
			const errorText = await analyzeResponse.text().catch(() => "Unknown error");
			throw new Error(`analyze-job failed: ${analyzeResponse.status} - ${errorText}`);
		}

		const analyzeData = await analyzeResponse.json();
		await this.checkJobCompletionAfterAnalysis();

		return analyzeData.result;
	}

	async checkJobCompletionAfterAnalysis() {
		const updatedJob = await this.jobStore.get(this.jobId, { type: "json" });
		if (updatedJob?.status === "complete" && updatedJob.finalResult) {
			logger.info(`✓ Job complete after analysis`);
			return updatedJob.finalResult;
		}
		return null;
	}

	handleAnalyzeJobError(error) {
		if (error.name === "TimeoutError" || error.message.includes("timeout")) {
			logger.warn(
				`analyze-job timed out after 25s (likely Groq token wait), will check on next poll`
			);
		} else {
			logger.error(`analyze-job error: ${error.message}`);
		}
	}

	async handlePollingError(error) {
		if (error.isHealthCheckFailure) {
			throw error.result;
		}

		logger.error(`Polling error (attempt ${this.attempts}): ${error.message}`);
		await this.waitForNextPoll();
	}

	async waitForNextPoll() {
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	handleTimeout() {
		const timeoutMinutes = Math.round((this.maxAttempts * 2) / 60);
		logger.error(
			`⏱️  Job ${this.jobId} timed out after ${this.maxAttempts} attempts (~${timeoutMinutes} minutes)`
		);

		return {
			status: "UNKNOWN",
			explanation: `EOL check timed out after ${timeoutMinutes} minutes. The job may still be processing. Check Netlify function logs for details.`,
			successor: { status: "UNKNOWN", model: null, explanation: "" }
		};
	}
}

// Helper: Update product in database
async function updateProduct(sapNumber, result) {
	try {
		const csvStore = getStore({
			name: "eol-database",
			siteID: process.env.SITE_ID,
			token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
		});
		const csvContent = await csvStore.get("database.csv");

		if (!csvContent) {
			logger.error("Database not found");
			return;
		}

		// Parse CSV using shared utility
		const parseResult = parseCSV(csvContent);

		if (!parseResult.success) {
			logger.error("CSV parsing failed during product update:", parseResult.error);
			throw new Error(`CSV parsing failed: ${parseResult.error}`);
		}

		const data = parseResult.data;

		// Find product by SAP number
		const rowIndex = data.findIndex((row, i) => i > 0 && row[0] === sapNumber);

		if (rowIndex === -1) {
			logger.error(`Product ${sapNumber} not found in database`);
			return;
		}

		const row = data[rowIndex];

		// Update columns
		row[5] = result.status || "UNKNOWN"; // Status
		row[6] = result.explanation || ""; // Status Comment
		row[7] = result.successor?.model || ""; // Successor Model
		row[8] = result.successor?.explanation || ""; // Successor Comment
		row[11] = getGMT9DateTime(); // Information Date (GMT+9 to match manual checks)

		// Convert back to CSV using shared utility
		const updatedCsv = toCSV(data);

		// Save updated database
		await csvStore.set("database.csv", updatedCsv);

		logger.info(`Database updated for ${sapNumber}`);
	} catch (error) {
		logger.error("Error updating product:", error);
	}
}

// Helper: Disable Auto Check for product with missing manufacturer/model
async function disableAutoCheckForMissingData(sapNumber, missingField) {
	try {
		logger.info(`Disabling Auto Check for ${sapNumber} (missing ${missingField})`);

		const csvStore = getStore({
			name: "eol-database",
			siteID: process.env.SITE_ID,
			token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
		});
		const csvContent = await csvStore.get("database.csv");

		if (!csvContent) {
			logger.error("Database not found");
			return;
		}

		logger.info("Database retrieved, parsing CSV...");

		// Parse CSV using shared utility
		const parseResult = parseCSV(csvContent);

		if (!parseResult.success) {
			logger.error("CSV parsing failed during Auto Check disable:", parseResult.error);
			throw new Error(`CSV parsing failed: ${parseResult.error}`);
		}

		const data = parseResult.data;
		logger.info(`CSV parsed, total rows: ${data.length}`);

		// Find product by SAP number
		const rowIndex = data.findIndex((row, i) => i > 0 && row[0] === sapNumber);

		if (rowIndex === -1) {
			logger.error(`Product ${sapNumber} not found in database`);
			return;
		}

		logger.info(`Found product at row index ${rowIndex}`);
		const row = data[rowIndex];

		logger.info(
			`Before update - Auto Check (col 12): "${row[12]}", Status Comment (col 6): "${row[6]}"`
		);

		// Update columns
		row[6] = `Auto Check disabled: Missing ${missingField} information`; // Status Comment
		row[11] = getGMT9DateTime(); // Information Date (GMT+9)
		row[12] = "NO"; // Auto Check disabled

		logger.info(
			`After update - Auto Check (col 12): "${row[12]}", Status Comment (col 6): "${row[6]}"`
		);

		// Convert back to CSV using shared utility
		const updatedCsv = toCSV(data);
		logger.info(`CSV converted, length: ${updatedCsv.length} bytes`);

		// Save updated database
		await csvStore.set("database.csv", updatedCsv);
		logger.info("Database saved to Blobs storage");

		logger.info(`✓ Auto Check disabled for ${sapNumber} (missing ${missingField})`);
	} catch (error) {
		logger.error("Error disabling Auto Check:", error);
		throw error; // Re-throw to ensure error is visible
	}
}

// Main handler
const autoEolCheckBackgroundHandler = async function (event, _context) {
	logger.info("=".repeat(60));
	logger.info("Background EOL check started:", new Date().toISOString());
	logger.info("=".repeat(60));

	try {
		const { siteUrl, store } = await initializeFromEvent(event);

		let state = await store.get("state", { type: "json" });
		if (!state) {
			logger.info("State not initialized");
			return { statusCode: 200, body: "State not initialized" };
		}

		// Validate and prepare for check
		const shouldProceed = await validateAndPrepareForCheck(state, siteUrl, store);
		if (!shouldProceed.shouldContinue) {
			return { statusCode: 200, body: shouldProceed.reason };
		}

		// Update state with fresh data after potential resets
		state = shouldProceed.updatedState || state;

		logger.info(
			`Current progress: ${state.dailyCounter}/${config.MAX_AUTO_CHECKS_PER_DAY} checks today`
		);

		// Wake Render service on first check
		if (state.dailyCounter === 0) {
			const renderReady = await wakeRenderService();
			if (!renderReady) {
				await updateAutoCheckState(siteUrl, { isRunning: false });
				return { statusCode: 200, body: "Render not ready" };
			}
		}

		// Find next product and handle skips without touching Groq
		const findResult = await findAndValidateProduct(store, siteUrl);

		if (findResult.shouldStopChain) {
			return { statusCode: 200, body: findResult.reason };
		}

		if (findResult.skipped) {
			// Product was missing data, already handled — skip to chain continuation
			await determineChainContinuation(siteUrl, store);
			return {
				statusCode: 202,
				body: JSON.stringify({ message: "Product skipped", nextTriggered: true })
			};
		}

		// Only prepare Groq tokens for real EOL checks
		await prepareForEOLCheck(siteUrl);

		// Execute the actual EOL check
		const checkResult = await executeAndRecordCheck(
			findResult.product, findResult.preCheckState, siteUrl
		);

		if (checkResult.shouldStopChain) {
			return { statusCode: 200, body: checkResult.reason };
		}

		// Determine if chain should continue
		await determineChainContinuation(siteUrl, store);

		return {
			statusCode: 202,
			body: JSON.stringify({
				message: "Check completed",
				counter: checkResult.newCounter,
				nextTriggered: checkResult.shouldContinue
			})
		};
	} catch (error) {
		logger.error("Background function error:", error);
		await handleErrorState(event);

		return {
			statusCode: 500,
			body: JSON.stringify({ error: error.message })
		};
	}
};

// ========== EXTRACTED FUNCTIONS ==========

async function initializeFromEvent(event) {
	const body = JSON.parse(event.body || "{}");
	const passedSiteUrl = body.siteUrl;

	const siteUrl =
		passedSiteUrl ||
		process.env.DEPLOY_PRIME_URL ||
		process.env.DEPLOY_URL ||
		process.env.URL ||
		config.DEVELOP_NETLIFY_SITE_URL;

	logger.info(
		`Site URL: ${siteUrl} (${passedSiteUrl ? "passed from caller" : "from environment"})`
	);

	const store = getStore({
		name: "auto-check-state",
		siteID: process.env.SITE_ID,
		token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
	});

	return { siteUrl, store };
}

async function validateAndPrepareForCheck(state, siteUrl, store) {
	// Check if enabled
	if (!state.enabled) {
		logger.info("Auto-check disabled, stopping");
		await updateAutoCheckState(siteUrl, { isRunning: false });
		return { shouldContinue: false, reason: "Disabled" };
	}

	// Check if new day (reset counter at GMT+9 midnight)
	const currentDate = getGMT9Date();
	if (state.lastResetDate !== currentDate) {
		logger.info(`New day detected (${currentDate}), resetting counter`);
		await updateAutoCheckState(siteUrl, {
			dailyCounter: 0,
			lastResetDate: currentDate
		});

		// Return updated state
		const updatedState = await store.get("state", { type: "json" });
		return {
			shouldContinue: true,
			updatedState,
			reason: "New day, counter reset"
		};
	}

	// Check if daily limit reached
	if (state.dailyCounter >= config.MAX_AUTO_CHECKS_PER_DAY) {
		logger.info(`Daily limit reached (${config.MAX_AUTO_CHECKS_PER_DAY} checks)`);
		await updateAutoCheckState(siteUrl, { isRunning: false });
		return { shouldContinue: false, reason: "Daily limit reached" };
	}

	return { shouldContinue: true };
}

async function prepareForEOLCheck(siteUrl) {
	await waitForGroqTokens(siteUrl);
	// Small delay before processing
	await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function findAndValidateProduct(store, siteUrl) {
	// Find next product to check
	const product = await findNextProduct();
	if (!product) {
		logger.info("No more products to check");
		await updateAutoCheckState(siteUrl, { isRunning: false });
		return {
			shouldStopChain: true,
			reason: "No products to check"
		};
	}

	// Re-check state RIGHT BEFORE starting EOL check
	const preCheckState = await store.get("state", { type: "json" });
	logger.info(
		`Pre-check state: enabled=${preCheckState.enabled}, counter=${preCheckState.dailyCounter}, isRunning=${preCheckState.isRunning}`
	);

	if (!preCheckState.enabled) {
		logger.info("🛑 Auto-check disabled before starting EOL check, stopping chain");
		await updateAutoCheckState(siteUrl, { isRunning: false });
		return {
			shouldStopChain: true,
			reason: "Disabled before check"
		};
	}

	logger.info("✓ Slider still enabled, proceeding with EOL check");

	// Check for missing manufacturer/model BEFORE preparing Groq tokens
	const model = product[3];
	const manufacturer = product[4];
	const sapNumber = product[0];

	if (!model || !manufacturer) {
		const missingModelOrManufacturer = model ? "manufacturer" : "model";
		const missingField =
			!model && !manufacturer ? "manufacturer/model" : missingModelOrManufacturer;
		logger.info(`Missing ${missingField}, disabling Auto Check for this product`);
		logger.info(`Executing EOL check for: ${manufacturer} ${model} (SAP: ${sapNumber})`);

		await disableAutoCheckForMissingData(sapNumber, missingField);

		logger.info("Product skipped (missing data), counter not incremented");
		await updateAutoCheckState(siteUrl, {
			lastActivityTime: new Date().toISOString()
		});

		return { skipped: true };
	}

	return { product, preCheckState };
}

async function executeAndRecordCheck(product, preCheckState, siteUrl) {
	// Execute ONE EOL check
	const result = await executeEOLCheck(product, siteUrl);

	// Skip counter increment for entries that were skipped (defensive guard)
	if (result === "skipped") {
		logger.info("Product skipped (missing data), counter not incremented");
		await updateAutoCheckState(siteUrl, {
			lastActivityTime: new Date().toISOString()
		});
	} else {
		const newCounter = preCheckState.dailyCounter + 1;
		await updateAutoCheckState(siteUrl, {
			dailyCounter: newCounter,
			lastActivityTime: new Date().toISOString(),
			isRunning: true // Explicitly maintain running state during chain
		});

		logger.info(
			`Check ${result === true ? "succeeded" : "failed"}, counter now: ${newCounter}/${config.MAX_AUTO_CHECKS_PER_DAY}`
		);
	}

	return {
		shouldStopChain: false,
		newCounter: result === "skipped" ? preCheckState.dailyCounter : preCheckState.dailyCounter + 1,
		shouldContinue: true
	};
}

async function determineChainContinuation(siteUrl, store) {
	// Check if we should continue
	const freshState = await store.get("state", { type: "json" });
	logger.info(
		`Post-check state: enabled=${freshState.enabled}, counter=${freshState.dailyCounter}, isRunning=${freshState.isRunning}`
	);

	const shouldContinue =
		freshState.enabled && freshState.dailyCounter < config.MAX_AUTO_CHECKS_PER_DAY;

	if (shouldContinue) {
		await triggerNextCheck(siteUrl);
	} else {
		await stopChain(siteUrl, freshState);
	}
}

async function updateAutoCheckState(siteUrl, updates) {
	return fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
		method: "POST",
		headers: getInternalAuthHeaders(),
		body: JSON.stringify(updates)
	});
}

async function triggerNextCheck(siteUrl) {
	logger.info("✓ Slider still enabled, triggering next check...");
	const nextCheckUrl = `${siteUrl}/.netlify/functions/auto-eol-check-background`;

	try {
		const response = await fetch(nextCheckUrl, {
			method: "POST",
			headers: getInternalAuthHeaders(),
			body: JSON.stringify({
				triggeredBy: "chain",
				siteUrl: siteUrl
			})
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error");
			logger.error(`Next check trigger failed: ${response.status} - ${errorText}`);
			await updateAutoCheckState(siteUrl, { isRunning: false });
			return;
		}

		logger.info("Next check triggered successfully");
	} catch (error) {
		logger.error("Error triggering next check:", error.message);
		await updateAutoCheckState(siteUrl, { isRunning: false });
	}
}

async function stopChain(siteUrl, state) {
	const reason = state.enabled ? "daily limit reached" : "slider disabled";
	logger.info(
		`🛑 Chain stopped: ${reason} (enabled=${state.enabled}, counter=${state.dailyCounter}/${config.MAX_AUTO_CHECKS_PER_DAY})`
	);

	await updateAutoCheckState(siteUrl, { isRunning: false });
}

async function handleErrorState(event) {
	try {
		const body = JSON.parse(event.body || "{}");
		const passedSiteUrl = body.siteUrl;
		const errorSiteUrl =
			passedSiteUrl ||
			process.env.DEPLOY_PRIME_URL ||
			process.env.DEPLOY_URL ||
			process.env.URL ||
			config.DEVELOP_NETLIFY_SITE_URL;

		await updateAutoCheckState(errorSiteUrl, { isRunning: false });
	} catch (e) {
		logger.error("Failed to update state on error:", e);
	}
}

// Protect with hybrid authentication (JWT for frontend, API key for backend)
exports.handler = requireHybridAuth(autoEolCheckBackgroundHandler);

// Export internal helpers for testing
exports._internal = {
	getInternalAuthHeaders,
	getGMT9Date,
	getGMT9DateTime,
	wakeRenderService,
	waitForGroqTokens,
	isAutoCheckEnabled,
	hasFinalEOLStatus,
	findNextProduct,
	executeEOLCheck,
	JobPoller,
	updateProduct,
	disableAutoCheckForMissingData,
	autoEolCheckBackgroundHandler,
	initializeFromEvent,
	validateAndPrepareForCheck,
	findAndValidateProduct,
	executeAndRecordCheck,
	determineChainContinuation,
	handleErrorState,
	updateAutoCheckState,
	triggerNextCheck,
	stopChain,
	prepareForEOLCheck
};
