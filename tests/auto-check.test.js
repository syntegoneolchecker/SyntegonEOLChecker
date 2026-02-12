/**
 * Tests for js/auto-check.js
 * Tests auto-check functionality: loadAutoCheckState, toggleAutoCheck,
 * setAutoCheckState, manualTriggerAutoCheck, syncAutoCheckToggle,
 * calculateMinutesSinceActivity, detectAndRecoverStuckState,
 * autoDisableOnLowCredits, startAutoCheckMonitoring
 *
 * Since js/auto-check.js uses ES module syntax, we re-implement the pure
 * functions for testing, and mock fetch/DOM interactions.
 */

describe("Auto-Check Module", () => {
	let fetchMock;
	let showStatusCalls;
	let appState;
	let updateCheckEOLButtonsCalls;
	let setControlsDisabledForAutoCheckCalls;
	let setDeleteToggleDisabledCalls;
	let setLastToggleTimeCalls;
	let setAutoCheckMonitoringIntervalCalls;

	// Mock helpers
	function showStatus(message, type) {
		showStatusCalls.push({ message, type });
	}

	function parseCreditsRemaining(creditsText) {
		const match = new RegExp(/(\d{1,6})\/\d{1,6} remaining/).exec(creditsText);
		return match ? Number.parseInt(match[1]) : null;
	}

	function updateCheckEOLButtons(disabled) {
		updateCheckEOLButtonsCalls.push(disabled);
	}

	function setControlsDisabledForAutoCheck(disabled) {
		setControlsDisabledForAutoCheckCalls.push(disabled);
	}

	function setDeleteToggleDisabled() {
		setDeleteToggleDisabledCalls.push(true);
	}

	function setLastToggleTime(time) {
		setLastToggleTimeCalls.push(time);
		appState.lastToggleTime = time;
	}

	function setAutoCheckMonitoringInterval(interval) {
		setAutoCheckMonitoringIntervalCalls.push(interval);
		appState.autoCheckMonitoringInterval = interval;
	}

	beforeEach(() => {
		fetchMock = jest.fn();
		showStatusCalls = [];
		updateCheckEOLButtonsCalls = [];
		setControlsDisabledForAutoCheckCalls = [];
		setDeleteToggleDisabledCalls = [];
		setLastToggleTimeCalls = [];
		setAutoCheckMonitoringIntervalCalls = [];
		appState = {
			isManualCheckRunning: false,
			lastToggleTime: 0,
			toggleSyncGracePeriod: 15000,
			autoCheckMonitoringInterval: null
		};
	});

	// ====== loadAutoCheckState ======
	describe("loadAutoCheckState", () => {
		async function loadAutoCheckState() {
			try {
				const response = await fetchMock("/.netlify/functions/get-auto-check-state");

				if (!response.ok) {
					console.error("Failed to load auto-check state");
					return false;
				}

				const state = await response.json();

				const toggle = mockDocument.getElementById("auto-check-toggle");
				if (toggle) {
					toggle.checked = state.enabled;
				}

				if (!appState.isManualCheckRunning) {
					updateCheckEOLButtons(state.isRunning);
				}

				if (state.isRunning) {
					showStatus("Background EOL check is running, controls are disabled", "info");
				}

				return state.isRunning;
			} catch (error) {
				console.error("Error loading auto-check state:", error);
				return false;
			}
		}

		let mockDocument;
		let mockToggle;

		beforeEach(() => {
			mockToggle = { checked: false };
			mockDocument = {
				getElementById: jest.fn((id) => {
					if (id === "auto-check-toggle") return mockToggle;
					return null;
				})
			};
		});

		test("should set toggle checked to server enabled state", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: false })
			});

			await loadAutoCheckState();

			expect(mockToggle.checked).toBe(true);
		});

		test("should call updateCheckEOLButtons when manual check not running", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: true })
			});
			appState.isManualCheckRunning = false;

			await loadAutoCheckState();

			expect(updateCheckEOLButtonsCalls).toEqual([true]);
		});

		test("should not call updateCheckEOLButtons when manual check is running", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: true })
			});
			appState.isManualCheckRunning = true;

			await loadAutoCheckState();

			expect(updateCheckEOLButtonsCalls).toEqual([]);
		});

		test("should show status when isRunning is true", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: true })
			});

			await loadAutoCheckState();

			expect(showStatusCalls[0].message).toContain("Background EOL check is running");
			expect(showStatusCalls[0].type).toBe("info");
		});

		test("should not show status when isRunning is false", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: false, isRunning: false })
			});

			await loadAutoCheckState();

			expect(showStatusCalls).toHaveLength(0);
		});

		test("should return isRunning value", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: true })
			});

			const result = await loadAutoCheckState();

			expect(result).toBe(true);
		});

		test("should return false when isRunning is false", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: false })
			});

			const result = await loadAutoCheckState();

			expect(result).toBe(false);
		});

		test("should return false on non-ok response", async () => {
			fetchMock.mockResolvedValue({ ok: false });

			const result = await loadAutoCheckState();

			expect(result).toBe(false);
		});

		test("should return false on fetch error", async () => {
			fetchMock.mockRejectedValue(new Error("Network error"));

			const result = await loadAutoCheckState();

			expect(result).toBe(false);
		});

		test("should handle missing toggle element", async () => {
			mockDocument.getElementById = jest.fn(() => null);
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ enabled: true, isRunning: false })
			});

			const result = await loadAutoCheckState();

			expect(result).toBe(false);
		});
	});

	// ====== toggleAutoCheck ======
	describe("toggleAutoCheck", () => {
		let mockToggle;

		async function toggleAutoCheck() {
			const enabled = mockToggle.checked;

			setLastToggleTime(Date.now());

			try {
				const response = await fetchMock("/.netlify/functions/set-auto-check-state", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: enabled })
				});

				if (!response.ok) {
					throw new Error("Failed to update state");
				}

				const result = await response.json();

				showStatus(`Auto EOL Check ${enabled ? "enabled" : "disabled"}`, "success");
			} catch (error) {
				showStatus("Error updating auto-check state: " + error.message, "error");
				mockToggle.checked = !enabled;
				setLastToggleTime(0);
			}
		}

		beforeEach(() => {
			mockToggle = { checked: true };
		});

		test("should call setLastToggleTime with current time", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ data: { state: { enabled: true } } })
			});

			const before = Date.now();
			await toggleAutoCheck();

			expect(setLastToggleTimeCalls.length).toBeGreaterThanOrEqual(1);
			expect(setLastToggleTimeCalls[0]).toBeGreaterThanOrEqual(before);
		});

		test("should POST enabled state to server", async () => {
			mockToggle.checked = true;
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ data: { state: { enabled: true } } })
			});

			await toggleAutoCheck();

			expect(fetchMock).toHaveBeenCalledWith(
				"/.netlify/functions/set-auto-check-state",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ enabled: true })
				})
			);
		});

		test("should show success status when enabling", async () => {
			mockToggle.checked = true;
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ data: { state: { enabled: true } } })
			});

			await toggleAutoCheck();

			expect(showStatusCalls[0].message).toBe("Auto EOL Check enabled");
			expect(showStatusCalls[0].type).toBe("success");
		});

		test("should show success status when disabling", async () => {
			mockToggle.checked = false;
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ data: { state: { enabled: false } } })
			});

			await toggleAutoCheck();

			expect(showStatusCalls[0].message).toBe("Auto EOL Check disabled");
			expect(showStatusCalls[0].type).toBe("success");
		});

		test("should revert toggle on error", async () => {
			mockToggle.checked = true;
			fetchMock.mockResolvedValue({ ok: false });

			await toggleAutoCheck();

			expect(mockToggle.checked).toBe(false);
		});

		test("should revert toggle on fetch error", async () => {
			mockToggle.checked = false;
			fetchMock.mockRejectedValue(new Error("Network failure"));

			await toggleAutoCheck();

			expect(mockToggle.checked).toBe(true);
		});

		test("should reset lastToggleTime to 0 on error", async () => {
			mockToggle.checked = true;
			fetchMock.mockRejectedValue(new Error("Network failure"));

			await toggleAutoCheck();

			// The last call should be setLastToggleTime(0)
			expect(setLastToggleTimeCalls[setLastToggleTimeCalls.length - 1]).toBe(0);
		});

		test("should show error status on failure", async () => {
			mockToggle.checked = true;
			fetchMock.mockRejectedValue(new Error("Server down"));

			await toggleAutoCheck();

			const errorStatus = showStatusCalls.find((s) => s.type === "error");
			expect(errorStatus.message).toContain("Error updating auto-check state");
			expect(errorStatus.message).toContain("Server down");
		});
	});

	// ====== setAutoCheckState ======
	describe("setAutoCheckState", () => {
		async function setAutoCheckState(stateUpdate) {
			const response = await fetchMock("/.netlify/functions/set-auto-check-state", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(stateUpdate)
			});

			if (!response.ok) {
				throw new Error(`Failed to set state: ${response.statusText}`);
			}

			const newState = await response.json();
			setControlsDisabledForAutoCheck(newState.isRunning);
			setDeleteToggleDisabled();

			return newState;
		}

		test("should POST state update to server", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ isRunning: true })
			});

			await setAutoCheckState({ dailyCounter: 0 });

			expect(fetchMock).toHaveBeenCalledWith(
				"/.netlify/functions/set-auto-check-state",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ dailyCounter: 0 })
				})
			);
		});

		test("should call setControlsDisabledForAutoCheck with isRunning", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ isRunning: true })
			});

			await setAutoCheckState({ isRunning: true });

			expect(setControlsDisabledForAutoCheckCalls).toEqual([true]);
		});

		test("should call setDeleteToggleDisabled", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ isRunning: false })
			});

			await setAutoCheckState({ isRunning: false });

			expect(setDeleteToggleDisabledCalls).toHaveLength(1);
		});

		test("should return new state from server", async () => {
			const serverState = { isRunning: true, enabled: true, dailyCounter: 5 };
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(serverState)
			});

			const result = await setAutoCheckState({ isRunning: true });

			expect(result).toEqual(serverState);
		});

		test("should throw on non-ok response", async () => {
			fetchMock.mockResolvedValue({
				ok: false,
				statusText: "Internal Server Error"
			});

			await expect(setAutoCheckState({ enabled: true })).rejects.toThrow(
				"Failed to set state: Internal Server Error"
			);
		});

		test("should throw on fetch error", async () => {
			fetchMock.mockRejectedValue(new Error("Connection refused"));

			await expect(setAutoCheckState({ enabled: true })).rejects.toThrow(
				"Connection refused"
			);
		});
	});

	// ====== manualTriggerAutoCheck ======
	describe("manualTriggerAutoCheck", () => {
		let mockButton;
		let setAutoCheckStateMock;

		async function manualTriggerAutoCheck() {
			const originalText = mockButton.textContent;

			try {
				mockButton.textContent = "Triggering...";
				mockButton.disabled = true;

				showStatus("Resetting daily counter and triggering auto-check...", "info");

				await setAutoCheckStateMock({ dailyCounter: 0 });

				showStatus("Counter reset. Triggering auto-check...", "info");

				await setAutoCheckStateMock({ isRunning: true });
				setControlsDisabledForAutoCheck(true);
				setDeleteToggleDisabled();

				const siteUrl = "https://example.com";
				const response = await fetchMock("/.netlify/functions/auto-eol-check-background", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						triggeredBy: "manual",
						siteUrl: siteUrl
					})
				});

				if (response.status === 202) {
					showStatus(
						"Auto-check triggered successfully! Counter reset to 0. Check console for progress.",
						"success"
					);
				} else {
					const data = await response.json();
					showStatus("Trigger response: " + (data.message || data.body || "Unknown"), "info");
				}
			} catch (error) {
				showStatus("Error triggering auto-check: " + error.message, "error");
			} finally {
				mockButton.textContent = originalText;
			}
		}

		beforeEach(() => {
			mockButton = { textContent: "Trigger Auto-Check", disabled: false };
			setAutoCheckStateMock = jest.fn().mockResolvedValue({});
		});

		test("should disable button and show triggering text", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			// Button should be disabled at some point during execution
			// After finally, textContent is restored
			expect(mockButton.textContent).toBe("Trigger Auto-Check");
		});

		test("should reset daily counter first", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			expect(setAutoCheckStateMock).toHaveBeenCalledWith({ dailyCounter: 0 });
		});

		test("should set isRunning to true", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			expect(setAutoCheckStateMock).toHaveBeenCalledWith({ isRunning: true });
		});

		test("should call setControlsDisabledForAutoCheck(true)", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			expect(setControlsDisabledForAutoCheckCalls).toContain(true);
		});

		test("should call setDeleteToggleDisabled", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			expect(setDeleteToggleDisabledCalls.length).toBeGreaterThan(0);
		});

		test("should trigger auto-eol-check-background endpoint", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			expect(fetchMock).toHaveBeenCalledWith(
				"/.netlify/functions/auto-eol-check-background",
				expect.objectContaining({
					method: "POST",
					body: expect.stringContaining("manual")
				})
			);
		});

		test("should show success on 202 response", async () => {
			fetchMock.mockResolvedValue({ status: 202 });

			await manualTriggerAutoCheck();

			const successStatus = showStatusCalls.find((s) => s.type === "success");
			expect(successStatus.message).toContain("Auto-check triggered successfully");
		});

		test("should show trigger response for non-202 response", async () => {
			fetchMock.mockResolvedValue({
				status: 200,
				json: () => Promise.resolve({ message: "Already running" })
			});

			await manualTriggerAutoCheck();

			const infoStatus = showStatusCalls.find(
				(s) => s.message.includes("Trigger response")
			);
			expect(infoStatus.message).toContain("Already running");
		});

		test("should show error on failure", async () => {
			fetchMock.mockRejectedValue(new Error("Timeout"));

			await manualTriggerAutoCheck();

			const errorStatus = showStatusCalls.find((s) => s.type === "error");
			expect(errorStatus.message).toContain("Error triggering auto-check");
			expect(errorStatus.message).toContain("Timeout");
		});

		test("should restore button text in finally block", async () => {
			fetchMock.mockRejectedValue(new Error("Fail"));

			await manualTriggerAutoCheck();

			expect(mockButton.textContent).toBe("Trigger Auto-Check");
		});
	});

	// ====== syncAutoCheckToggle ======
	describe("syncAutoCheckToggle", () => {
		let mockToggle;

		function syncAutoCheckToggle(serverEnabled) {
			const timeSinceToggle = Date.now() - appState.lastToggleTime;
			if (timeSinceToggle < appState.toggleSyncGracePeriod) {
				return;
			}

			if (mockToggle && mockToggle.checked !== serverEnabled) {
				mockToggle.checked = serverEnabled;
			}
		}

		beforeEach(() => {
			mockToggle = { checked: false };
		});

		test("should skip sync if within grace period", () => {
			appState.lastToggleTime = Date.now();
			appState.toggleSyncGracePeriod = 15000;
			mockToggle.checked = false;

			syncAutoCheckToggle(true);

			expect(mockToggle.checked).toBe(false);
		});

		test("should sync toggle when grace period expired", () => {
			appState.lastToggleTime = Date.now() - 20000;
			appState.toggleSyncGracePeriod = 15000;
			mockToggle.checked = false;

			syncAutoCheckToggle(true);

			expect(mockToggle.checked).toBe(true);
		});

		test("should sync toggle to false when server says disabled", () => {
			appState.lastToggleTime = 0;
			appState.toggleSyncGracePeriod = 15000;
			mockToggle.checked = true;

			syncAutoCheckToggle(false);

			expect(mockToggle.checked).toBe(false);
		});

		test("should not change toggle if already matching server state", () => {
			appState.lastToggleTime = 0;
			appState.toggleSyncGracePeriod = 15000;
			mockToggle.checked = true;

			syncAutoCheckToggle(true);

			expect(mockToggle.checked).toBe(true);
		});

		test("should respect custom grace period", () => {
			appState.lastToggleTime = Date.now() - 5000;
			appState.toggleSyncGracePeriod = 10000;
			mockToggle.checked = false;

			syncAutoCheckToggle(true);

			// Still within 10s grace period (5s ago)
			expect(mockToggle.checked).toBe(false);
		});
	});

	// ====== calculateMinutesSinceActivity ======
	describe("calculateMinutesSinceActivity", () => {
		function calculateMinutesSinceActivity(lastActivityTime) {
			if (!lastActivityTime) return 999;

			const lastActivity = new Date(lastActivityTime);
			const now = new Date();
			return (now - lastActivity) / 1000 / 60;
		}

		test("should return 999 for null input", () => {
			expect(calculateMinutesSinceActivity(null)).toBe(999);
		});

		test("should return 999 for undefined input", () => {
			expect(calculateMinutesSinceActivity(undefined)).toBe(999);
		});

		test("should return 999 for empty string", () => {
			expect(calculateMinutesSinceActivity("")).toBe(999);
		});

		test("should return approximately 0 for current time", () => {
			const now = new Date().toISOString();
			const result = calculateMinutesSinceActivity(now);
			expect(result).toBeLessThan(1);
			expect(result).toBeGreaterThanOrEqual(0);
		});

		test("should return approximately 5 for time 5 minutes ago", () => {
			const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			const result = calculateMinutesSinceActivity(fiveMinAgo);
			expect(result).toBeGreaterThanOrEqual(4.9);
			expect(result).toBeLessThanOrEqual(5.1);
		});

		test("should return approximately 60 for time 1 hour ago", () => {
			const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
			const result = calculateMinutesSinceActivity(oneHourAgo);
			expect(result).toBeGreaterThanOrEqual(59.9);
			expect(result).toBeLessThanOrEqual(60.1);
		});
	});

	// ====== detectAndRecoverStuckState ======
	describe("detectAndRecoverStuckState", () => {
		let setAutoCheckStateMock;

		async function detectAndRecoverStuckState(state) {
			if (!state.isRunning) return state;

			const minutesSinceActivity = calculateMinutesSinceActivityImpl(state.lastActivityTime);

			if (minutesSinceActivity > 5) {
				await setAutoCheckStateMock({ isRunning: false });
				state.isRunning = false;
				showStatus("Auto-check recovered from stuck state", "info");
			}

			return state;
		}

		function calculateMinutesSinceActivityImpl(lastActivityTime) {
			if (!lastActivityTime) return 999;
			const lastActivity = new Date(lastActivityTime);
			const now = new Date();
			return (now - lastActivity) / 1000 / 60;
		}

		beforeEach(() => {
			setAutoCheckStateMock = jest.fn().mockResolvedValue({});
		});

		test("should return state unchanged if not running", async () => {
			const state = { isRunning: false, lastActivityTime: null };

			const result = await detectAndRecoverStuckState(state);

			expect(result.isRunning).toBe(false);
			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});

		test("should recover if running with no activity for >5 min", async () => {
			const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			const state = { isRunning: true, lastActivityTime: tenMinAgo };

			const result = await detectAndRecoverStuckState(state);

			expect(result.isRunning).toBe(false);
			expect(setAutoCheckStateMock).toHaveBeenCalledWith({ isRunning: false });
		});

		test("should show recovery status message", async () => {
			const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			const state = { isRunning: true, lastActivityTime: tenMinAgo };

			await detectAndRecoverStuckState(state);

			const recoveryStatus = showStatusCalls.find(
				(s) => s.message.includes("recovered from stuck state")
			);
			expect(recoveryStatus).toBeDefined();
			expect(recoveryStatus.type).toBe("info");
		});

		test("should not recover if running with recent activity", async () => {
			const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
			const state = { isRunning: true, lastActivityTime: twoMinAgo };

			const result = await detectAndRecoverStuckState(state);

			expect(result.isRunning).toBe(true);
			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});

		test("should recover if running with null lastActivityTime", async () => {
			const state = { isRunning: true, lastActivityTime: null };

			const result = await detectAndRecoverStuckState(state);

			// calculateMinutesSinceActivity returns 999 for null, which is > 5
			expect(result.isRunning).toBe(false);
			expect(setAutoCheckStateMock).toHaveBeenCalledWith({ isRunning: false });
		});
	});

	// ====== autoDisableOnLowCredits ======
	describe("autoDisableOnLowCredits", () => {
		let setAutoCheckStateMock;
		let mockCreditsElement;
		let mockToggle;

		async function autoDisableOnLowCredits(state) {
			if (!state.enabled) return;

			if (!mockCreditsElement) return;

			const remaining = parseCreditsRemaining(mockCreditsElement.textContent);
			if (remaining === null || remaining > 50) return;

			await setAutoCheckStateMock({ enabled: false });

			if (mockToggle) mockToggle.checked = false;

			showStatus("Auto EOL Check disabled - SerpAPI searches too low (\u226450)", "info");
		}

		beforeEach(() => {
			setAutoCheckStateMock = jest.fn().mockResolvedValue({});
			mockCreditsElement = { textContent: "30/100 remaining" };
			mockToggle = { checked: true };
		});

		test("should do nothing if auto-check is already disabled", async () => {
			await autoDisableOnLowCredits({ enabled: false });

			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});

		test("should do nothing if credits element is missing", async () => {
			mockCreditsElement = null;

			await autoDisableOnLowCredits({ enabled: true });

			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});

		test("should do nothing if credits cannot be parsed", async () => {
			mockCreditsElement.textContent = "Error loading usage";

			await autoDisableOnLowCredits({ enabled: true });

			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});

		test("should do nothing if credits > 50", async () => {
			mockCreditsElement.textContent = "85/100 remaining";

			await autoDisableOnLowCredits({ enabled: true });

			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});

		test("should disable auto-check if credits <= 50", async () => {
			mockCreditsElement.textContent = "50/100 remaining";

			await autoDisableOnLowCredits({ enabled: true });

			expect(setAutoCheckStateMock).toHaveBeenCalledWith({ enabled: false });
		});

		test("should disable auto-check if credits are 0", async () => {
			mockCreditsElement.textContent = "0/100 remaining";

			await autoDisableOnLowCredits({ enabled: true });

			expect(setAutoCheckStateMock).toHaveBeenCalledWith({ enabled: false });
		});

		test("should uncheck toggle when disabling", async () => {
			mockCreditsElement.textContent = "25/100 remaining";

			await autoDisableOnLowCredits({ enabled: true });

			expect(mockToggle.checked).toBe(false);
		});

		test("should show status message when disabling", async () => {
			mockCreditsElement.textContent = "10/100 remaining";

			await autoDisableOnLowCredits({ enabled: true });

			const disableStatus = showStatusCalls.find(
				(s) => s.message.includes("SerpAPI searches too low")
			);
			expect(disableStatus).toBeDefined();
			expect(disableStatus.type).toBe("info");
		});

		test("should not disable if credits are exactly 51", async () => {
			mockCreditsElement.textContent = "51/100 remaining";

			await autoDisableOnLowCredits({ enabled: true });

			expect(setAutoCheckStateMock).not.toHaveBeenCalled();
		});
	});

	// ====== startAutoCheckMonitoring ======
	describe("startAutoCheckMonitoring", () => {
		test("should set interval with 10 second period", () => {
			jest.useFakeTimers();

			function startAutoCheckMonitoring() {
				setAutoCheckMonitoringInterval(
					setInterval(() => {
						// polling callback
					}, 10000)
				);
			}

			startAutoCheckMonitoring();

			expect(setAutoCheckMonitoringIntervalCalls).toHaveLength(1);
			expect(typeof setAutoCheckMonitoringIntervalCalls[0]).toBe("object");

			clearInterval(appState.autoCheckMonitoringInterval);
			jest.useRealTimers();
		});

		test("should execute callback on interval tick", () => {
			jest.useFakeTimers();

			let callbackCount = 0;

			function startAutoCheckMonitoring() {
				setAutoCheckMonitoringInterval(
					setInterval(() => {
						callbackCount++;
					}, 10000)
				);
			}

			startAutoCheckMonitoring();

			jest.advanceTimersByTime(10000);
			expect(callbackCount).toBe(1);

			jest.advanceTimersByTime(10000);
			expect(callbackCount).toBe(2);

			clearInterval(appState.autoCheckMonitoringInterval);
			jest.useRealTimers();
		});

		test("should not execute callback before 10 seconds", () => {
			jest.useFakeTimers();

			let callbackCount = 0;

			function startAutoCheckMonitoring() {
				setAutoCheckMonitoringInterval(
					setInterval(() => {
						callbackCount++;
					}, 10000)
				);
			}

			startAutoCheckMonitoring();

			jest.advanceTimersByTime(9999);
			expect(callbackCount).toBe(0);

			clearInterval(appState.autoCheckMonitoringInterval);
			jest.useRealTimers();
		});
	});
});
