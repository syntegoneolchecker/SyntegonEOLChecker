/**
 * Tests for js/excel.js - Excel import/export data transformation
 */

// Mock document before importing modules
global.document = {
	getElementById: jest.fn(() => ({ textContent: "", className: "", value: "" }))
};

// Mock XLSX global (loaded via script tag in browser)
global.XLSX = {
	utils: {
		book_new: jest.fn(() => ({})),
		aoa_to_sheet: jest.fn(() => ({})),
		book_append_sheet: jest.fn(),
		sheet_to_json: jest.fn()
	},
	read: jest.fn(),
	writeFile: jest.fn()
};

// Mock fetch
global.fetch = jest.fn();

import { state, setOriginalData, resetSortState } from "../js/state.js";
import { downloadExcel, loadExcel } from "../js/excel.js";

describe("Excel data transformation", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		state.data = [
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
		state.originalData = null;
		state.currentSort = { column: null, direction: null };
	});

	describe("downloadExcel", () => {
		test("fetches data and creates workbook on success", async () => {
			const mockData = [
				["SAP Part Number", "Model"],
				["1-234-567-890", "ABC"]
			];
			global.fetch.mockResolvedValue({
				ok: true,
				json: jest.fn().mockResolvedValue({ data: mockData })
			});

			await downloadExcel();

			expect(global.fetch).toHaveBeenCalledWith("/.netlify/functions/get-csv");
			expect(XLSX.utils.book_new).toHaveBeenCalled();
			expect(XLSX.utils.aoa_to_sheet).toHaveBeenCalledWith(mockData);
			expect(XLSX.writeFile).toHaveBeenCalled();
		});

		test("handles fetch error", async () => {
			global.fetch.mockRejectedValue(new Error("Network error"));

			await downloadExcel();

			// Should call showStatus with error - verified via document mock
			expect(document.getElementById).toHaveBeenCalledWith("status");
		});

		test("handles no data in response", async () => {
			global.fetch.mockResolvedValue({
				ok: true,
				json: jest.fn().mockResolvedValue({})
			});

			await downloadExcel();

			expect(XLSX.writeFile).not.toHaveBeenCalled();
		});

		test("handles server error response", async () => {
			global.fetch.mockResolvedValue({
				ok: false,
				status: 500
			});

			await downloadExcel();

			expect(XLSX.writeFile).not.toHaveBeenCalled();
		});
	});

	describe("loadExcel", () => {
		function createMockFileEvent(importedData) {
			XLSX.read.mockReturnValue({
				SheetNames: ["Sheet1"],
				Sheets: { Sheet1: {} }
			});
			XLSX.utils.sheet_to_json.mockReturnValue(importedData);

			// Mock saveToServer fetch
			global.fetch.mockResolvedValue({
				ok: true,
				json: jest.fn().mockResolvedValue({ success: true })
			});

			const mockFile = {
				arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
			};

			return {
				target: { files: [mockFile] }
			};
		}

		test("validates SAP Part Number header exists", async () => {
			const event = createMockFileEvent([
				["Wrong Header", "Model"],
				["12345", "ABC"]
			]);

			await loadExcel(event);

			// Should not add any rows since header validation fails
			expect(state.data.length).toBe(1); // Only header row
		});

		test("skips rows with empty SAP number", async () => {
			const event = createMockFileEvent([
				["SAP Part Number", "Model"],
				["", "ABC"],
				["1234567890", "DEF"]
			]);

			await loadExcel(event);

			// One new entry (DEF), one skipped (empty)
			expect(state.data.length).toBe(2); // header + 1 valid
		});

		test("skips rows with invalid SAP format", async () => {
			const event = createMockFileEvent([
				["SAP Part Number", "Model"],
				["12345", "ABC"],
				["1234567890", "DEF"]
			]);

			await loadExcel(event);

			// "12345" is invalid (not 10 digits), "1234567890" is valid
			expect(state.data.length).toBe(2); // header + 1 valid
		});

		test("adds new entries for unique SAP numbers", async () => {
			const event = createMockFileEvent([
				["SAP Part Number", "Model", "Manufacturer"],
				["1234567890", "ABC-100", "SMC"],
				["0987654321", "DEF-200", "NTN"]
			]);

			await loadExcel(event);

			expect(state.data.length).toBe(3); // header + 2 new entries
			expect(state.data[1][0]).toBe("1-234-567-890");
			expect(state.data[2][0]).toBe("0-987-654-321");
		});

		test("updates existing entries for duplicate SAP numbers", async () => {
			// Pre-populate with existing entry
			state.data.push([
				"1-234-567-890",
				"L001",
				"Pump",
				"OLD-100",
				"SMC",
				"",
				"",
				"",
				"",
				"",
				"",
				"",
				""
			]);

			const event = createMockFileEvent([
				["SAP Part Number", "Model", "Manufacturer"],
				["1234567890", "NEW-100", "SMC"]
			]);

			await loadExcel(event);

			// Should update existing, not add new
			expect(state.data.length).toBe(2); // header + 1 updated
			expect(state.data[1][3]).toBe("NEW-100"); // Model updated
		});

		test("handles empty file gracefully", async () => {
			XLSX.read.mockReturnValue({
				SheetNames: ["Sheet1"],
				Sheets: { Sheet1: {} }
			});
			XLSX.utils.sheet_to_json.mockReturnValue([]);

			global.fetch.mockResolvedValue({
				ok: true,
				json: jest.fn().mockResolvedValue({ success: true })
			});

			const mockFile = {
				arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
			};

			const event = { target: { files: [mockFile] } };

			await loadExcel(event);

			// Should show error for empty file
			expect(state.data.length).toBe(1); // Only header, no new rows
		});

		test("does nothing when no file selected", async () => {
			const event = { target: { files: [] } };

			await loadExcel(event);

			// No errors, no changes
			expect(state.data.length).toBe(1);
		});

		test("resets sort state after import", async () => {
			state.currentSort = { column: 3, direction: "asc" };
			state.originalData = [["header"]];

			const event = createMockFileEvent([
				["SAP Part Number", "Model"],
				["1234567890", "ABC"]
			]);

			await loadExcel(event);

			expect(state.originalData).toBeNull();
			expect(state.currentSort.column).toBeNull();
			expect(state.currentSort.direction).toBeNull();
		});
	});
});
