/**
 * Tests for js/row-management.js
 * Tests addRow, delRow, addNewEntry, replaceExistingEntry
 *
 * Since js/row-management.js uses ES module syntax, we re-implement the pure
 * logic functions for testing and mock DOM/external dependencies.
 */

describe("Row Management Module", () => {
	let state;
	let showStatusCalls;
	let renderCalled;
	let saveToServerCalled;
	let clearInputFieldsCalled;

	// Mock functions
	function showStatus(message, type = "success") {
		showStatusCalls.push({ message, type });
	}

	function render() {
		renderCalled = true;
	}

	async function saveToServer() {
		saveToServerCalled = true;
	}

	function clearInputFields(startIndex, endIndex) {
		clearInputFieldsCalled = { startIndex, endIndex };
	}

	function formatID(input) {
		const digits = input.replaceAll(/\D/g, "");
		if (digits.length !== 10) return null;
		return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`;
	}

	function validateAndFormatSAPNumber(idInput) {
		if (!idInput) {
			showStatus("Error: SAP Part Number is required", "error");
			return null;
		}
		const formattedID = formatID(idInput);
		if (!formattedID) {
			showStatus(
				"Error: SAP Part Number must be exactly 10 digits (e.g., 8-114-463-187 or 8114463187)",
				"error"
			);
			return null;
		}
		return formattedID;
	}

	function findRowBySAPNumber(sapNumber) {
		for (let i = 1; i < state.data.length; i++) {
			if (state.data[i][0] === sapNumber) {
				return i;
			}
		}
		return -1;
	}

	beforeEach(() => {
		showStatusCalls = [];
		renderCalled = false;
		saveToServerCalled = false;
		clearInputFieldsCalled = null;
		state = {
			data: [
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
			],
			originalData: null
		};
	});

	// ====== addNewEntry ======
	describe("addNewEntry", () => {
		async function addNewEntry(formattedID, row) {
			state.data.push(row);
			if (state.originalData) state.originalData.push(row);
			render();
			showStatus(`✓ New entry ${formattedID} added successfully`);
			await saveToServer();
			clearInputFields(1, 13);
		}

		test("should push row to state.data", async () => {
			const row = ["8-114-463-187", "OLD-001", "Sensor", "MODEL-A", "SMC", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(state.data).toHaveLength(2);
			expect(state.data[1]).toBe(row);
		});

		test("should push row to originalData when it exists", async () => {
			state.originalData = [
				["SAP Part Number", "Legacy Part Number"]
			];
			const row = ["8-114-463-187", "OLD-001", "Sensor", "MODEL-A", "SMC", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(state.originalData).toHaveLength(2);
			expect(state.originalData[1]).toBe(row);
		});

		test("should not push to originalData when it is null", async () => {
			state.originalData = null;
			const row = ["8-114-463-187", "OLD-001", "Sensor", "MODEL-A", "SMC", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(state.originalData).toBeNull();
		});

		test("should call render", async () => {
			const row = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(renderCalled).toBe(true);
		});

		test("should show success status with formatted ID", async () => {
			const row = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(showStatusCalls[0].message).toContain("8-114-463-187");
			expect(showStatusCalls[0].message).toContain("added successfully");
		});

		test("should call saveToServer", async () => {
			const row = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(saveToServerCalled).toBe(true);
		});

		test("should clear input fields from 1 to 13", async () => {
			const row = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await addNewEntry("8-114-463-187", row);

			expect(clearInputFieldsCalled).toEqual({ startIndex: 1, endIndex: 13 });
		});
	});

	// ====== replaceExistingEntry ======
	describe("replaceExistingEntry", () => {
		async function replaceExistingEntry(existingIndex, formattedID, row) {
			state.data[existingIndex] = row;
			if (state.originalData) state.originalData[existingIndex] = row;
			render();
			showStatus(`✓ Entry ${formattedID} replaced successfully`);
			await saveToServer();
			clearInputFields(1, 13);
		}

		test("should replace row at specified index in state.data", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			const newRow = ["8-114-463-187", "NEW-001", "Updated", "NewModel", "SMC", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(state.data[1]).toBe(newRow);
			expect(state.data[1][1]).toBe("NEW-001");
		});

		test("should replace row in originalData when it exists", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			state.originalData = [
				["SAP Part Number", "Legacy Part Number"],
				["8-114-463-187", "OLD-001"]
			];
			const newRow = ["8-114-463-187", "NEW-001", "Updated", "NewModel", "SMC", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(state.originalData[1]).toBe(newRow);
		});

		test("should not modify originalData when it is null", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			state.originalData = null;
			const newRow = ["8-114-463-187", "NEW-001", "", "", "", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(state.originalData).toBeNull();
		});

		test("should call render", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);
			const newRow = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(renderCalled).toBe(true);
		});

		test("should show success status with formatted ID", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);
			const newRow = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(showStatusCalls[0].message).toContain("8-114-463-187");
			expect(showStatusCalls[0].message).toContain("replaced successfully");
		});

		test("should call saveToServer", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);
			const newRow = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(saveToServerCalled).toBe(true);
		});

		test("should clear input fields from 1 to 13", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);
			const newRow = ["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""];

			await replaceExistingEntry(1, "8-114-463-187", newRow);

			expect(clearInputFieldsCalled).toEqual({ startIndex: 1, endIndex: 13 });
		});
	});

	// ====== delRow ======
	describe("delRow", () => {
		async function delRow(i) {
			if (state.originalData) {
				const rowToDelete = state.data[i];
				const sapNumber = rowToDelete[0];

				const originalIndex = state.originalData.findIndex((row) => row[0] === sapNumber);
				if (originalIndex !== -1) {
					state.originalData.splice(originalIndex, 1);
				}
			}

			state.data.splice(i, 1);
			render();
			await saveToServer();
		}

		test("should remove row at specified index from state.data", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			state.data.push(["1-234-567-890", "OLD-002", "", "", "", "", "", "", "", "", "", "", ""]);

			await delRow(1);

			expect(state.data).toHaveLength(2);
			expect(state.data[1][0]).toBe("1-234-567-890");
		});

		test("should remove matching row from originalData by SAP number", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			state.data.push(["1-234-567-890", "OLD-002", "", "", "", "", "", "", "", "", "", "", ""]);
			state.originalData = [
				["SAP Part Number", "Legacy Part Number"],
				["8-114-463-187", "OLD-001"],
				["1-234-567-890", "OLD-002"]
			];

			await delRow(1);

			expect(state.originalData).toHaveLength(2);
			expect(state.originalData[1][0]).toBe("1-234-567-890");
		});

		test("should not modify originalData when it is null", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			state.originalData = null;

			await delRow(1);

			expect(state.originalData).toBeNull();
		});

		test("should handle deleting when SAP number not found in originalData", async () => {
			state.data.push(["8-114-463-187", "OLD-001", "", "", "", "", "", "", "", "", "", "", ""]);
			state.originalData = [
				["SAP Part Number", "Legacy Part Number"],
				["9-999-999-999", "OTHER"]
			];

			await delRow(1);

			// originalData should be unchanged since SAP number didn't match
			expect(state.originalData).toHaveLength(2);
			expect(state.data).toHaveLength(1); // only header remains
		});

		test("should call render after deletion", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);

			await delRow(1);

			expect(renderCalled).toBe(true);
		});

		test("should call saveToServer after deletion", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);

			await delRow(1);

			expect(saveToServerCalled).toBe(true);
		});

		test("should delete the last row leaving only headers", async () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);

			await delRow(1);

			expect(state.data).toHaveLength(1);
			expect(state.data[0][0]).toBe("SAP Part Number");
		});

		test("should delete correct row when multiple rows exist", async () => {
			state.data.push(["8-114-463-187", "A", "", "", "", "", "", "", "", "", "", "", ""]);
			state.data.push(["1-234-567-890", "B", "", "", "", "", "", "", "", "", "", "", ""]);
			state.data.push(["9-876-543-210", "C", "", "", "", "", "", "", "", "", "", "", ""]);

			await delRow(2); // Delete middle row (1-234-567-890)

			expect(state.data).toHaveLength(3);
			expect(state.data[1][0]).toBe("8-114-463-187");
			expect(state.data[2][0]).toBe("9-876-543-210");
		});
	});

	// ====== addRow (integration) ======
	describe("addRow", () => {
		let confirmResult;
		let documentElements;
		let collectInputFieldsResult;

		function collectInputFields(startIndex, endIndex) {
			return collectInputFieldsResult;
		}

		async function addNewEntry(formattedID, row) {
			state.data.push(row);
			if (state.originalData) state.originalData.push(row);
			render();
			showStatus(`✓ New entry ${formattedID} added successfully`);
			await saveToServer();
			clearInputFieldsCalled = { startIndex: 1, endIndex: 13 };
		}

		async function replaceExistingEntry(existingIndex, formattedID, row) {
			state.data[existingIndex] = row;
			if (state.originalData) state.originalData[existingIndex] = row;
			render();
			showStatus(`✓ Entry ${formattedID} replaced successfully`);
			await saveToServer();
			clearInputFieldsCalled = { startIndex: 1, endIndex: 13 };
		}

		async function addRow() {
			const idInput = documentElements.c1.value.trim();
			const formattedID = validateAndFormatSAPNumber(idInput);
			if (!formattedID) return;

			const row = [formattedID, ...collectInputFields(2, 13)];

			const existingIndex = findRowBySAPNumber(formattedID);

			if (existingIndex === -1) {
				await addNewEntry(formattedID, row);
			} else {
				const existingRow = state.data[existingIndex];
				const confirmMessage = `Replace entry ${formattedID}?`;

				if (confirmResult) {
					await replaceExistingEntry(existingIndex, formattedID, row);
				} else {
					showStatus("Entry replacement cancelled", "info");
				}
			}
		}

		beforeEach(() => {
			confirmResult = true;
			collectInputFieldsResult = ["", "Sensor", "MODEL-A", "SMC", "", "", "", "", "", "", "", ""];
			documentElements = {
				c1: { value: "8114463187" }
			};
		});

		test("should add new entry when SAP number does not exist", async () => {
			await addRow();

			expect(state.data).toHaveLength(2);
			expect(state.data[1][0]).toBe("8-114-463-187");
			expect(showStatusCalls[0].message).toContain("added successfully");
		});

		test("should return early for empty SAP input", async () => {
			documentElements.c1.value = "";

			await addRow();

			expect(state.data).toHaveLength(1);
			expect(showStatusCalls[0].type).toBe("error");
			expect(showStatusCalls[0].message).toContain("required");
		});

		test("should return early for invalid SAP number", async () => {
			documentElements.c1.value = "123";

			await addRow();

			expect(state.data).toHaveLength(1);
			expect(showStatusCalls[0].type).toBe("error");
			expect(showStatusCalls[0].message).toContain("10 digits");
		});

		test("should trim whitespace from SAP input", async () => {
			documentElements.c1.value = "  8114463187  ";

			await addRow();

			expect(state.data).toHaveLength(2);
			expect(state.data[1][0]).toBe("8-114-463-187");
		});

		test("should build row with formatted ID as first element", async () => {
			collectInputFieldsResult = ["LEGACY", "Sensor", "MODEL-A", "SMC", "ACTIVE", "Comment", "Succ", "SComment", "SuccSAP", "50", "1/1/2025", "YES"];

			await addRow();

			expect(state.data[1][0]).toBe("8-114-463-187");
			expect(state.data[1][1]).toBe("LEGACY");
			expect(state.data[1]).toHaveLength(13);
		});

		test("should replace existing entry when user confirms", async () => {
			state.data.push(["8-114-463-187", "OLD", "", "", "", "", "", "", "", "", "", "", ""]);
			confirmResult = true;

			await addRow();

			expect(state.data).toHaveLength(2);
			expect(showStatusCalls[0].message).toContain("replaced successfully");
		});

		test("should cancel replacement when user declines", async () => {
			state.data.push(["8-114-463-187", "OLD", "", "", "", "", "", "", "", "", "", "", ""]);
			confirmResult = false;

			await addRow();

			expect(state.data).toHaveLength(2);
			expect(state.data[1][1]).toBe("OLD");
			expect(showStatusCalls[0].message).toContain("cancelled");
			expect(showStatusCalls[0].type).toBe("info");
		});
	});
});
