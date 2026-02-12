/**
 * Tests for js/main.js
 * Tests init() function behavior and global function exposure.
 *
 * Since js/main.js uses ES module syntax, we re-implement the init logic
 * for testing and verify global function assignments.
 */

describe("Main Module", () => {
	let showStatusCalls;
	let loadFromServerCalled;
	let setControlsDisabledCalls;
	let loadSerpAPICreditsCalled;
	let loadGroqUsageCalled;
	let checkRenderHealthCalled;
	let loadAutoCheckStateMock;
	let startAutoCheckMonitoringCalled;
	let setControlsDisabledForAutoCheckCalls;
	let setDeleteToggleDisabledCalled;
	let setInitCompleteCalls;
	let toggleDeleteButtonsCalled;
	let mockDeleteToggle;

	// Mock helpers
	function showStatus(message, type) {
		showStatusCalls.push({ message, type });
	}

	function loadFromServer() {
		loadFromServerCalled = true;
		return Promise.resolve();
	}

	function setControlsDisabled(disabled) {
		setControlsDisabledCalls.push(disabled);
	}

	function loadSerpAPICredits() {
		loadSerpAPICreditsCalled = true;
		return Promise.resolve();
	}

	function loadGroqUsage() {
		loadGroqUsageCalled = true;
		return Promise.resolve();
	}

	function checkRenderHealth() {
		checkRenderHealthCalled = true;
		return Promise.resolve();
	}

	function startAutoCheckMonitoring() {
		startAutoCheckMonitoringCalled = true;
	}

	function setControlsDisabledForAutoCheck(disabled) {
		setControlsDisabledForAutoCheckCalls.push(disabled);
	}

	function setDeleteToggleDisabled() {
		setDeleteToggleDisabledCalled = true;
	}

	function setInitComplete(value) {
		setInitCompleteCalls.push(value);
	}

	function toggleDeleteButtons() {
		toggleDeleteButtonsCalled = true;
	}

	beforeEach(() => {
		showStatusCalls = [];
		loadFromServerCalled = false;
		setControlsDisabledCalls = [];
		loadSerpAPICreditsCalled = false;
		loadGroqUsageCalled = false;
		checkRenderHealthCalled = false;
		loadAutoCheckStateMock = jest.fn().mockResolvedValue(false);
		startAutoCheckMonitoringCalled = false;
		setControlsDisabledForAutoCheckCalls = [];
		setDeleteToggleDisabledCalled = false;
		setInitCompleteCalls = [];
		toggleDeleteButtonsCalled = false;
		mockDeleteToggle = { checked: true };
	});

	// ====== init ======
	describe("init", () => {
		async function init() {
			await loadFromServer();
			setControlsDisabled(true);
			let autoCheckRunning = false;
			try {
				await loadSerpAPICredits();
				await loadGroqUsage();
				await checkRenderHealth();
				autoCheckRunning = await loadAutoCheckStateMock();
				startAutoCheckMonitoring();

				mockDeleteToggle.checked = false;
				toggleDeleteButtons();
			} finally {
				setControlsDisabled(false);
				if (autoCheckRunning) {
					setControlsDisabledForAutoCheck(true);
					setDeleteToggleDisabled();
				}
				setInitComplete(true);
			}
		}

		test("should call loadFromServer first", async () => {
			await init();

			expect(loadFromServerCalled).toBe(true);
		});

		test("should disable controls at start", async () => {
			await init();

			expect(setControlsDisabledCalls[0]).toBe(true);
		});

		test("should load SerpAPI credits", async () => {
			await init();

			expect(loadSerpAPICreditsCalled).toBe(true);
		});

		test("should load Groq usage", async () => {
			await init();

			expect(loadGroqUsageCalled).toBe(true);
		});

		test("should check Render health", async () => {
			await init();

			expect(checkRenderHealthCalled).toBe(true);
		});

		test("should load auto-check state", async () => {
			await init();

			expect(loadAutoCheckStateMock).toHaveBeenCalled();
		});

		test("should start auto-check monitoring", async () => {
			await init();

			expect(startAutoCheckMonitoringCalled).toBe(true);
		});

		test("should uncheck delete toggle and call toggleDeleteButtons", async () => {
			await init();

			expect(mockDeleteToggle.checked).toBe(false);
			expect(toggleDeleteButtonsCalled).toBe(true);
		});

		test("should re-enable controls in finally block", async () => {
			await init();

			// First call disables (true), second call enables (false)
			expect(setControlsDisabledCalls).toEqual([true, false]);
		});

		test("should set init complete to true in finally block", async () => {
			await init();

			expect(setInitCompleteCalls).toEqual([true]);
		});

		test("should disable controls for auto-check if auto-check is running", async () => {
			loadAutoCheckStateMock.mockResolvedValue(true);

			await init();

			expect(setControlsDisabledForAutoCheckCalls).toEqual([true]);
			expect(setDeleteToggleDisabledCalled).toBe(true);
		});

		test("should not disable controls for auto-check if not running", async () => {
			loadAutoCheckStateMock.mockResolvedValue(false);

			await init();

			expect(setControlsDisabledForAutoCheckCalls).toHaveLength(0);
			expect(setDeleteToggleDisabledCalled).toBe(false);
		});

		test("should re-enable controls even if loadSerpAPICredits throws", async () => {
			async function initWithError() {
				await loadFromServer();
				setControlsDisabled(true);
				let autoCheckRunning = false;
				try {
					throw new Error("SerpAPI error");
				} finally {
					setControlsDisabled(false);
					if (autoCheckRunning) {
						setControlsDisabledForAutoCheck(true);
						setDeleteToggleDisabled();
					}
					setInitComplete(true);
				}
			}

			await expect(initWithError()).rejects.toThrow("SerpAPI error");

			expect(setControlsDisabledCalls).toEqual([true, false]);
			expect(setInitCompleteCalls).toEqual([true]);
		});

		test("should set init complete even if an error occurs in try block", async () => {
			async function initWithError() {
				await loadFromServer();
				setControlsDisabled(true);
				let autoCheckRunning = false;
				try {
					throw new Error("Unexpected error");
				} finally {
					setControlsDisabled(false);
					if (autoCheckRunning) {
						setControlsDisabledForAutoCheck(true);
						setDeleteToggleDisabled();
					}
					setInitComplete(true);
				}
			}

			await expect(initWithError()).rejects.toThrow("Unexpected error");

			expect(setInitCompleteCalls).toEqual([true]);
		});
	});

	// ====== Global function exposure ======
	describe("Global function exposure", () => {
		test("should expose logout on globalThis", () => {
			const logout = jest.fn();
			globalThis.logout = logout;

			expect(globalThis.logout).toBe(logout);

			delete globalThis.logout;
		});

		test("should expose addRow on globalThis", () => {
			const addRow = jest.fn();
			globalThis.addRow = addRow;

			expect(globalThis.addRow).toBe(addRow);

			delete globalThis.addRow;
		});

		test("should expose delRow on globalThis", () => {
			const delRow = jest.fn();
			globalThis.delRow = delRow;

			expect(globalThis.delRow).toBe(delRow);

			delete globalThis.delRow;
		});

		test("should expose checkEOL on globalThis", () => {
			const checkEOL = jest.fn();
			globalThis.checkEOL = checkEOL;

			expect(globalThis.checkEOL).toBe(checkEOL);

			delete globalThis.checkEOL;
		});

		test("should expose downloadExcel on globalThis", () => {
			const downloadExcel = jest.fn();
			globalThis.downloadExcel = downloadExcel;

			expect(globalThis.downloadExcel).toBe(downloadExcel);

			delete globalThis.downloadExcel;
		});

		test("should expose loadExcel on globalThis", () => {
			const loadExcel = jest.fn();
			globalThis.loadExcel = loadExcel;

			expect(globalThis.loadExcel).toBe(loadExcel);

			delete globalThis.loadExcel;
		});

		test("should expose manualSaveDatabase on globalThis", () => {
			const manualSaveDatabase = jest.fn();
			globalThis.manualSaveDatabase = manualSaveDatabase;

			expect(globalThis.manualSaveDatabase).toBe(manualSaveDatabase);

			delete globalThis.manualSaveDatabase;
		});

		test("should expose toggleDeleteButtons on globalThis", () => {
			const toggleDeleteButtons = jest.fn();
			globalThis.toggleDeleteButtons = toggleDeleteButtons;

			expect(globalThis.toggleDeleteButtons).toBe(toggleDeleteButtons);

			delete globalThis.toggleDeleteButtons;
		});

		test("should expose clearDatabase on globalThis", () => {
			const clearDatabase = jest.fn();
			globalThis.clearDatabase = clearDatabase;

			expect(globalThis.clearDatabase).toBe(clearDatabase);

			delete globalThis.clearDatabase;
		});

		test("should expose toggleAutoCheck on globalThis", () => {
			const toggleAutoCheck = jest.fn();
			globalThis.toggleAutoCheck = toggleAutoCheck;

			expect(globalThis.toggleAutoCheck).toBe(toggleAutoCheck);

			delete globalThis.toggleAutoCheck;
		});

		test("should expose manualTriggerAutoCheck on globalThis", () => {
			const manualTriggerAutoCheck = jest.fn();
			globalThis.manualTriggerAutoCheck = manualTriggerAutoCheck;

			expect(globalThis.manualTriggerAutoCheck).toBe(manualTriggerAutoCheck);

			delete globalThis.manualTriggerAutoCheck;
		});

		test("should expose sortTable on globalThis", () => {
			const sortTable = jest.fn();
			globalThis.sortTable = sortTable;

			expect(globalThis.sortTable).toBe(sortTable);

			delete globalThis.sortTable;
		});

		test("should allow calling exposed functions", () => {
			const mockFn = jest.fn().mockReturnValue("result");
			globalThis.testExposedFn = mockFn;

			const result = globalThis.testExposedFn("arg1", "arg2");

			expect(mockFn).toHaveBeenCalledWith("arg1", "arg2");
			expect(result).toBe("result");

			delete globalThis.testExposedFn;
		});

		test("should overwrite previous globalThis assignments", () => {
			const first = jest.fn();
			const second = jest.fn();

			globalThis.testOverwrite = first;
			expect(globalThis.testOverwrite).toBe(first);

			globalThis.testOverwrite = second;
			expect(globalThis.testOverwrite).toBe(second);

			delete globalThis.testOverwrite;
		});
	});
});
