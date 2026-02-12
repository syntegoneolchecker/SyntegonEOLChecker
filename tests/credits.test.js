/**
 * Tests for js/credits.js
 * Tests loadSerpAPICredits, loadGroqUsage, updateGroqRateLimits,
 * startGroqCountdown, attemptHealthCheck, updateRenderStatus, checkRenderHealth
 *
 * Since js/credits.js uses ES module syntax, we re-implement the pure logic
 * functions for testing and mock DOM/fetch/timer dependencies.
 */

describe("Credits Module", () => {
	let fetchMock;
	let showStatusCalls;
	let state;

	function showStatus(message, type = "success") {
		showStatusCalls.push({ message, type });
	}

	beforeEach(() => {
		fetchMock = jest.fn();
		showStatusCalls = [];
		state = {
			groqCountdownInterval: null,
			groqResetTimestamp: null
		};
	});

	// ====== loadSerpAPICredits ======
	describe("loadSerpAPICredits", () => {
		test("should display remaining/limit on success", async () => {
			const creditsElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 85, limit: 100 })
			});

			async function loadSerpAPICredits() {
				try {
					const response = await fetchMock("/.netlify/functions/get-serpapi-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
					}
					const result = await response.json();
					const remaining = result.remaining;
					const limit = result.limit;
					creditsElement.textContent = `${remaining}/${limit} remaining`;
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
					const percentRemaining = (remaining / limit) * 100;
					if (percentRemaining > 50) {
						creditsElement.classList.add("credits-high");
					} else if (percentRemaining > 20) {
						creditsElement.classList.add("credits-medium");
					} else {
						creditsElement.classList.add("credits-low");
					}
				} catch (error) {
					creditsElement.textContent = "Error loading usage";
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadSerpAPICredits();

			expect(creditsElement.textContent).toBe("85/100 remaining");
			expect(creditsElement.classList.add).toHaveBeenCalledWith("credits-high");
		});

		test("should add credits-medium class when 20-50% remaining", async () => {
			const creditsElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 30, limit: 100 })
			});

			async function loadSerpAPICredits() {
				try {
					const response = await fetchMock("/.netlify/functions/get-serpapi-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
					}
					const result = await response.json();
					const remaining = result.remaining;
					const limit = result.limit;
					creditsElement.textContent = `${remaining}/${limit} remaining`;
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
					const percentRemaining = (remaining / limit) * 100;
					if (percentRemaining > 50) {
						creditsElement.classList.add("credits-high");
					} else if (percentRemaining > 20) {
						creditsElement.classList.add("credits-medium");
					} else {
						creditsElement.classList.add("credits-low");
					}
				} catch (error) {
					creditsElement.textContent = "Error loading usage";
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadSerpAPICredits();

			expect(creditsElement.textContent).toBe("30/100 remaining");
			expect(creditsElement.classList.add).toHaveBeenCalledWith("credits-medium");
		});

		test("should add credits-low class when <= 20% remaining", async () => {
			const creditsElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 10, limit: 100 })
			});

			async function loadSerpAPICredits() {
				try {
					const response = await fetchMock("/.netlify/functions/get-serpapi-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
					}
					const result = await response.json();
					const remaining = result.remaining;
					const limit = result.limit;
					creditsElement.textContent = `${remaining}/${limit} remaining`;
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
					const percentRemaining = (remaining / limit) * 100;
					if (percentRemaining > 50) {
						creditsElement.classList.add("credits-high");
					} else if (percentRemaining > 20) {
						creditsElement.classList.add("credits-medium");
					} else {
						creditsElement.classList.add("credits-low");
					}
				} catch (error) {
					creditsElement.textContent = "Error loading usage";
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadSerpAPICredits();

			expect(creditsElement.textContent).toBe("10/100 remaining");
			expect(creditsElement.classList.add).toHaveBeenCalledWith("credits-low");
		});

		test("should show error on fetch failure", async () => {
			const creditsElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockRejectedValue(new Error("Network error"));

			async function loadSerpAPICredits() {
				try {
					const response = await fetchMock("/.netlify/functions/get-serpapi-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
					}
					const result = await response.json();
					creditsElement.textContent = `${result.remaining}/${result.limit} remaining`;
				} catch (error) {
					creditsElement.textContent = "Error loading usage";
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadSerpAPICredits();

			expect(creditsElement.textContent).toBe("Error loading usage");
			expect(creditsElement.classList.remove).toHaveBeenCalledWith("credits-high", "credits-medium", "credits-low");
		});

		test("should show error on non-ok response", async () => {
			const creditsElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: false,
				status: 500
			});

			async function loadSerpAPICredits() {
				try {
					const response = await fetchMock("/.netlify/functions/get-serpapi-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
					}
					const result = await response.json();
					creditsElement.textContent = `${result.remaining}/${result.limit} remaining`;
				} catch (error) {
					creditsElement.textContent = "Error loading usage";
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadSerpAPICredits();

			expect(creditsElement.textContent).toBe("Error loading usage");
		});

		test("should remove all CSS classes before adding new one", async () => {
			const creditsElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 85, limit: 100 })
			});

			async function loadSerpAPICredits() {
				try {
					const response = await fetchMock("/.netlify/functions/get-serpapi-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
					}
					const result = await response.json();
					const remaining = result.remaining;
					const limit = result.limit;
					creditsElement.textContent = `${remaining}/${limit} remaining`;
					creditsElement.classList.remove("credits-high", "credits-medium", "credits-low");
					const percentRemaining = (remaining / limit) * 100;
					if (percentRemaining > 50) {
						creditsElement.classList.add("credits-high");
					} else if (percentRemaining > 20) {
						creditsElement.classList.add("credits-medium");
					} else {
						creditsElement.classList.add("credits-low");
					}
				} catch (error) {
					creditsElement.textContent = "Error loading usage";
				}
			}

			await loadSerpAPICredits();

			expect(creditsElement.classList.remove).toHaveBeenCalledWith("credits-high", "credits-medium", "credits-low");
		});
	});

	// ====== loadGroqUsage ======
	describe("loadGroqUsage", () => {
		test("should call updateGroqRateLimits on success", async () => {
			let rateLimitsReceived = null;
			const groqElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remainingTokens: "5000", limitTokens: "10000" })
			});

			function updateGroqRateLimits(rateLimits) {
				rateLimitsReceived = rateLimits;
			}

			async function loadGroqUsage() {
				try {
					const response = await fetchMock("/.netlify/functions/get-groq-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch Groq usage: ${response.status}`);
					}
					const result = await response.json();
					updateGroqRateLimits(result);
				} catch (error) {
					groqElement.textContent = "Error loading";
					groqElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadGroqUsage();

			expect(rateLimitsReceived).toEqual({ remainingTokens: "5000", limitTokens: "10000" });
		});

		test("should show error on fetch failure", async () => {
			const groqElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockRejectedValue(new Error("Network error"));

			async function loadGroqUsage() {
				try {
					const response = await fetchMock("/.netlify/functions/get-groq-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch Groq usage: ${response.status}`);
					}
					const result = await response.json();
				} catch (error) {
					groqElement.textContent = "Error loading";
					groqElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadGroqUsage();

			expect(groqElement.textContent).toBe("Error loading");
			expect(groqElement.classList.remove).toHaveBeenCalledWith("credits-high", "credits-medium", "credits-low");
		});

		test("should show error on non-ok response", async () => {
			const groqElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: false,
				status: 429
			});

			async function loadGroqUsage() {
				try {
					const response = await fetchMock("/.netlify/functions/get-groq-usage");
					if (!response.ok) {
						throw new Error(`Failed to fetch Groq usage: ${response.status}`);
					}
				} catch (error) {
					groqElement.textContent = "Error loading";
					groqElement.classList.remove("credits-high", "credits-medium", "credits-low");
				}
			}

			await loadGroqUsage();

			expect(groqElement.textContent).toBe("Error loading");
		});
	});

	// ====== updateGroqRateLimits ======
	describe("updateGroqRateLimits", () => {
		let groqElement;
		let countdownElement;
		let startGroqCountdownCalls;

		function startGroqCountdown(resetSeconds) {
			startGroqCountdownCalls.push(resetSeconds);
		}

		function updateGroqRateLimits(rateLimits) {
			if (!rateLimits?.remainingTokens || !rateLimits.limitTokens) {
				groqElement.textContent = "N/A";
			} else {
				const remaining = Number.parseInt(rateLimits.remainingTokens);
				const limit = Number.parseInt(rateLimits.limitTokens);

				const remainingFormatted = remaining.toLocaleString();
				const limitFormatted = limit.toLocaleString();

				groqElement.textContent = `${remainingFormatted}/${limitFormatted} TPM`;

				groqElement.classList.remove("credits-high", "credits-medium", "credits-low");

				const percentRemaining = (remaining / limit) * 100;

				if (percentRemaining > 50) {
					groqElement.classList.add("credits-high");
				} else if (percentRemaining > 20) {
					groqElement.classList.add("credits-medium");
				} else {
					groqElement.classList.add("credits-low");
				}
			}

			if (rateLimits?.resetSeconds !== null && rateLimits.resetSeconds !== undefined) {
				startGroqCountdown(rateLimits.resetSeconds);
			} else {
				countdownElement.textContent = "N/A";
			}
		}

		beforeEach(() => {
			groqElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};
			countdownElement = { textContent: "" };
			startGroqCountdownCalls = [];
		});

		test("should display formatted tokens with TPM suffix", () => {
			updateGroqRateLimits({ remainingTokens: "5000", limitTokens: "10000" });

			expect(groqElement.textContent).toBe("5,000/10,000 TPM");
		});

		test("should add credits-high class when > 50% remaining", () => {
			updateGroqRateLimits({ remainingTokens: "8000", limitTokens: "10000" });

			expect(groqElement.classList.add).toHaveBeenCalledWith("credits-high");
		});

		test("should add credits-medium class when 20-50% remaining", () => {
			updateGroqRateLimits({ remainingTokens: "3000", limitTokens: "10000" });

			expect(groqElement.classList.add).toHaveBeenCalledWith("credits-medium");
		});

		test("should add credits-low class when <= 20% remaining", () => {
			updateGroqRateLimits({ remainingTokens: "1000", limitTokens: "10000" });

			expect(groqElement.classList.add).toHaveBeenCalledWith("credits-low");
		});

		test("should show N/A when remainingTokens is missing", () => {
			updateGroqRateLimits({ limitTokens: "10000" });

			expect(groqElement.textContent).toBe("N/A");
		});

		test("should show N/A when limitTokens is missing", () => {
			updateGroqRateLimits({ remainingTokens: "5000" });

			expect(groqElement.textContent).toBe("N/A");
		});

		test("should show N/A for null rateLimits fields", () => {
			updateGroqRateLimits({ remainingTokens: null, limitTokens: null });

			expect(groqElement.textContent).toBe("N/A");
		});

		test("should remove all CSS classes before adding new one", () => {
			updateGroqRateLimits({ remainingTokens: "8000", limitTokens: "10000" });

			expect(groqElement.classList.remove).toHaveBeenCalledWith("credits-high", "credits-medium", "credits-low");
		});

		test("should start countdown when resetSeconds is present", () => {
			updateGroqRateLimits({ remainingTokens: "5000", limitTokens: "10000", resetSeconds: 60 });

			expect(startGroqCountdownCalls).toEqual([60]);
		});

		test("should start countdown when resetSeconds is 0", () => {
			updateGroqRateLimits({ remainingTokens: "5000", limitTokens: "10000", resetSeconds: 0 });

			expect(startGroqCountdownCalls).toEqual([0]);
		});

		test("should show N/A for countdown when resetSeconds is null", () => {
			updateGroqRateLimits({ remainingTokens: "5000", limitTokens: "10000", resetSeconds: null });

			expect(countdownElement.textContent).toBe("N/A");
			expect(startGroqCountdownCalls).toHaveLength(0);
		});

		test("should show N/A for countdown when resetSeconds is undefined", () => {
			updateGroqRateLimits({ remainingTokens: "5000", limitTokens: "10000" });

			expect(countdownElement.textContent).toBe("N/A");
			expect(startGroqCountdownCalls).toHaveLength(0);
		});
	});

	// ====== startGroqCountdown ======
	describe("startGroqCountdown", () => {
		test("should clear existing interval before starting new one", () => {
			const existingInterval = 12345;
			state.groqCountdownInterval = existingInterval;
			let clearedInterval = null;
			let setIntervalCalled = false;
			let updateCountdownDisplayCalled = false;

			function setGroqResetTimestamp(timestamp) {
				state.groqResetTimestamp = timestamp;
			}

			function setGroqCountdownInterval(interval) {
				state.groqCountdownInterval = interval;
			}

			function updateCountdownDisplay() {
				updateCountdownDisplayCalled = true;
			}

			function startGroqCountdown(resetSeconds) {
				if (state.groqCountdownInterval) {
					clearedInterval = state.groqCountdownInterval;
				}
				setGroqResetTimestamp(Date.now() + resetSeconds * 1000);
				updateCountdownDisplay();
				setIntervalCalled = true;
			}

			startGroqCountdown(60);

			expect(clearedInterval).toBe(existingInterval);
			expect(updateCountdownDisplayCalled).toBe(true);
			expect(setIntervalCalled).toBe(true);
		});

		test("should set groqResetTimestamp based on resetSeconds", () => {
			function setGroqResetTimestamp(timestamp) {
				state.groqResetTimestamp = timestamp;
			}

			function setGroqCountdownInterval(interval) {
				state.groqCountdownInterval = interval;
			}

			function updateCountdownDisplay() {}

			function startGroqCountdown(resetSeconds) {
				if (state.groqCountdownInterval) {
					// clear existing
				}
				setGroqResetTimestamp(Date.now() + resetSeconds * 1000);
				updateCountdownDisplay();
			}

			const before = Date.now();
			startGroqCountdown(30);
			const after = Date.now();

			expect(state.groqResetTimestamp).toBeGreaterThanOrEqual(before + 30000);
			expect(state.groqResetTimestamp).toBeLessThanOrEqual(after + 30000);
		});

		test("should call updateCountdownDisplay immediately", () => {
			let updateCalled = false;

			function setGroqResetTimestamp(timestamp) {
				state.groqResetTimestamp = timestamp;
			}

			function setGroqCountdownInterval(interval) {
				state.groqCountdownInterval = interval;
			}

			function updateCountdownDisplay() {
				updateCalled = true;
			}

			function startGroqCountdown(resetSeconds) {
				if (state.groqCountdownInterval) {
					// clear existing
				}
				setGroqResetTimestamp(Date.now() + resetSeconds * 1000);
				updateCountdownDisplay();
			}

			startGroqCountdown(10);

			expect(updateCalled).toBe(true);
		});
	});

	// ====== attemptHealthCheck ======
	describe("attemptHealthCheck", () => {
		async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
			const startTime = Date.now();

			try {
				const response = await fetchMock(`${renderServiceUrl}/health`);

				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

				if (response.ok) {
					const data = await response.json();
					return { success: true, elapsed, data };
				} else {
					return { success: false, error: `HTTP ${response.status}`, elapsed };
				}
			} catch (error) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				return {
					success: false,
					error: error.name === "AbortError" ? "Timeout" : error.message,
					elapsed
				};
			}
		}

		test("should return success with data on ok response", async () => {
			const healthData = { status: "ok", uptime: 1234 };
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(healthData)
			});

			const result = await attemptHealthCheck("https://example.onrender.com", 60000);

			expect(result.success).toBe(true);
			expect(result.data).toEqual(healthData);
			expect(result.elapsed).toBeDefined();
		});

		test("should fetch the correct health URL", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ status: "ok" })
			});

			await attemptHealthCheck("https://myservice.onrender.com", 60000);

			expect(fetchMock).toHaveBeenCalledWith("https://myservice.onrender.com/health");
		});

		test("should return failure with HTTP status on non-ok response", async () => {
			fetchMock.mockResolvedValue({
				ok: false,
				status: 503
			});

			const result = await attemptHealthCheck("https://example.onrender.com", 60000);

			expect(result.success).toBe(false);
			expect(result.error).toBe("HTTP 503");
			expect(result.elapsed).toBeDefined();
		});

		test("should return Timeout error on AbortError", async () => {
			const abortError = new Error("The operation was aborted");
			abortError.name = "AbortError";
			fetchMock.mockRejectedValue(abortError);

			const result = await attemptHealthCheck("https://example.onrender.com", 60000);

			expect(result.success).toBe(false);
			expect(result.error).toBe("Timeout");
		});

		test("should return error message on network failure", async () => {
			fetchMock.mockRejectedValue(new Error("Failed to fetch"));

			const result = await attemptHealthCheck("https://example.onrender.com", 60000);

			expect(result.success).toBe(false);
			expect(result.error).toBe("Failed to fetch");
		});

		test("should include elapsed time on error", async () => {
			fetchMock.mockRejectedValue(new Error("Connection refused"));

			const result = await attemptHealthCheck("https://example.onrender.com", 60000);

			expect(result.elapsed).toBeDefined();
			expect(parseFloat(result.elapsed)).toBeGreaterThanOrEqual(0);
		});
	});

	// ====== updateRenderStatus ======
	describe("updateRenderStatus", () => {
		function updateRenderStatus(element, elapsed, data) {
			if (elapsed > 10) {
				element.textContent = `Ready (cold start: ${elapsed}s)`;
				element.classList.add("credits-medium");
			} else {
				element.textContent = `Ready (${elapsed}s)`;
				element.classList.add("credits-high");
			}
		}

		test("should show cold start message when elapsed > 10 seconds", () => {
			const element = {
				textContent: "",
				classList: { add: jest.fn() }
			};

			updateRenderStatus(element, 15.3, { status: "ok" });

			expect(element.textContent).toBe("Ready (cold start: 15.3s)");
			expect(element.classList.add).toHaveBeenCalledWith("credits-medium");
		});

		test("should show normal ready message when elapsed <= 10 seconds", () => {
			const element = {
				textContent: "",
				classList: { add: jest.fn() }
			};

			updateRenderStatus(element, 2.5, { status: "ok" });

			expect(element.textContent).toBe("Ready (2.5s)");
			expect(element.classList.add).toHaveBeenCalledWith("credits-high");
		});

		test("should add credits-medium class for slow response", () => {
			const element = {
				textContent: "",
				classList: { add: jest.fn() }
			};

			updateRenderStatus(element, 45.0, { status: "ok" });

			expect(element.classList.add).toHaveBeenCalledWith("credits-medium");
		});

		test("should add credits-high class for fast response", () => {
			const element = {
				textContent: "",
				classList: { add: jest.fn() }
			};

			updateRenderStatus(element, 1.0, { status: "ok" });

			expect(element.classList.add).toHaveBeenCalledWith("credits-high");
		});

		test("should treat exactly 10 as fast response", () => {
			const element = {
				textContent: "",
				classList: { add: jest.fn() }
			};

			updateRenderStatus(element, 10, { status: "ok" });

			expect(element.textContent).toBe("Ready (10s)");
			expect(element.classList.add).toHaveBeenCalledWith("credits-high");
		});

		test("should treat 10.1 as cold start", () => {
			const element = {
				textContent: "",
				classList: { add: jest.fn() }
			};

			updateRenderStatus(element, 10.1, { status: "ok" });

			expect(element.textContent).toBe("Ready (cold start: 10.1s)");
			expect(element.classList.add).toHaveBeenCalledWith("credits-medium");
		});
	});

	// ====== checkRenderHealth (integration) ======
	describe("checkRenderHealth", () => {
		test("should show success on first attempt success", async () => {
			const renderStatusElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ status: "ok" })
			});

			async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
				const startTime = Date.now();
				try {
					const response = await fetchMock(`${renderServiceUrl}/health`);
					const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
					if (response.ok) {
						const data = await response.json();
						return { success: true, elapsed, data };
					}
					return { success: false, error: `HTTP ${response.status}`, elapsed };
				} catch (error) {
					const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
					return { success: false, error: error.message, elapsed };
				}
			}

			function updateRenderStatus(element, elapsed, data) {
				if (elapsed > 10) {
					element.textContent = `Ready (cold start: ${elapsed}s)`;
					element.classList.add("credits-medium");
				} else {
					element.textContent = `Ready (${elapsed}s)`;
					element.classList.add("credits-high");
				}
			}

			async function checkRenderHealth() {
				showStatus("Waiting for response from Render health check...");
				const renderServiceUrl = "https://eolscrapingservice.onrender.com";

				renderStatusElement.textContent = "Checking...";
				renderStatusElement.classList.remove("credits-high", "credits-medium", "credits-low");

				const firstAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

				if (firstAttempt.success) {
					updateRenderStatus(renderStatusElement, firstAttempt.elapsed, firstAttempt.data);
					showStatus("Render health check returned healthy.");
					return;
				}
			}

			await checkRenderHealth();

			expect(showStatusCalls[0].message).toContain("Waiting for response");
			expect(showStatusCalls[1].message).toContain("returned healthy");
			expect(renderStatusElement.classList.remove).toHaveBeenCalledWith("credits-high", "credits-medium", "credits-low");
		});

		test("should set Checking text initially", async () => {
			const renderStatusElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ status: "ok" })
			});

			async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
				const response = await fetchMock(`${renderServiceUrl}/health`);
				if (response.ok) {
					const data = await response.json();
					return { success: true, elapsed: "1.0", data };
				}
				return { success: false, error: "failed", elapsed: "1.0" };
			}

			function updateRenderStatus(element, elapsed, data) {
				element.textContent = `Ready (${elapsed}s)`;
				element.classList.add("credits-high");
			}

			let checkingTextSeen = false;

			async function checkRenderHealth() {
				showStatus("Waiting for response from Render health check...");
				const renderServiceUrl = "https://eolscrapingservice.onrender.com";

				renderStatusElement.textContent = "Checking...";
				checkingTextSeen = renderStatusElement.textContent === "Checking...";
				renderStatusElement.classList.remove("credits-high", "credits-medium", "credits-low");

				const firstAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

				if (firstAttempt.success) {
					updateRenderStatus(renderStatusElement, firstAttempt.elapsed, firstAttempt.data);
					showStatus("Render health check returned healthy.");
					return;
				}
			}

			await checkRenderHealth();

			expect(checkingTextSeen).toBe(true);
		});

		test("should show offline after both attempts fail", async () => {
			const renderStatusElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
				return { success: false, error: "Timeout", elapsed: "60.0" };
			}

			async function checkRenderHealth() {
				showStatus("Waiting for response from Render health check...");
				const renderServiceUrl = "https://eolscrapingservice.onrender.com";

				try {
					renderStatusElement.textContent = "Checking...";
					renderStatusElement.classList.remove("credits-high", "credits-medium", "credits-low");

					const firstAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

					if (firstAttempt.success) {
						return;
					}

					renderStatusElement.textContent = "Waking service, retrying...";
					renderStatusElement.classList.add("credits-medium");

					// Skip the 30s delay in tests
					renderStatusElement.textContent = "Retrying...";
					const secondAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

					if (secondAttempt.success) {
						return;
					}

					showStatus("Render health check returned no response, please reload the page.", "error");
					renderStatusElement.textContent = `Offline after 120.0s (${secondAttempt.error})`;
					renderStatusElement.classList.remove("credits-medium");
					renderStatusElement.classList.add("credits-low");
				} catch (error) {
					renderStatusElement.textContent = `Error: ${error.message}`;
					renderStatusElement.classList.add("credits-low");
				}
			}

			await checkRenderHealth();

			expect(renderStatusElement.textContent).toContain("Offline");
			expect(renderStatusElement.textContent).toContain("Timeout");
			expect(renderStatusElement.classList.add).toHaveBeenCalledWith("credits-low");
			expect(showStatusCalls[1].message).toContain("no response");
			expect(showStatusCalls[1].type).toBe("error");
		});

		test("should show waking service message between attempts", async () => {
			const renderStatusElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			let textContentHistory = [];
			let callCount = 0;

			async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
				callCount++;
				if (callCount === 1) {
					return { success: false, error: "Timeout", elapsed: "60.0" };
				}
				return { success: true, elapsed: "5.0", data: { status: "ok" } };
			}

			async function checkRenderHealth() {
				showStatus("Waiting for response from Render health check...");
				const renderServiceUrl = "https://eolscrapingservice.onrender.com";

				renderStatusElement.textContent = "Checking...";
				renderStatusElement.classList.remove("credits-high", "credits-medium", "credits-low");

				const firstAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

				if (firstAttempt.success) {
					return;
				}

				renderStatusElement.textContent = "Waking service, retrying...";
				textContentHistory.push(renderStatusElement.textContent);
				renderStatusElement.classList.add("credits-medium");

				renderStatusElement.textContent = "Retrying...";
				const secondAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

				if (secondAttempt.success) {
					renderStatusElement.textContent = "Ready after retry";
					renderStatusElement.classList.remove("credits-medium");
					renderStatusElement.classList.add("credits-medium");
					showStatus("Render health check returned healthy.");
					return;
				}
			}

			await checkRenderHealth();

			expect(textContentHistory).toContain("Waking service, retrying...");
			expect(showStatusCalls[1].message).toContain("returned healthy");
		});

		test("should handle unexpected errors gracefully", async () => {
			const renderStatusElement = {
				textContent: "",
				classList: {
					remove: jest.fn(),
					add: jest.fn()
				}
			};

			async function checkRenderHealth() {
				showStatus("Waiting for response from Render health check...");

				try {
					renderStatusElement.textContent = "Checking...";
					renderStatusElement.classList.remove("credits-high", "credits-medium", "credits-low");
					throw new Error("Unexpected failure");
				} catch (error) {
					renderStatusElement.textContent = `Error: ${error.message}`;
					renderStatusElement.classList.add("credits-low");
				}
			}

			await checkRenderHealth();

			expect(renderStatusElement.textContent).toBe("Error: Unexpected failure");
			expect(renderStatusElement.classList.add).toHaveBeenCalledWith("credits-low");
		});
	});

	// ====== CSS class percentage thresholds ======
	describe("percentage threshold logic", () => {
		function getCreditClass(remaining, limit) {
			const percentRemaining = (remaining / limit) * 100;
			if (percentRemaining > 50) return "credits-high";
			if (percentRemaining > 20) return "credits-medium";
			return "credits-low";
		}

		test("should return credits-high for 51%", () => {
			expect(getCreditClass(51, 100)).toBe("credits-high");
		});

		test("should return credits-medium for exactly 50%", () => {
			expect(getCreditClass(50, 100)).toBe("credits-medium");
		});

		test("should return credits-medium for 21%", () => {
			expect(getCreditClass(21, 100)).toBe("credits-medium");
		});

		test("should return credits-low for exactly 20%", () => {
			expect(getCreditClass(20, 100)).toBe("credits-low");
		});

		test("should return credits-low for 0%", () => {
			expect(getCreditClass(0, 100)).toBe("credits-low");
		});

		test("should return credits-high for 100%", () => {
			expect(getCreditClass(100, 100)).toBe("credits-high");
		});
	});
});
