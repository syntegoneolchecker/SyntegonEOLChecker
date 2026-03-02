// =============================================================================
// Tests for js/table.js - Table Rendering and Sorting
// =============================================================================

import { state } from "../js/state.js";
import { sortTable } from "../js/table.js";

// Mock document for render() and updateCheckEOLButtons() calls
beforeAll(() => {
	global.document = {
		getElementById: jest.fn(() => ({
			innerHTML: "",
			textContent: "",
			className: "",
			disabled: false,
			checked: false,
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
	global.fetch = jest.fn(() =>
		Promise.resolve({
			ok: true,
			json: () => Promise.resolve({})
		})
	);
});

afterAll(() => {
	delete global.document;
	delete global.fetch;
});

describe("js/table.js - Table Sorting", () => {
	// Test data with header + 3 data rows
	const makeTestData = () => [
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
			"1-111-111-111",
			"L001",
			"Pump",
			"ABC-100",
			"SMC",
			"Active",
			"",
			"",
			"",
			"",
			"50",
			"2024-01-15",
			"true"
		],
		[
			"2-222-222-222",
			"L002",
			"Valve",
			"XYZ-200",
			"Festo",
			"EOL",
			"",
			"XYZ-300",
			"",
			"",
			"0",
			"2023-06-10",
			"false"
		],
		[
			"3-333-333-333",
			"L003",
			"Actuator",
			"MNO-300",
			"Bosch",
			"Active",
			"",
			"",
			"",
			"",
			"25",
			"2025-02-28",
			"true"
		]
	];

	let savedData;
	let savedOriginalData;
	let savedCurrentSort;

	beforeEach(() => {
		// Save state
		savedData = state.data;
		savedOriginalData = state.originalData;
		savedCurrentSort = { ...state.currentSort };

		// Reset state for each test
		state.data = makeTestData();
		state.originalData = null;
		state.currentSort.column = null;
		state.currentSort.direction = null;

		// Reset mocks
		jest.clearAllMocks();
	});

	afterEach(() => {
		// Restore state
		state.data = savedData;
		state.originalData = savedOriginalData;
		state.currentSort.column = savedCurrentSort.column;
		state.currentSort.direction = savedCurrentSort.direction;
	});

	test("sorting a text column ascending orders alphabetically", () => {
		// Sort by column 2 (Designation): Actuator, Pump, Valve
		sortTable(2);

		expect(state.currentSort.column).toBe(2);
		expect(state.currentSort.direction).toBe("asc");

		// Header should remain at index 0
		expect(state.data[0][2]).toBe("Designation");

		// Data rows should be sorted ascending by Designation
		expect(state.data[1][2]).toBe("Actuator");
		expect(state.data[2][2]).toBe("Pump");
		expect(state.data[3][2]).toBe("Valve");
	});

	test("sorting same column twice sets descending order", () => {
		// First sort: ascending
		sortTable(2);
		expect(state.currentSort.direction).toBe("asc");

		// Second sort: descending
		sortTable(2);
		expect(state.currentSort.column).toBe(2);
		expect(state.currentSort.direction).toBe("desc");

		// Data rows should be sorted descending by Designation
		expect(state.data[1][2]).toBe("Valve");
		expect(state.data[2][2]).toBe("Pump");
		expect(state.data[3][2]).toBe("Actuator");
	});

	test("tri-state toggle: asc -> desc -> reset to original order", () => {
		// Capture original order
		const originalFirstRow = state.data[1][0];
		const originalSecondRow = state.data[2][0];
		const originalThirdRow = state.data[3][0];

		// First click: ascending
		sortTable(2);
		expect(state.currentSort.direction).toBe("asc");

		// Second click: descending
		sortTable(2);
		expect(state.currentSort.direction).toBe("desc");

		// Third click: reset
		sortTable(2);
		expect(state.currentSort.column).toBeNull();
		expect(state.currentSort.direction).toBeNull();

		// Data should be back in original order
		expect(state.data[1][0]).toBe(originalFirstRow);
		expect(state.data[2][0]).toBe(originalSecondRow);
		expect(state.data[3][0]).toBe(originalThirdRow);
	});

	test("sorting a different column starts with ascending", () => {
		// Sort column 2 ascending first
		sortTable(2);
		expect(state.currentSort.column).toBe(2);
		expect(state.currentSort.direction).toBe("asc");

		// Now sort column 4 (Manufacturer): Bosch, Festo, SMC
		sortTable(4);
		expect(state.currentSort.column).toBe(4);
		expect(state.currentSort.direction).toBe("asc");

		expect(state.data[1][4]).toBe("Bosch");
		expect(state.data[2][4]).toBe("Festo");
		expect(state.data[3][4]).toBe("SMC");
	});

	test("original data is preserved when sorting", () => {
		expect(state.originalData).toBeNull();

		sortTable(2);

		// originalData should have been saved before sorting
		expect(state.originalData).not.toBeNull();
		expect(state.originalData.length).toBe(4); // header + 3 rows

		// originalData should retain the original order
		expect(state.originalData[1][2]).toBe("Pump");
		expect(state.originalData[2][2]).toBe("Valve");
		expect(state.originalData[3][2]).toBe("Actuator");
	});

	test("sorting date column (column 11) sorts by date value", () => {
		// Dates: 2024-01-15, 2023-06-10, 2025-02-28
		sortTable(11);

		expect(state.currentSort.column).toBe(11);
		expect(state.currentSort.direction).toBe("asc");

		// Ascending: earliest first
		expect(state.data[1][11]).toBe("2023-06-10");
		expect(state.data[2][11]).toBe("2024-01-15");
		expect(state.data[3][11]).toBe("2025-02-28");

		// Sort descending
		sortTable(11);
		expect(state.currentSort.direction).toBe("desc");

		// Descending: latest first
		expect(state.data[1][11]).toBe("2025-02-28");
		expect(state.data[2][11]).toBe("2024-01-15");
		expect(state.data[3][11]).toBe("2023-06-10");
	});
});
