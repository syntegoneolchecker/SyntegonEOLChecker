// =============================================================================
// Tests for js/api.js - Server Integration with Retry Logic
// =============================================================================

import { state } from "../js/state.js";
import { loadFromServer, saveToServer } from "../js/api.js";

// Mock document for showStatus calls
beforeAll(() => {
	global.document = {
		getElementById: jest.fn(() => ({
			innerHTML: "",
			textContent: "",
			className: "",
			disabled: false,
			classList: {
				add: jest.fn(),
				remove: jest.fn()
			},
			querySelector: jest.fn(() => ({
				textContent: "",
				disabled: false
			})),
			querySelectorAll: jest.fn(() => [])
		})),
		querySelectorAll: jest.fn(() => [])
	};
});

afterAll(() => {
	delete global.document;
	delete global.fetch;
});

describe("js/api.js - loadFromServer retry logic", () => {
	let savedData;
	let savedOriginalData;
	let savedCurrentSort;

	beforeEach(() => {
		// Save state
		savedData = state.data;
		savedOriginalData = state.originalData;
		savedCurrentSort = { ...state.currentSort };

		// Use fake timers to control delay()
		jest.useFakeTimers();

		// Reset fetch mock
		global.fetch = jest.fn();

		jest.spyOn(console, "log").mockImplementation(() => {});
		jest.spyOn(console, "error").mockImplementation(() => {});
		jest.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		// Restore state
		state.data = savedData;
		state.originalData = savedOriginalData;
		state.currentSort.column = savedCurrentSort.column;
		state.currentSort.direction = savedCurrentSort.direction;

		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	test("loadFromServer succeeds on first attempt with valid data", async () => {
		const validData = [
			["SAP Part Number", "Legacy Part Number"],
			["1-234-567-890", "L001"]
		];

		// All fetches succeed (data load + render's updateButtonStates)
		global.fetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: validData })
		});

		const loadPromise = loadFromServer();

		// Flush all pending promises and timers
		await jest.runAllTimersAsync();
		await loadPromise;

		// First call is the data load
		expect(global.fetch).toHaveBeenCalledWith("/.netlify/functions/get-csv");
		expect(state.data).toEqual(validData);
		expect(state.originalData).toBeNull();
	});

	test("loadFromServer retries on failure and succeeds on second attempt", async () => {
		const validData = [
			["SAP Part Number", "Legacy Part Number"],
			["1-234-567-890", "L001"]
		];

		// First attempt fails, then all others succeed (including render's fetch)
		global.fetch
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: "Server error" })
			})
			.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ data: validData })
			});

		const loadPromise = loadFromServer();

		// Run through all timers (including the retry delay)
		await jest.runAllTimersAsync();
		await loadPromise;

		// Verify data was loaded (after retry)
		expect(state.data).toEqual(validData);
	});

	test("loadFromServer handles all retries failing", async () => {
		// All attempts fail
		global.fetch.mockResolvedValue({
			ok: false,
			status: 500,
			json: () => Promise.resolve({ error: "Server error" })
		});

		const loadPromise = loadFromServer();

		await jest.runAllTimersAsync();
		await loadPromise;

		// Verify get-csv was called at least 4 times (initial + 3 retries)
		const getCsvCalls = global.fetch.mock.calls.filter(
			(call) => call[0] === "/.netlify/functions/get-csv"
		);
		expect(getCsvCalls.length).toBe(4);
	});

	test("loadFromServer uses exponential backoff between retries", async () => {
		const validData = [
			["SAP Part Number"],
			["1-234-567-890"]
		];

		// Track setTimeout calls through the delay function
		const setTimeoutSpy = jest.spyOn(global, "setTimeout");

		// First 3 attempts fail, 4th succeeds
		global.fetch
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: "Error" })
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: "Error" })
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				json: () => Promise.resolve({ error: "Error" })
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ data: validData })
			});

		const loadPromise = loadFromServer();

		await jest.runAllTimersAsync();
		await loadPromise;

		// Check that setTimeout was called with exponentially increasing delays
		// waitForRetry uses: 1000 * Math.pow(2, retry)
		// retry 0 -> 1000ms, retry 1 -> 2000ms, retry 2 -> 4000ms
		const timeoutCalls = setTimeoutSpy.mock.calls.map((call) => call[1]);

		// Filter for the delay calls (1000, 2000, 4000)
		expect(timeoutCalls).toContain(1000);
		expect(timeoutCalls).toContain(2000);
		expect(timeoutCalls).toContain(4000);

		setTimeoutSpy.mockRestore();
	});
});

describe("js/api.js - saveToServer", () => {
	let savedData;

	beforeEach(() => {
		savedData = state.data;
		state.data = [
			["SAP Part Number"],
			["1-234-567-890"]
		];
		global.fetch = jest.fn();
	});

	afterEach(() => {
		state.data = savedData;
	});

	test("saveToServer sends data via POST and handles success", async () => {
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		await saveToServer();

		expect(global.fetch).toHaveBeenCalledWith("/.netlify/functions/save-csv", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: state.data })
		});
	});

	test("saveToServer handles network error without throwing", async () => {
		global.fetch.mockRejectedValueOnce(new Error("Network failure"));

		// Should not throw
		await expect(saveToServer()).resolves.toBeUndefined();
	});
});
