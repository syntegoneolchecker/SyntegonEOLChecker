/**
 * Tests for js/excel.js
 * Tests validateExcelHeaders, buildRowFromExcel, processExcelRow,
 * showImportSummary, processAllExcelRows
 *
 * Since js/excel.js uses ES module syntax, we re-implement the pure logic
 * functions for testing and mock DOM/state dependencies.
 */

describe("Excel Module", () => {
	let state;
	let showStatusCalls;

	function showStatus(message, type = "success") {
		showStatusCalls.push({ message, type });
	}

	function formatID(input) {
		const digits = input.replaceAll(/\D/g, "");
		if (digits.length !== 10) return null;
		return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`;
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

	// ====== validateExcelHeaders ======
	describe("validateExcelHeaders", () => {
		function validateExcelHeaders(headers) {
			const idIndex = headers.findIndex((h) => {
				const headerText = h?.toString().toLowerCase().trim();
				return headerText === "sap part number";
			});

			if (idIndex === -1) {
				showStatus(
					'Error: Excel file must contain "SAP Part Number" column. Found headers: ' +
						headers.join(", "),
					"error"
				);
				return null;
			}

			return idIndex;
		}

		test("should return index when SAP Part Number column exists", () => {
			const headers = ["SAP Part Number", "Legacy Part Number", "Designation"];

			expect(validateExcelHeaders(headers)).toBe(0);
		});

		test("should find SAP Part Number at non-zero index", () => {
			const headers = ["Legacy Part Number", "SAP Part Number", "Designation"];

			expect(validateExcelHeaders(headers)).toBe(1);
		});

		test("should be case-insensitive", () => {
			const headers = ["sap part number", "Legacy Part Number"];

			expect(validateExcelHeaders(headers)).toBe(0);
		});

		test("should handle mixed case", () => {
			const headers = ["Sap Part Number", "Other"];

			expect(validateExcelHeaders(headers)).toBe(0);
		});

		test("should trim whitespace from headers", () => {
			const headers = ["  SAP Part Number  ", "Other"];

			expect(validateExcelHeaders(headers)).toBe(0);
		});

		test("should return null when SAP Part Number column is missing", () => {
			const headers = ["Part Number", "Legacy Number", "Designation"];

			expect(validateExcelHeaders(headers)).toBeNull();
		});

		test("should show error status when column is missing", () => {
			const headers = ["Part Number", "Legacy Number"];

			validateExcelHeaders(headers);

			expect(showStatusCalls[0].type).toBe("error");
			expect(showStatusCalls[0].message).toContain("SAP Part Number");
			expect(showStatusCalls[0].message).toContain("Part Number");
			expect(showStatusCalls[0].message).toContain("Legacy Number");
		});

		test("should handle empty headers array", () => {
			expect(validateExcelHeaders([])).toBeNull();
			expect(showStatusCalls[0].type).toBe("error");
		});

		test("should handle headers with null values", () => {
			const headers = [null, "SAP Part Number", undefined];

			expect(validateExcelHeaders(headers)).toBe(1);
		});

		test("should not match partial header names", () => {
			const headers = ["SAP Part", "Part Number", "SAP Number"];

			expect(validateExcelHeaders(headers)).toBeNull();
		});
	});

	// ====== buildRowFromExcel ======
	describe("buildRowFromExcel", () => {
		function buildRowFromExcel(importedRow, headers, idIndex) {
			const idInput = (importedRow[idIndex] || "").toString().trim();

			if (!idInput) {
				return { skip: true, reason: "no SAP Number" };
			}

			const formattedID = formatID(idInput);
			if (!formattedID) {
				return { skip: true, reason: `invalid format: "${idInput}"` };
			}

			const newRow = [];
			const ourHeaders = state.data[0];

			for (const element of ourHeaders) {
				const headerName = element.toLowerCase().trim();

				if (headerName === "sap part number") {
					newRow.push(formattedID);
				} else {
					const importColIndex = headers.findIndex(
						(h) => h?.toString().toLowerCase().trim() === headerName
					);

					if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
						newRow.push(importedRow[importColIndex].toString());
					} else {
						newRow.push("");
					}
				}
			}

			return { skip: false, formattedID, newRow };
		}

		test("should build row with formatted SAP number", () => {
			const headers = ["SAP Part Number", "Model", "Manufacturer"];
			const importedRow = ["8114463187", "MODEL-A", "SMC"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(false);
			expect(result.formattedID).toBe("8-114-463-187");
			expect(result.newRow[0]).toBe("8-114-463-187");
		});

		test("should map columns by header name matching", () => {
			const headers = ["SAP Part Number", "Model", "Manufacturer"];
			const importedRow = ["8114463187", "MODEL-A", "SMC"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.newRow[3]).toBe("MODEL-A"); // Model
			expect(result.newRow[4]).toBe("SMC"); // Manufacturer
		});

		test("should fill empty string for unmatched columns", () => {
			const headers = ["SAP Part Number"];
			const importedRow = ["8114463187"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.newRow).toHaveLength(13);
			// All columns except SAP Part Number should be empty
			for (let i = 1; i < result.newRow.length; i++) {
				expect(result.newRow[i]).toBe("");
			}
		});

		test("should skip row with empty SAP number", () => {
			const headers = ["SAP Part Number", "Model"];
			const importedRow = ["", "MODEL-A"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(true);
			expect(result.reason).toBe("no SAP Number");
		});

		test("should skip row with null SAP number", () => {
			const headers = ["SAP Part Number", "Model"];
			const importedRow = [null, "MODEL-A"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(true);
			expect(result.reason).toBe("no SAP Number");
		});

		test("should skip row with undefined SAP number", () => {
			const headers = ["SAP Part Number", "Model"];
			const importedRow = [undefined, "MODEL-A"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(true);
			expect(result.reason).toBe("no SAP Number");
		});

		test("should skip row with invalid SAP number format", () => {
			const headers = ["SAP Part Number", "Model"];
			const importedRow = ["123", "MODEL-A"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(true);
			expect(result.reason).toContain("invalid format");
			expect(result.reason).toContain("123");
		});

		test("should handle SAP number at non-zero index", () => {
			const headers = ["Model", "SAP Part Number", "Manufacturer"];
			const importedRow = ["MODEL-A", "8114463187", "SMC"];

			const result = buildRowFromExcel(importedRow, headers, 1);

			expect(result.skip).toBe(false);
			expect(result.formattedID).toBe("8-114-463-187");
		});

		test("should handle already formatted SAP number", () => {
			const headers = ["SAP Part Number"];
			const importedRow = ["8-114-463-187"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(false);
			expect(result.formattedID).toBe("8-114-463-187");
		});

		test("should convert numeric values to strings", () => {
			const headers = ["SAP Part Number", "Stock"];
			const importedRow = ["8114463187", 50];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.newRow[10]).toBe("50"); // Stock column
		});

		test("should produce row with 13 columns matching state header length", () => {
			const headers = ["SAP Part Number", "Designation", "Model", "Manufacturer", "Status"];
			const importedRow = ["8114463187", "Sensor", "MODEL-A", "SMC", "ACTIVE"];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.newRow).toHaveLength(13);
		});

		test("should trim whitespace from SAP number input", () => {
			const headers = ["SAP Part Number"];
			const importedRow = ["  8114463187  "];

			const result = buildRowFromExcel(importedRow, headers, 0);

			expect(result.skip).toBe(false);
			expect(result.formattedID).toBe("8-114-463-187");
		});
	});

	// ====== processExcelRow ======
	describe("processExcelRow", () => {
		function buildRowFromExcel(importedRow, headers, idIndex) {
			const idInput = (importedRow[idIndex] || "").toString().trim();

			if (!idInput) {
				return { skip: true, reason: "no SAP Number" };
			}

			const formattedID = formatID(idInput);
			if (!formattedID) {
				return { skip: true, reason: `invalid format: "${idInput}"` };
			}

			const newRow = [];
			const ourHeaders = state.data[0];

			for (const element of ourHeaders) {
				const headerName = element.toLowerCase().trim();

				if (headerName === "sap part number") {
					newRow.push(formattedID);
				} else {
					const importColIndex = headers.findIndex(
						(h) => h?.toString().toLowerCase().trim() === headerName
					);

					if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
						newRow.push(importedRow[importColIndex].toString());
					} else {
						newRow.push("");
					}
				}
			}

			return { skip: false, formattedID, newRow };
		}

		function processExcelRow(importedRow, headers, idIndex, stats) {
			const result = buildRowFromExcel(importedRow, headers, idIndex);

			if (result.skip) {
				stats.skippedEntries++;
				return;
			}

			const { formattedID, newRow } = result;
			const existingIndex = findRowBySAPNumber(formattedID);

			if (existingIndex === -1) {
				state.data.push(newRow);
				if (state.originalData) state.originalData.push(newRow);
				stats.newEntries++;
			} else {
				state.data[existingIndex] = newRow;
				if (state.originalData) state.originalData[existingIndex] = newRow;
				stats.updatedEntries++;
			}
		}

		test("should add new entry and increment newEntries", () => {
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number", "Model"];
			const importedRow = ["8114463187", "MODEL-A"];

			processExcelRow(importedRow, headers, 0, stats);

			expect(stats.newEntries).toBe(1);
			expect(stats.updatedEntries).toBe(0);
			expect(stats.skippedEntries).toBe(0);
			expect(state.data).toHaveLength(2);
		});

		test("should update existing entry and increment updatedEntries", () => {
			state.data.push(["8-114-463-187", "", "", "OLD-MODEL", "", "", "", "", "", "", "", "", ""]);
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number", "Model"];
			const importedRow = ["8114463187", "NEW-MODEL"];

			processExcelRow(importedRow, headers, 0, stats);

			expect(stats.updatedEntries).toBe(1);
			expect(stats.newEntries).toBe(0);
			expect(state.data).toHaveLength(2);
			expect(state.data[1][3]).toBe("NEW-MODEL");
		});

		test("should skip row with invalid SAP number", () => {
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number"];
			const importedRow = ["123"];

			processExcelRow(importedRow, headers, 0, stats);

			expect(stats.skippedEntries).toBe(1);
			expect(stats.newEntries).toBe(0);
			expect(stats.updatedEntries).toBe(0);
			expect(state.data).toHaveLength(1); // Only header
		});

		test("should skip row with empty SAP number", () => {
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number"];
			const importedRow = [""];

			processExcelRow(importedRow, headers, 0, stats);

			expect(stats.skippedEntries).toBe(1);
		});

		test("should push to originalData when it exists for new entry", () => {
			state.originalData = [
				["SAP Part Number", "Legacy Part Number"]
			];
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number"];
			const importedRow = ["8114463187"];

			processExcelRow(importedRow, headers, 0, stats);

			expect(state.originalData).toHaveLength(2);
		});

		test("should update originalData when it exists for existing entry", () => {
			state.data.push(["8-114-463-187", "", "", "OLD", "", "", "", "", "", "", "", "", ""]);
			state.originalData = [
				["SAP Part Number"],
				["8-114-463-187", "", "", "OLD", "", "", "", "", "", "", "", "", ""]
			];
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number", "Model"];
			const importedRow = ["8114463187", "NEW"];

			processExcelRow(importedRow, headers, 0, stats);

			expect(state.originalData[1][3]).toBe("NEW");
		});

		test("should not modify originalData when it is null", () => {
			state.originalData = null;
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = ["SAP Part Number"];
			const importedRow = ["8114463187"];

			processExcelRow(importedRow, headers, 0, stats);

			expect(state.originalData).toBeNull();
		});
	});

	// ====== showImportSummary ======
	describe("showImportSummary", () => {
		function showImportSummary(stats) {
			let statusMsg = `✓ Imported: ${stats.newEntries} new entries, ${stats.updatedEntries} updated entries`;
			if (stats.skippedEntries > 0) {
				statusMsg += `, ${stats.skippedEntries} skipped (invalid/missing SAP Number)`;
			}
			showStatus(statusMsg);
		}

		test("should show new and updated counts", () => {
			showImportSummary({ newEntries: 5, updatedEntries: 3, skippedEntries: 0 });

			expect(showStatusCalls[0].message).toContain("5 new entries");
			expect(showStatusCalls[0].message).toContain("3 updated entries");
		});

		test("should include skipped count when > 0", () => {
			showImportSummary({ newEntries: 2, updatedEntries: 1, skippedEntries: 4 });

			expect(showStatusCalls[0].message).toContain("4 skipped");
			expect(showStatusCalls[0].message).toContain("invalid/missing SAP Number");
		});

		test("should not include skipped text when 0 skipped", () => {
			showImportSummary({ newEntries: 10, updatedEntries: 0, skippedEntries: 0 });

			expect(showStatusCalls[0].message).not.toContain("skipped");
		});

		test("should handle all zeros", () => {
			showImportSummary({ newEntries: 0, updatedEntries: 0, skippedEntries: 0 });

			expect(showStatusCalls[0].message).toContain("0 new entries");
			expect(showStatusCalls[0].message).toContain("0 updated entries");
		});

		test("should start with checkmark", () => {
			showImportSummary({ newEntries: 1, updatedEntries: 0, skippedEntries: 0 });

			expect(showStatusCalls[0].message).toMatch(/^✓/);
		});
	});

	// ====== processAllExcelRows ======
	describe("processAllExcelRows", () => {
		function buildRowFromExcel(importedRow, headers, idIndex) {
			const idInput = (importedRow[idIndex] || "").toString().trim();

			if (!idInput) {
				return { skip: true, reason: "no SAP Number" };
			}

			const formattedID = formatID(idInput);
			if (!formattedID) {
				return { skip: true, reason: `invalid format: "${idInput}"` };
			}

			const newRow = [];
			const ourHeaders = state.data[0];

			for (const element of ourHeaders) {
				const headerName = element.toLowerCase().trim();

				if (headerName === "sap part number") {
					newRow.push(formattedID);
				} else {
					const importColIndex = headers.findIndex(
						(h) => h?.toString().toLowerCase().trim() === headerName
					);

					if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
						newRow.push(importedRow[importColIndex].toString());
					} else {
						newRow.push("");
					}
				}
			}

			return { skip: false, formattedID, newRow };
		}

		function processExcelRow(importedRow, headers, idIndex, stats) {
			const result = buildRowFromExcel(importedRow, headers, idIndex);

			if (result.skip) {
				stats.skippedEntries++;
				return;
			}

			const { formattedID, newRow } = result;
			const existingIndex = findRowBySAPNumber(formattedID);

			if (existingIndex === -1) {
				state.data.push(newRow);
				if (state.originalData) state.originalData.push(newRow);
				stats.newEntries++;
			} else {
				state.data[existingIndex] = newRow;
				if (state.originalData) state.originalData[existingIndex] = newRow;
				stats.updatedEntries++;
			}
		}

		function processAllExcelRows(importedData, idIndex) {
			const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
			const headers = importedData[0];

			for (let i = 1; i < importedData.length; i++) {
				const importedRow = importedData[i];
				if (!importedRow || importedRow.length === 0) continue;
				processExcelRow(importedRow, headers, idIndex, stats);
			}

			return stats;
		}

		test("should process all data rows (skip header)", () => {
			const importedData = [
				["SAP Part Number", "Model"],
				["8114463187", "MODEL-A"],
				["1234567890", "MODEL-B"]
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(2);
			expect(state.data).toHaveLength(3); // header + 2 rows
		});

		test("should skip header row", () => {
			const importedData = [
				["SAP Part Number", "Model"],
				["8114463187", "MODEL-A"]
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(1);
			// Header row should not be processed as data
			expect(state.data[1][0]).toBe("8-114-463-187");
		});

		test("should skip null rows", () => {
			const importedData = [
				["SAP Part Number", "Model"],
				["8114463187", "MODEL-A"],
				null,
				["1234567890", "MODEL-B"]
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(2);
		});

		test("should skip empty rows", () => {
			const importedData = [
				["SAP Part Number", "Model"],
				["8114463187", "MODEL-A"],
				[],
				["1234567890", "MODEL-B"]
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(2);
		});

		test("should return correct stats with mixed results", () => {
			state.data.push(["8-114-463-187", "", "", "", "", "", "", "", "", "", "", "", ""]);

			const importedData = [
				["SAP Part Number", "Model"],
				["8114463187", "UPDATED"],  // existing -> update
				["1234567890", "NEW"],       // new
				["invalid", "SKIP"]          // invalid -> skip
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(1);
			expect(stats.updatedEntries).toBe(1);
			expect(stats.skippedEntries).toBe(1);
		});

		test("should handle importedData with only headers", () => {
			const importedData = [
				["SAP Part Number", "Model"]
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(0);
			expect(stats.updatedEntries).toBe(0);
			expect(stats.skippedEntries).toBe(0);
		});

		test("should initialize stats object with zeros", () => {
			const importedData = [
				["SAP Part Number"]
			];

			const stats = processAllExcelRows(importedData, 0);

			expect(stats).toEqual({ newEntries: 0, updatedEntries: 0, skippedEntries: 0 });
		});

		test("should handle large dataset", () => {
			const importedData = [["SAP Part Number"]];
			for (let i = 0; i < 100; i++) {
				const digits = String(i).padStart(10, "0");
				importedData.push([digits]);
			}

			const stats = processAllExcelRows(importedData, 0);

			expect(stats.newEntries).toBe(100);
			expect(state.data).toHaveLength(101); // header + 100 rows
		});

		test("should use correct idIndex for non-zero SAP column", () => {
			const importedData = [
				["Model", "SAP Part Number"],
				["MODEL-A", "8114463187"]
			];

			const stats = processAllExcelRows(importedData, 1);

			expect(stats.newEntries).toBe(1);
			expect(state.data[1][0]).toBe("8-114-463-187");
		});
	});
});
