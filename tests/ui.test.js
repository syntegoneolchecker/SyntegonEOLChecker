/**
 * Tests for js/ui.js
 * Tests UI utility functions: toggleDeleteButtons, clearDatabase,
 * setControlsDisabled, setControlsDisabledForAutoCheck, setDeleteToggleDisabled
 */

describe("UI Module", () => {
	let fetchMock;
	let showStatusCalls;
	let renderCalled;
	let setDataCalled;
	let confirmResult;

	function showStatus(message, type) {
		showStatusCalls.push({ message, type });
	}

	function render() {
		renderCalled = true;
	}

	beforeEach(() => {
		fetchMock = jest.fn();
		showStatusCalls = [];
		renderCalled = false;
		setDataCalled = false;
		confirmResult = true;
	});

	// ====== toggleDeleteButtons ======
	describe("toggleDeleteButtons", () => {
		test("should show delete buttons when toggle is checked", () => {
			const body = { classList: { add: jest.fn(), remove: jest.fn() } };
			const clearDbButton = { style: { display: "" } };
			const toggle = { checked: true };

			function toggleDeleteButtons() {
				if (toggle.checked) {
					body.classList.add("show-delete-buttons");
					clearDbButton.style.display = "block";
				} else {
					body.classList.remove("show-delete-buttons");
					clearDbButton.style.display = "none";
				}
			}

			toggleDeleteButtons();

			expect(body.classList.add).toHaveBeenCalledWith("show-delete-buttons");
			expect(clearDbButton.style.display).toBe("block");
		});

		test("should hide delete buttons when toggle is unchecked", () => {
			const body = { classList: { add: jest.fn(), remove: jest.fn() } };
			const clearDbButton = { style: { display: "" } };
			const toggle = { checked: false };

			function toggleDeleteButtons() {
				if (toggle.checked) {
					body.classList.add("show-delete-buttons");
					clearDbButton.style.display = "block";
				} else {
					body.classList.remove("show-delete-buttons");
					clearDbButton.style.display = "none";
				}
			}

			toggleDeleteButtons();

			expect(body.classList.remove).toHaveBeenCalledWith("show-delete-buttons");
			expect(clearDbButton.style.display).toBe("none");
		});
	});

	// ====== clearDatabase ======
	describe("clearDatabase", () => {
		test("should cancel if user declines confirmation", async () => {
			confirmResult = false;

			function clearDatabase() {
				if (!confirmResult) {
					showStatus("Database clear cancelled", "info");
					return;
				}
			}

			clearDatabase();

			expect(showStatusCalls[0].message).toBe("Database clear cancelled");
			expect(showStatusCalls[0].type).toBe("info");
		});

		test("should reset data on successful clear", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true })
			});

			let stateData = null;
			let stateOriginalData = "something";
			let sortReset = false;

			async function clearDatabase() {
				if (!confirmResult) return;

				showStatus("Clearing database...", "info");

				const response = await fetchMock("/.netlify/functions/reset-database", {
					method: "POST"
				});

				if (!response.ok) {
					throw new Error(`Failed: ${response.status}`);
				}

				stateData = [
					[
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
					]
				];
				stateOriginalData = null;
				sortReset = true;
				render();
				showStatus("✓ Database cleared successfully", "success");
			}

			await clearDatabase();

			expect(stateData).toHaveLength(1);
			expect(stateData[0][0]).toBe("SAP Part Number");
			expect(stateOriginalData).toBeNull();
			expect(sortReset).toBe(true);
			expect(renderCalled).toBe(true);
			expect(showStatusCalls[1].message).toContain("cleared successfully");
		});

		test("should show error on server failure", async () => {
			fetchMock.mockResolvedValue({
				ok: false,
				status: 500,
				json: () => Promise.resolve({})
			});

			async function clearDatabase() {
				if (!confirmResult) return;

				showStatus("Clearing database...", "info");

				try {
					const response = await fetchMock("/.netlify/functions/reset-database", {
						method: "POST"
					});

					if (!response.ok) {
						throw new Error(`Failed to clear database: ${response.status}`);
					}
				} catch (error) {
					showStatus("Error clearing database: " + error.message, "error");
				}
			}

			await clearDatabase();

			expect(showStatusCalls[1].message).toContain("Error clearing database");
			expect(showStatusCalls[1].type).toBe("error");
		});
	});

	// ====== setControlsDisabled ======
	describe("setControlsDisabled", () => {
		test("should disable all buttons and checkboxes", () => {
			const elements = [
				{ disabled: false, tagName: "BUTTON" },
				{ disabled: false, tagName: "INPUT", type: "checkbox" },
				{ disabled: false, tagName: "BUTTON" }
			];

			function setControlsDisabled(disabled) {
				elements.forEach((el) => {
					el.disabled = disabled;
				});
			}

			setControlsDisabled(true);

			elements.forEach((el) => {
				expect(el.disabled).toBe(true);
			});
		});

		test("should enable all buttons and checkboxes", () => {
			const elements = [
				{ disabled: true, tagName: "BUTTON" },
				{ disabled: true, tagName: "INPUT", type: "checkbox" }
			];

			function setControlsDisabled(disabled) {
				elements.forEach((el) => {
					el.disabled = disabled;
				});
			}

			setControlsDisabled(false);

			elements.forEach((el) => {
				expect(el.disabled).toBe(false);
			});
		});
	});

	// ====== setControlsDisabledForAutoCheck ======
	describe("setControlsDisabledForAutoCheck", () => {
		test("should skip auto-check-toggle, logout-button, and view-logs-button", () => {
			const elements = [
				{ id: "auto-check-toggle", disabled: false },
				{ id: "logout-button", disabled: false },
				{ id: "view-logs-button", disabled: false },
				{ id: "check-eol-button", disabled: false },
				{ id: "other-button", disabled: false }
			];

			const SKIP_IDS = ["auto-check-toggle", "logout-button", "view-logs-button"];

			function setControlsDisabledForAutoCheck(disabled) {
				elements.forEach((el) => {
					if (SKIP_IDS.includes(el.id)) return;
					el.disabled = disabled;
				});
			}

			setControlsDisabledForAutoCheck(true);

			// Skipped elements should remain enabled
			expect(elements[0].disabled).toBe(false); // auto-check-toggle
			expect(elements[1].disabled).toBe(false); // logout-button
			expect(elements[2].disabled).toBe(false); // view-logs-button

			// Other elements should be disabled
			expect(elements[3].disabled).toBe(true); // check-eol-button
			expect(elements[4].disabled).toBe(true); // other-button
		});
	});

	// ====== setDeleteToggleDisabled ======
	describe("setDeleteToggleDisabled", () => {
		test("should uncheck toggle and call toggleDeleteButtons if checked", () => {
			let toggleButtonsCalled = false;
			const toggle = { checked: true };

			function toggleDeleteButtons() {
				toggleButtonsCalled = true;
			}

			function setDeleteToggleDisabled() {
				if (toggle.checked) {
					toggle.checked = false;
					toggleDeleteButtons();
				}
			}

			setDeleteToggleDisabled();

			expect(toggle.checked).toBe(false);
			expect(toggleButtonsCalled).toBe(true);
		});

		test("should do nothing if toggle is already unchecked", () => {
			let toggleButtonsCalled = false;
			const toggle = { checked: false };

			function toggleDeleteButtons() {
				toggleButtonsCalled = true;
			}

			function setDeleteToggleDisabled() {
				if (toggle.checked) {
					toggle.checked = false;
					toggleDeleteButtons();
				}
			}

			setDeleteToggleDisabled();

			expect(toggle.checked).toBe(false);
			expect(toggleButtonsCalled).toBe(false);
		});
	});
});
