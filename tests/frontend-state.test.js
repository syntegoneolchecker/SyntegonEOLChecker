// =============================================================================
// Tests for js/state.js - Global State Management
// =============================================================================

import {
	state,
	setData,
	setOriginalData,
	setIsManualCheckRunning,
	setGroqCountdownInterval,
	setGroqResetTimestamp,
	setAutoCheckMonitoringInterval,
	setLastToggleTime,
	setInitComplete,
	setCurrentUser,
	resetSortState
} from "../js/state.js";

describe("js/state.js - Global State Management", () => {
	// Store original values so we can restore after each test
	let originalData;
	let originalOriginalData;
	let originalCurrentSort;
	let originalIsManualCheckRunning;
	let originalGroqCountdownInterval;
	let originalGroqResetTimestamp;
	let originalAutoCheckMonitoringInterval;
	let originalLastToggleTime;
	let originalToggleSyncGracePeriod;
	let originalInitComplete;
	let originalCurrentUser;

	beforeEach(() => {
		// Save original values
		originalData = state.data;
		originalOriginalData = state.originalData;
		originalCurrentSort = { ...state.currentSort };
		originalIsManualCheckRunning = state.isManualCheckRunning;
		originalGroqCountdownInterval = state.groqCountdownInterval;
		originalGroqResetTimestamp = state.groqResetTimestamp;
		originalAutoCheckMonitoringInterval = state.autoCheckMonitoringInterval;
		originalLastToggleTime = state.lastToggleTime;
		originalToggleSyncGracePeriod = state.toggleSyncGracePeriod;
		originalInitComplete = state.initComplete;
		originalCurrentUser = state.currentUser;
	});

	afterEach(() => {
		// Restore original values to avoid test pollution
		state.data = originalData;
		state.originalData = originalOriginalData;
		state.currentSort.column = originalCurrentSort.column;
		state.currentSort.direction = originalCurrentSort.direction;
		state.isManualCheckRunning = originalIsManualCheckRunning;
		state.groqCountdownInterval = originalGroqCountdownInterval;
		state.groqResetTimestamp = originalGroqResetTimestamp;
		state.autoCheckMonitoringInterval = originalAutoCheckMonitoringInterval;
		state.lastToggleTime = originalLastToggleTime;
		state.toggleSyncGracePeriod = originalToggleSyncGracePeriod;
		state.initComplete = originalInitComplete;
		state.currentUser = originalCurrentUser;
	});

	test("state initializes with correct default values", () => {
		// data should be an array with one header row
		expect(Array.isArray(state.data)).toBe(true);
		expect(state.data.length).toBe(1);
		expect(state.data[0]).toEqual([
			"SAP Part Number",
			"Legacy Part Number",
			"Designation",
			"Model",
			"Manufacturer",
			"Status",
			"Status Comment",
			"Successor Model",
			"Successor Comment",
			"Successor SAP Number",
			"Stock",
			"Information Date",
			"Auto Check"
		]);

		expect(state.originalData).toBeNull();
		expect(state.currentSort).toEqual({ column: null, direction: null });
		expect(state.isManualCheckRunning).toBe(false);
		expect(state.groqCountdownInterval).toBeNull();
		expect(state.groqResetTimestamp).toBeNull();
		expect(state.autoCheckMonitoringInterval).toBeNull();
		expect(state.lastToggleTime).toBe(0);
		expect(state.toggleSyncGracePeriod).toBe(15000);
		expect(state.initComplete).toBe(false);
		expect(state.currentUser).toEqual({});
	});

	test("setData updates state.data", () => {
		const newData = [
			["SAP Part Number", "Legacy Part Number"],
			["1-234-567-890", "L001"]
		];
		setData(newData);
		expect(state.data).toBe(newData);
		expect(state.data.length).toBe(2);
		expect(state.data[1][0]).toBe("1-234-567-890");
	});

	test("setOriginalData updates state.originalData", () => {
		expect(state.originalData).toBeNull();

		const newOriginalData = [
			["SAP Part Number"],
			["9-876-543-210"]
		];
		setOriginalData(newOriginalData);
		expect(state.originalData).toBe(newOriginalData);
		expect(state.originalData[1][0]).toBe("9-876-543-210");

		// Setting back to null
		setOriginalData(null);
		expect(state.originalData).toBeNull();
	});

	test("setIsManualCheckRunning updates state.isManualCheckRunning", () => {
		expect(state.isManualCheckRunning).toBe(false);

		setIsManualCheckRunning(true);
		expect(state.isManualCheckRunning).toBe(true);

		setIsManualCheckRunning(false);
		expect(state.isManualCheckRunning).toBe(false);
	});

	test("setGroqCountdownInterval and setGroqResetTimestamp update correctly", () => {
		expect(state.groqCountdownInterval).toBeNull();
		expect(state.groqResetTimestamp).toBeNull();

		const mockInterval = 42;
		setGroqCountdownInterval(mockInterval);
		expect(state.groqCountdownInterval).toBe(42);

		const timestamp = 1700000000000;
		setGroqResetTimestamp(timestamp);
		expect(state.groqResetTimestamp).toBe(1700000000000);

		// Reset
		setGroqCountdownInterval(null);
		setGroqResetTimestamp(null);
		expect(state.groqCountdownInterval).toBeNull();
		expect(state.groqResetTimestamp).toBeNull();
	});

	test("setAutoCheckMonitoringInterval and setLastToggleTime update correctly", () => {
		const interval = 99;
		setAutoCheckMonitoringInterval(interval);
		expect(state.autoCheckMonitoringInterval).toBe(99);

		const time = Date.now();
		setLastToggleTime(time);
		expect(state.lastToggleTime).toBe(time);
	});

	test("setInitComplete updates state.initComplete", () => {
		expect(state.initComplete).toBe(false);

		setInitComplete(true);
		expect(state.initComplete).toBe(true);

		setInitComplete(false);
		expect(state.initComplete).toBe(false);
	});

	test("setCurrentUser updates state.currentUser", () => {
		const user = { name: "TestUser", email: "test@example.com" };
		setCurrentUser(user);
		expect(state.currentUser).toBe(user);
		expect(state.currentUser.name).toBe("TestUser");
		expect(state.currentUser.email).toBe("test@example.com");
	});

	test("resetSortState resets column and direction to null", () => {
		// Set some sorting state first
		state.currentSort.column = 3;
		state.currentSort.direction = "asc";

		expect(state.currentSort.column).toBe(3);
		expect(state.currentSort.direction).toBe("asc");

		resetSortState();

		expect(state.currentSort.column).toBeNull();
		expect(state.currentSort.direction).toBeNull();
	});
});
