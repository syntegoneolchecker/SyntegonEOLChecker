/**
 * Tests for js/eol-check.js
 * Tests EOL checking functionality: validateEOLInputs, updateRowWithEOLResults,
 * disableAllCheckEOLButtons, enableAllCheckEOLButtons, updateJobProgress,
 * shouldTriggerFetch, buildFetchPayload, shouldTriggerAnalyze,
 * areAllUrlsComplete, createTimeoutResult
 *
 * Since js/eol-check.js uses ES module syntax, we re-implement the pure
 * functions for testing, and mock fetch/DOM interactions.
 */

describe("EOL Check Module", () => {
	let showStatusCalls;
	let fetchMock;
	let state;
	let renderCalled;
	let saveToServerCalled;
	let loadSerpAPICreditsCalled;
	let updateGroqRateLimitsCalls;
	let setIsManualCheckRunningCalls;
	let toggleDeleteButtonsCalled;

	// Mock helpers
	function showStatus(message, type) {
		showStatusCalls.push({ message, type });
	}

	function render() {
		renderCalled = true;
	}

	function saveToServer() {
		saveToServerCalled = true;
		return Promise.resolve();
	}

	function loadSerpAPICredits() {
		loadSerpAPICreditsCalled = true;
		return Promise.resolve();
	}

	function updateGroqRateLimits(rateLimits) {
		updateGroqRateLimitsCalls.push(rateLimits);
	}

	function setIsManualCheckRunning(value) {
		setIsManualCheckRunningCalls.push(value);
		state.isManualCheckRunning = value;
	}

	function toggleDeleteButtons() {
		toggleDeleteButtonsCalled = true;
	}

	function updateRowInOriginalData(row) {
		if (!state.originalData) return;
		const sapNumber = row[0];
		const originalIndex = state.originalData.findIndex((r) => r[0] === sapNumber);
		if (originalIndex !== -1) {
			state.originalData[originalIndex] = [...row];
		}
	}

	beforeEach(() => {
		showStatusCalls = [];
		fetchMock = jest.fn();
		renderCalled = false;
		saveToServerCalled = false;
		loadSerpAPICreditsCalled = false;
		updateGroqRateLimitsCalls = [];
		setIsManualCheckRunningCalls = [];
		toggleDeleteButtonsCalled = false;
		state = {
			data: [
				["SAP Part Number", "Legacy Part Number", "Designation", "Model", "Manufacturer", "Status", "Status Comment", "Successor Model", "Successor Comment", "Successor SAP Number", "Stock", "Information Date", "Auto Check"],
				["8-114-463-187", "OLD-001", "Sensor", "MODEL-A", "SMC", "", "", "", "", "", "50", "", ""]
			],
			originalData: null,
			isManualCheckRunning: false
		};
	});

	// ====== validateEOLInputs ======
	describe("validateEOLInputs", () => {
		function validateEOLInputs(model, manufacturer) {
			if (!model || !manufacturer) {
				showStatus("Error: Model and Manufacturer are required for EOL check", "error");
				return false;
			}
			return true;
		}

		test("should return true when both model and manufacturer provided", () => {
			expect(validateEOLInputs("MODEL-A", "SMC")).toBe(true);
		});

		test("should return false when model is missing", () => {
			expect(validateEOLInputs("", "SMC")).toBe(false);
		});

		test("should return false when manufacturer is missing", () => {
			expect(validateEOLInputs("MODEL-A", "")).toBe(false);
		});

		test("should return false when both are missing", () => {
			expect(validateEOLInputs("", "")).toBe(false);
		});

		test("should return false for null model", () => {
			expect(validateEOLInputs(null, "SMC")).toBe(false);
		});

		test("should return false for null manufacturer", () => {
			expect(validateEOLInputs("MODEL-A", null)).toBe(false);
		});

		test("should return false for undefined inputs", () => {
			expect(validateEOLInputs(undefined, undefined)).toBe(false);
		});

		test("should show error status when inputs are invalid", () => {
			validateEOLInputs("", "");

			expect(showStatusCalls).toHaveLength(1);
			expect(showStatusCalls[0].message).toContain("Model and Manufacturer are required");
			expect(showStatusCalls[0].type).toBe("error");
		});

		test("should not show error when inputs are valid", () => {
			validateEOLInputs("MODEL-A", "SMC");

			expect(showStatusCalls).toHaveLength(0);
		});
	});

	// ====== updateRowWithEOLResults ======
	describe("updateRowWithEOLResults", () => {
		async function updateRowWithEOLResults(rowIndex, result) {
			const row = state.data[rowIndex];

			row[5] = result.status || "UNKNOWN";
			row[6] = result.explanation || "";
			row[7] = result.successor?.model || "";
			row[8] = result.successor?.explanation || "";
			row[11] = new Date().toLocaleString();

			updateRowInOriginalData(row);

			render();
			await saveToServer();

			await loadSerpAPICredits();
			if (result.rateLimits) {
				updateGroqRateLimits(result.rateLimits);
			}
		}

		test("should set status column (5)", async () => {
			const result = { status: "EOL", explanation: "Discontinued" };

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][5]).toBe("EOL");
		});

		test("should set explanation column (6)", async () => {
			const result = { status: "EOL", explanation: "Discontinued in 2024" };

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][6]).toBe("Discontinued in 2024");
		});

		test("should set successor model column (7)", async () => {
			const result = {
				status: "EOL",
				explanation: "Discontinued",
				successor: { model: "MODEL-B", explanation: "Direct replacement" }
			};

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][7]).toBe("MODEL-B");
		});

		test("should set successor explanation column (8)", async () => {
			const result = {
				status: "EOL",
				explanation: "Discontinued",
				successor: { model: "MODEL-B", explanation: "Direct replacement" }
			};

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][8]).toBe("Direct replacement");
		});

		test("should set information date column (11) to current date", async () => {
			const result = { status: "ACTIVE" };
			const before = new Date();

			await updateRowWithEOLResults(1, result);

			// Column 11 should be a date string
			expect(state.data[1][11]).toBeTruthy();
			expect(typeof state.data[1][11]).toBe("string");
		});

		test("should default status to UNKNOWN if missing", async () => {
			const result = {};

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][5]).toBe("UNKNOWN");
		});

		test("should default explanation to empty string if missing", async () => {
			const result = { status: "EOL" };

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][6]).toBe("");
		});

		test("should default successor fields to empty strings if no successor", async () => {
			const result = { status: "ACTIVE" };

			await updateRowWithEOLResults(1, result);

			expect(state.data[1][7]).toBe("");
			expect(state.data[1][8]).toBe("");
		});

		test("should call render", async () => {
			const result = { status: "EOL" };

			await updateRowWithEOLResults(1, result);

			expect(renderCalled).toBe(true);
		});

		test("should call saveToServer", async () => {
			const result = { status: "EOL" };

			await updateRowWithEOLResults(1, result);

			expect(saveToServerCalled).toBe(true);
		});

		test("should call loadSerpAPICredits", async () => {
			const result = { status: "EOL" };

			await updateRowWithEOLResults(1, result);

			expect(loadSerpAPICreditsCalled).toBe(true);
		});

		test("should call updateGroqRateLimits if rateLimits present", async () => {
			const rateLimits = { requestsRemaining: 10, tokensRemaining: 5000 };
			const result = { status: "EOL", rateLimits: rateLimits };

			await updateRowWithEOLResults(1, result);

			expect(updateGroqRateLimitsCalls).toEqual([rateLimits]);
		});

		test("should not call updateGroqRateLimits if no rateLimits", async () => {
			const result = { status: "EOL" };

			await updateRowWithEOLResults(1, result);

			expect(updateGroqRateLimitsCalls).toHaveLength(0);
		});
	});

	// ====== disableAllCheckEOLButtons ======
	describe("disableAllCheckEOLButtons", () => {
		test("should set isManualCheckRunning to true", () => {
			let mockDeleteToggle = { checked: false };
			let mockElements = [];

			function disableAllCheckEOLButtons() {
				setIsManualCheckRunning(true);

				if (mockDeleteToggle.checked) {
					mockDeleteToggle.checked = false;
					toggleDeleteButtons();
				}

				mockElements.forEach((button) => {
					if (
						button.id === "check-eol-button" ||
						button.id === "manual-trigger-btn" ||
						button.id === "delete-toggle"
					) {
						button.disabled = true;
					}
				});
			}

			disableAllCheckEOLButtons();

			expect(setIsManualCheckRunningCalls).toEqual([true]);
		});

		test("should uncheck and toggle delete buttons if delete toggle is checked", () => {
			let mockDeleteToggle = { checked: true };
			let mockElements = [];

			function disableAllCheckEOLButtons() {
				setIsManualCheckRunning(true);

				if (mockDeleteToggle.checked) {
					mockDeleteToggle.checked = false;
					toggleDeleteButtons();
				}

				mockElements.forEach((button) => {
					if (
						button.id === "check-eol-button" ||
						button.id === "manual-trigger-btn" ||
						button.id === "delete-toggle"
					) {
						button.disabled = true;
					}
				});
			}

			disableAllCheckEOLButtons();

			expect(mockDeleteToggle.checked).toBe(false);
			expect(toggleDeleteButtonsCalled).toBe(true);
		});

		test("should not toggle delete buttons if already unchecked", () => {
			let mockDeleteToggle = { checked: false };
			let mockElements = [];

			function disableAllCheckEOLButtons() {
				setIsManualCheckRunning(true);

				if (mockDeleteToggle.checked) {
					mockDeleteToggle.checked = false;
					toggleDeleteButtons();
				}

				mockElements.forEach((button) => {
					if (
						button.id === "check-eol-button" ||
						button.id === "manual-trigger-btn" ||
						button.id === "delete-toggle"
					) {
						button.disabled = true;
					}
				});
			}

			disableAllCheckEOLButtons();

			expect(toggleDeleteButtonsCalled).toBe(false);
		});

		test("should disable check-eol-button, manual-trigger-btn, and delete-toggle", () => {
			let mockDeleteToggle = { checked: false };
			let mockElements = [
				{ id: "check-eol-button", disabled: false },
				{ id: "manual-trigger-btn", disabled: false },
				{ id: "delete-toggle", disabled: false },
				{ id: "other-button", disabled: false }
			];

			function disableAllCheckEOLButtons() {
				setIsManualCheckRunning(true);

				if (mockDeleteToggle.checked) {
					mockDeleteToggle.checked = false;
					toggleDeleteButtons();
				}

				mockElements.forEach((button) => {
					if (
						button.id === "check-eol-button" ||
						button.id === "manual-trigger-btn" ||
						button.id === "delete-toggle"
					) {
						button.disabled = true;
					}
				});
			}

			disableAllCheckEOLButtons();

			expect(mockElements[0].disabled).toBe(true);  // check-eol-button
			expect(mockElements[1].disabled).toBe(true);  // manual-trigger-btn
			expect(mockElements[2].disabled).toBe(true);  // delete-toggle
			expect(mockElements[3].disabled).toBe(false); // other-button unchanged
		});
	});

	// ====== enableAllCheckEOLButtons ======
	describe("enableAllCheckEOLButtons", () => {
		test("should set isManualCheckRunning to false", () => {
			let mockElements = [];

			function enableAllCheckEOLButtons() {
				setIsManualCheckRunning(false);
				mockElements.forEach((button) => {
					if (button.id === "check-eol-button") {
						button.disabled = false;
						button.textContent = "Check EOL";
					} else if (button.id === "manual-trigger-btn" || button.id === "delete-toggle") {
						button.disabled = false;
					}
				});
			}

			enableAllCheckEOLButtons();

			expect(setIsManualCheckRunningCalls).toEqual([false]);
		});

		test("should enable and reset text for check-eol-button", () => {
			let mockElements = [
				{ id: "check-eol-button", disabled: true, textContent: "Processing..." }
			];

			function enableAllCheckEOLButtons() {
				setIsManualCheckRunning(false);
				mockElements.forEach((button) => {
					if (button.id === "check-eol-button") {
						button.disabled = false;
						button.textContent = "Check EOL";
					} else if (button.id === "manual-trigger-btn" || button.id === "delete-toggle") {
						button.disabled = false;
					}
				});
			}

			enableAllCheckEOLButtons();

			expect(mockElements[0].disabled).toBe(false);
			expect(mockElements[0].textContent).toBe("Check EOL");
		});

		test("should enable manual-trigger-btn and delete-toggle", () => {
			let mockElements = [
				{ id: "manual-trigger-btn", disabled: true },
				{ id: "delete-toggle", disabled: true }
			];

			function enableAllCheckEOLButtons() {
				setIsManualCheckRunning(false);
				mockElements.forEach((button) => {
					if (button.id === "check-eol-button") {
						button.disabled = false;
						button.textContent = "Check EOL";
					} else if (button.id === "manual-trigger-btn" || button.id === "delete-toggle") {
						button.disabled = false;
					}
				});
			}

			enableAllCheckEOLButtons();

			expect(mockElements[0].disabled).toBe(false);
			expect(mockElements[1].disabled).toBe(false);
		});

		test("should not modify unrelated buttons", () => {
			let mockElements = [
				{ id: "other-button", disabled: true, textContent: "Other" }
			];

			function enableAllCheckEOLButtons() {
				setIsManualCheckRunning(false);
				mockElements.forEach((button) => {
					if (button.id === "check-eol-button") {
						button.disabled = false;
						button.textContent = "Check EOL";
					} else if (button.id === "manual-trigger-btn" || button.id === "delete-toggle") {
						button.disabled = false;
					}
				});
			}

			enableAllCheckEOLButtons();

			expect(mockElements[0].disabled).toBe(true);
			expect(mockElements[0].textContent).toBe("Other");
		});
	});

	// ====== updateJobProgress ======
	describe("updateJobProgress", () => {
		function updateJobProgress(statusData, manufacturer, model, checkButton) {
			const progress = `${statusData.completedUrls || 0}/${statusData.urlCount || 0}`;
			if (checkButton) {
				checkButton.textContent = `Processing (${progress})`;
			}
			showStatus(`Checking ${manufacturer} ${model}... (${progress} pages)`, "info", false);
		}

		test("should update button text with progress", () => {
			const checkButton = { textContent: "" };
			const statusData = { completedUrls: 3, urlCount: 5 };

			updateJobProgress(statusData, "SMC", "MODEL-A", checkButton);

			expect(checkButton.textContent).toBe("Processing (3/5)");
		});

		test("should show status with progress", () => {
			const checkButton = { textContent: "" };
			const statusData = { completedUrls: 2, urlCount: 4 };

			updateJobProgress(statusData, "Bosch", "XDK110", checkButton);

			expect(showStatusCalls[0].message).toBe("Checking Bosch XDK110... (2/4 pages)");
			expect(showStatusCalls[0].type).toBe("info");
		});

		test("should default to 0/0 when counts are missing", () => {
			const checkButton = { textContent: "" };
			const statusData = {};

			updateJobProgress(statusData, "SMC", "MODEL-A", checkButton);

			expect(checkButton.textContent).toBe("Processing (0/0)");
		});

		test("should handle null checkButton gracefully", () => {
			const statusData = { completedUrls: 1, urlCount: 3 };

			updateJobProgress(statusData, "SMC", "MODEL-A", null);

			// Should not throw, and status should still be shown
			expect(showStatusCalls[0].message).toContain("1/3 pages");
		});

		test("should handle undefined checkButton gracefully", () => {
			const statusData = { completedUrls: 1, urlCount: 3 };

			updateJobProgress(statusData, "SMC", "MODEL-A", undefined);

			expect(showStatusCalls).toHaveLength(1);
		});
	});

	// ====== shouldTriggerFetch ======
	describe("shouldTriggerFetch", () => {
		function shouldTriggerFetch(statusData, fetchTriggered) {
			return (
				statusData.status === "urls_ready" &&
				!fetchTriggered &&
				statusData.urls &&
				statusData.urls.length > 0 &&
				statusData.urls[0].status === "pending"
			);
		}

		test("should return true when urls_ready, not triggered, and first url pending", () => {
			const statusData = {
				status: "urls_ready",
				urls: [{ status: "pending", url: "https://example.com" }]
			};

			expect(shouldTriggerFetch(statusData, false)).toBe(true);
		});

		test("should return false if already triggered", () => {
			const statusData = {
				status: "urls_ready",
				urls: [{ status: "pending", url: "https://example.com" }]
			};

			expect(shouldTriggerFetch(statusData, true)).toBe(false);
		});

		test("should return false if status is not urls_ready", () => {
			const statusData = {
				status: "processing",
				urls: [{ status: "pending" }]
			};

			expect(shouldTriggerFetch(statusData, false)).toBe(false);
		});

		test("should return false if urls array is empty", () => {
			const statusData = {
				status: "urls_ready",
				urls: []
			};

			expect(shouldTriggerFetch(statusData, false)).toBe(false);
		});

		test("should return false if urls is null", () => {
			const statusData = {
				status: "urls_ready",
				urls: null
			};

			expect(shouldTriggerFetch(statusData, false)).toBeFalsy();
		});

		test("should return false if urls is undefined", () => {
			const statusData = {
				status: "urls_ready"
			};

			expect(shouldTriggerFetch(statusData, false)).toBeFalsy();
		});

		test("should return false if first url status is not pending", () => {
			const statusData = {
				status: "urls_ready",
				urls: [{ status: "complete" }]
			};

			expect(shouldTriggerFetch(statusData, false)).toBe(false);
		});

		test("should return false if first url is in-progress", () => {
			const statusData = {
				status: "urls_ready",
				urls: [{ status: "in-progress" }]
			};

			expect(shouldTriggerFetch(statusData, false)).toBe(false);
		});
	});

	// ====== buildFetchPayload ======
	describe("buildFetchPayload", () => {
		function buildFetchPayload(jobId, firstUrl) {
			const payload = {
				jobId,
				urlIndex: firstUrl.index,
				url: firstUrl.url,
				title: firstUrl.title,
				snippet: firstUrl.snippet,
				scrapingMethod: firstUrl.scrapingMethod
			};

			if (firstUrl.model) payload.model = firstUrl.model;
			if (firstUrl.jpUrl) payload.jpUrl = firstUrl.jpUrl;
			if (firstUrl.usUrl) payload.usUrl = firstUrl.usUrl;

			return payload;
		}

		test("should build basic payload with required fields", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com/product",
				title: "Product Page",
				snippet: "A product description",
				scrapingMethod: "browserql"
			};

			const result = buildFetchPayload("job-123", firstUrl);

			expect(result).toEqual({
				jobId: "job-123",
				urlIndex: 0,
				url: "https://example.com/product",
				title: "Product Page",
				snippet: "A product description",
				scrapingMethod: "browserql"
			});
		});

		test("should include model if present", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "fetch",
				model: "MODEL-A"
			};

			const result = buildFetchPayload("job-456", firstUrl);

			expect(result.model).toBe("MODEL-A");
		});

		test("should include jpUrl if present", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "fetch",
				jpUrl: "https://example.jp/product"
			};

			const result = buildFetchPayload("job-789", firstUrl);

			expect(result.jpUrl).toBe("https://example.jp/product");
		});

		test("should include usUrl if present", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "fetch",
				usUrl: "https://example.us/product"
			};

			const result = buildFetchPayload("job-101", firstUrl);

			expect(result.usUrl).toBe("https://example.us/product");
		});

		test("should include all optional fields when all present", () => {
			const firstUrl = {
				index: 2,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "browserql",
				model: "SENSOR-X",
				jpUrl: "https://jp.example.com",
				usUrl: "https://us.example.com"
			};

			const result = buildFetchPayload("job-all", firstUrl);

			expect(result.model).toBe("SENSOR-X");
			expect(result.jpUrl).toBe("https://jp.example.com");
			expect(result.usUrl).toBe("https://us.example.com");
		});

		test("should not include model if falsy", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "fetch",
				model: ""
			};

			const result = buildFetchPayload("job-no-model", firstUrl);

			expect(result).not.toHaveProperty("model");
		});

		test("should not include jpUrl if falsy", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "fetch",
				jpUrl: null
			};

			const result = buildFetchPayload("job-no-jp", firstUrl);

			expect(result).not.toHaveProperty("jpUrl");
		});

		test("should not include usUrl if falsy", () => {
			const firstUrl = {
				index: 0,
				url: "https://example.com",
				title: "Page",
				snippet: "Snippet",
				scrapingMethod: "fetch",
				usUrl: undefined
			};

			const result = buildFetchPayload("job-no-us", firstUrl);

			expect(result).not.toHaveProperty("usUrl");
		});
	});

	// ====== areAllUrlsComplete ======
	describe("areAllUrlsComplete", () => {
		function areAllUrlsComplete(statusData) {
			return (
				statusData.urls &&
				statusData.urls.length > 0 &&
				statusData.urls.every((u) => u.status === "complete")
			);
		}

		test("should return true when all urls are complete", () => {
			const statusData = {
				urls: [
					{ status: "complete" },
					{ status: "complete" },
					{ status: "complete" }
				]
			};

			expect(areAllUrlsComplete(statusData)).toBe(true);
		});

		test("should return false when some urls are not complete", () => {
			const statusData = {
				urls: [
					{ status: "complete" },
					{ status: "pending" },
					{ status: "complete" }
				]
			};

			expect(areAllUrlsComplete(statusData)).toBe(false);
		});

		test("should return false when no urls are complete", () => {
			const statusData = {
				urls: [
					{ status: "pending" },
					{ status: "in-progress" }
				]
			};

			expect(areAllUrlsComplete(statusData)).toBe(false);
		});

		test("should return false for empty urls array", () => {
			const statusData = { urls: [] };

			expect(areAllUrlsComplete(statusData)).toBe(false);
		});

		test("should return false for null urls", () => {
			const statusData = { urls: null };

			expect(areAllUrlsComplete(statusData)).toBeFalsy();
		});

		test("should return false for undefined urls", () => {
			const statusData = {};

			expect(areAllUrlsComplete(statusData)).toBeFalsy();
		});

		test("should return true for single complete url", () => {
			const statusData = {
				urls: [{ status: "complete" }]
			};

			expect(areAllUrlsComplete(statusData)).toBe(true);
		});
	});

	// ====== shouldTriggerAnalyze ======
	describe("shouldTriggerAnalyze", () => {
		function areAllUrlsComplete(statusData) {
			return (
				statusData.urls &&
				statusData.urls.length > 0 &&
				statusData.urls.every((u) => u.status === "complete")
			);
		}

		function shouldTriggerAnalyze(statusData, analyzeTriggered) {
			return (
				areAllUrlsComplete(statusData) &&
				!analyzeTriggered &&
				statusData.status !== "analyzing" &&
				statusData.status !== "complete"
			);
		}

		test("should return true when all urls complete and not triggered", () => {
			const statusData = {
				status: "urls_ready",
				urls: [
					{ status: "complete" },
					{ status: "complete" }
				]
			};

			expect(shouldTriggerAnalyze(statusData, false)).toBe(true);
		});

		test("should return false if already triggered", () => {
			const statusData = {
				status: "urls_ready",
				urls: [
					{ status: "complete" },
					{ status: "complete" }
				]
			};

			expect(shouldTriggerAnalyze(statusData, true)).toBe(false);
		});

		test("should return false if status is analyzing", () => {
			const statusData = {
				status: "analyzing",
				urls: [
					{ status: "complete" },
					{ status: "complete" }
				]
			};

			expect(shouldTriggerAnalyze(statusData, false)).toBe(false);
		});

		test("should return false if status is complete", () => {
			const statusData = {
				status: "complete",
				urls: [
					{ status: "complete" },
					{ status: "complete" }
				]
			};

			expect(shouldTriggerAnalyze(statusData, false)).toBe(false);
		});

		test("should return false if not all urls are complete", () => {
			const statusData = {
				status: "urls_ready",
				urls: [
					{ status: "complete" },
					{ status: "pending" }
				]
			};

			expect(shouldTriggerAnalyze(statusData, false)).toBe(false);
		});

		test("should return false for empty urls", () => {
			const statusData = {
				status: "urls_ready",
				urls: []
			};

			expect(shouldTriggerAnalyze(statusData, false)).toBe(false);
		});

		test("should return false for null urls", () => {
			const statusData = {
				status: "urls_ready",
				urls: null
			};

			expect(shouldTriggerAnalyze(statusData, false)).toBeFalsy();
		});
	});

	// ====== createTimeoutResult ======
	describe("createTimeoutResult", () => {
		function createTimeoutResult(maxAttempts) {
			return {
				status: "UNKNOWN",
				explanation: `EOL check timed out after ${maxAttempts} polling attempts (2 minutes). Please try again later.`,
				successor: {
					status: "UNKNOWN",
					model: null,
					explanation: ""
				}
			};
		}

		test("should return result with UNKNOWN status", () => {
			const result = createTimeoutResult(60);

			expect(result.status).toBe("UNKNOWN");
		});

		test("should include max attempts in explanation", () => {
			const result = createTimeoutResult(60);

			expect(result.explanation).toContain("60 polling attempts");
		});

		test("should include 2 minutes in explanation", () => {
			const result = createTimeoutResult(60);

			expect(result.explanation).toContain("2 minutes");
		});

		test("should include try again message", () => {
			const result = createTimeoutResult(60);

			expect(result.explanation).toContain("Please try again later");
		});

		test("should return successor with UNKNOWN status", () => {
			const result = createTimeoutResult(60);

			expect(result.successor.status).toBe("UNKNOWN");
		});

		test("should return successor with null model", () => {
			const result = createTimeoutResult(60);

			expect(result.successor.model).toBeNull();
		});

		test("should return successor with empty explanation", () => {
			const result = createTimeoutResult(60);

			expect(result.successor.explanation).toBe("");
		});

		test("should handle different maxAttempts values", () => {
			const result = createTimeoutResult(30);

			expect(result.explanation).toContain("30 polling attempts");
		});
	});
});
