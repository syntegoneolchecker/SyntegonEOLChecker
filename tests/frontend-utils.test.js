// =============================================================================
// Tests for js/utils.js - Utility Functions (pure logic only)
// =============================================================================

import {
	formatID,
	findRowBySAPNumber,
	updateRowInOriginalData,
	parseCreditsRemaining,
	delay,
	buildConfirmationMessage
} from "../js/utils.js";
import { state, setData, setOriginalData } from "../js/state.js";

// Mock document for showStatus (imported by utils.js at module level)
// showStatus uses document.getElementById("status"), so we need a minimal mock
beforeAll(() => {
	global.document = {
		getElementById: jest.fn(() => ({
			textContent: "",
			className: "",
			value: "",
			classList: {
				add: jest.fn(),
				remove: jest.fn()
			}
		}))
	};
});

afterAll(() => {
	delete global.document;
});

describe("js/utils.js - Pure Utility Functions", () => {
	// Save and restore state between tests
	let savedData;
	let savedOriginalData;

	beforeEach(() => {
		savedData = state.data;
		savedOriginalData = state.originalData;

		// Set up test data for functions that depend on state
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
			],
			[
				"1-234-567-890",
				"L001",
				"Pump",
				"ABC-100",
				"SMC",
				"Active",
				"In production",
				"",
				"",
				"",
				"50",
				"2024-01-15",
				"true"
			],
			[
				"9-876-543-210",
				"L002",
				"Valve",
				"XYZ-200",
				"Festo",
				"EOL",
				"Discontinued",
				"XYZ-300",
				"Direct replacement",
				"9-876-543-211",
				"0",
				"2024-03-20",
				"false"
			]
		];
		state.originalData = null;
	});

	afterEach(() => {
		state.data = savedData;
		state.originalData = savedOriginalData;
	});

	// =========================================================================
	// formatID tests
	// =========================================================================

	describe("formatID", () => {
		test('formats 10 raw digits into X-XXX-XXX-XXX pattern', () => {
			const result = formatID("1234567890");
			expect(result).toBe("1-234-567-890");
		});

		test('strips non-digits and reformats already-formatted input', () => {
			const result = formatID("1-234-567-890");
			expect(result).toBe("1-234-567-890");
		});

		test('returns null for input with fewer than 10 digits', () => {
			const result = formatID("12345");
			expect(result).toBeNull();
		});

		test('returns null for empty string', () => {
			const result = formatID("");
			expect(result).toBeNull();
		});

		test('returns null for input with more than 10 digits', () => {
			const result = formatID("12345678901");
			expect(result).toBeNull();
		});

		test('handles input with mixed characters and digits', () => {
			const result = formatID("abc1def234ghi567jkl890");
			expect(result).toBe("1-234-567-890");
		});
	});

	// =========================================================================
	// findRowBySAPNumber tests
	// =========================================================================

	describe("findRowBySAPNumber", () => {
		test('finds existing row and returns its index', () => {
			const index = findRowBySAPNumber("1-234-567-890");
			expect(index).toBe(1);
		});

		test('finds second row by SAP number', () => {
			const index = findRowBySAPNumber("9-876-543-210");
			expect(index).toBe(2);
		});

		test('returns -1 for non-existent SAP number', () => {
			const index = findRowBySAPNumber("0-000-000-000");
			expect(index).toBe(-1);
		});

		test('does not match header row (skips index 0)', () => {
			const index = findRowBySAPNumber("SAP Part Number");
			expect(index).toBe(-1);
		});
	});

	// =========================================================================
	// updateRowInOriginalData tests
	// =========================================================================

	describe("updateRowInOriginalData", () => {
		test('updates existing row in originalData', () => {
			// Set up originalData with a copy of current data
			state.originalData = [
				[...state.data[0]],
				[...state.data[1]],
				[...state.data[2]]
			];

			const updatedRow = [
				"1-234-567-890",
				"L001-updated",
				"Pump v2",
				"ABC-200",
				"SMC",
				"EOL",
				"End of life",
				"ABC-300",
				"Upgrade available",
				"1-234-567-891",
				"10",
				"2025-01-01",
				"true"
			];

			updateRowInOriginalData(updatedRow);

			// The row in originalData should be updated
			expect(state.originalData[1][1]).toBe("L001-updated");
			expect(state.originalData[1][2]).toBe("Pump v2");
			expect(state.originalData[1][5]).toBe("EOL");
		});

		test('does nothing if originalData is null', () => {
			state.originalData = null;

			const updatedRow = ["1-234-567-890", "L001-updated"];

			// Should not throw
			expect(() => updateRowInOriginalData(updatedRow)).not.toThrow();
			expect(state.originalData).toBeNull();
		});

		test('does not modify originalData if SAP number not found', () => {
			state.originalData = [
				[...state.data[0]],
				[...state.data[1]]
			];

			const nonExistentRow = ["0-000-000-000", "LXXX", "Unknown"];

			updateRowInOriginalData(nonExistentRow);

			// Original data should remain unchanged
			expect(state.originalData.length).toBe(2);
			expect(state.originalData[1][0]).toBe("1-234-567-890");
			expect(state.originalData[1][1]).toBe("L001");
		});
	});

	// =========================================================================
	// parseCreditsRemaining tests
	// =========================================================================

	describe("parseCreditsRemaining", () => {
		test('extracts remaining count from "N/M remaining" format', () => {
			const result = parseCreditsRemaining("85/100 remaining");
			expect(result).toBe(85);
		});

		test('handles large numbers', () => {
			const result = parseCreditsRemaining("999999/999999 remaining");
			expect(result).toBe(999999);
		});

		test('returns null for invalid text', () => {
			const result = parseCreditsRemaining("invalid text");
			expect(result).toBeNull();
		});

		test('returns null for empty string', () => {
			const result = parseCreditsRemaining("");
			expect(result).toBeNull();
		});

		test('returns null for partial match without "remaining"', () => {
			const result = parseCreditsRemaining("85/100");
			expect(result).toBeNull();
		});

		test('extracts zero remaining', () => {
			const result = parseCreditsRemaining("0/100 remaining");
			expect(result).toBe(0);
		});
	});

	// =========================================================================
	// delay tests
	// =========================================================================

	describe("delay", () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		test('resolves after specified milliseconds', async () => {
			const promise = delay(1000);

			// Should not be resolved yet
			let resolved = false;
			promise.then(() => {
				resolved = true;
			});

			// Advance time by 999ms - should still be pending
			jest.advanceTimersByTime(999);
			await Promise.resolve(); // flush microtasks
			expect(resolved).toBe(false);

			// Advance the remaining 1ms
			jest.advanceTimersByTime(1);
			await Promise.resolve(); // flush microtasks
			expect(resolved).toBe(true);
		});
	});

	// =========================================================================
	// buildConfirmationMessage tests
	// =========================================================================

	describe("buildConfirmationMessage", () => {
		test('builds correct multi-line confirmation string with all fields', () => {
			const formattedID = "1-234-567-890";
			const existingRow = [
				"1-234-567-890",
				"L001",
				"Pump",
				"ABC-100",
				"SMC",
				"Active",
				"In production",
				"",
				"",
				"",
				"50",
				"2024-01-15",
				"true"
			];

			const message = buildConfirmationMessage(formattedID, existingRow);

			expect(message).toContain("An entry with SAP Part Number 1-234-567-890 already exists:");
			expect(message).toContain("SAP Part Number: 1-234-567-890");
			expect(message).toContain("Legacy Part Number: L001");
			expect(message).toContain("Designation: Pump");
			expect(message).toContain("Model: ABC-100");
			expect(message).toContain("Manufacturer: SMC");
			expect(message).toContain("Status: Active");
			expect(message).toContain("Status Comment: In production");
			expect(message).toContain("Successor Model: ");
			expect(message).toContain("Successor Comment: ");
			expect(message).toContain("Successor SAP Number: ");
			expect(message).toContain("Stock: 50");
			expect(message).toContain("Information Date: 2024-01-15");
			expect(message).toContain("Auto Check: true");
			expect(message).toContain("Do you want to replace this entry with the new data?");
		});

		test('builds message with all populated fields', () => {
			const formattedID = "9-876-543-210";
			const existingRow = [
				"9-876-543-210",
				"L002",
				"Valve",
				"XYZ-200",
				"Festo",
				"EOL",
				"Discontinued",
				"XYZ-300",
				"Direct replacement",
				"9-876-543-211",
				"0",
				"2024-03-20",
				"false"
			];

			const message = buildConfirmationMessage(formattedID, existingRow);

			expect(message).toContain("Successor Model: XYZ-300");
			expect(message).toContain("Successor Comment: Direct replacement");
			expect(message).toContain("Successor SAP Number: 9-876-543-211");
		});
	});
});
