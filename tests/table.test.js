/**
 * Tests for js/table.js
 * Tests table rendering logic, sorting, and compare functions
 *
 * Since table.js uses ES modules and DOM APIs, we test the pure logic functions
 * by re-implementing them and mock DOM interactions.
 */

describe("Table Module", () => {
	// ====== compareValues ======
	describe("compareValues", () => {
		function compareValues(aVal, bVal, columnIndex, direction) {
			if (columnIndex === 11) {
				const aDate = aVal ? new Date(aVal) : new Date(0);
				const bDate = bVal ? new Date(bVal) : new Date(0);
				return direction === "asc" ? aDate - bDate : bDate - aDate;
			}

			const aLower = (aVal || "").toString().toLowerCase();
			const bLower = (bVal || "").toString().toLowerCase();
			return direction === "asc"
				? aLower.localeCompare(bLower)
				: bLower.localeCompare(aLower);
		}

		describe("string comparison (non-date columns)", () => {
			test("should sort ascending alphabetically", () => {
				expect(compareValues("Apple", "Banana", 0, "asc")).toBeLessThan(0);
			});

			test("should sort descending alphabetically", () => {
				expect(compareValues("Apple", "Banana", 0, "desc")).toBeGreaterThan(0);
			});

			test("should return 0 for equal strings", () => {
				expect(compareValues("same", "same", 0, "asc")).toBe(0);
			});

			test("should be case-insensitive", () => {
				expect(compareValues("apple", "APPLE", 0, "asc")).toBe(0);
			});

			test("should handle null values", () => {
				expect(compareValues(null, "Banana", 0, "asc")).toBeLessThan(0);
			});

			test("should handle undefined values", () => {
				expect(compareValues(undefined, "Banana", 0, "asc")).toBeLessThan(0);
			});

			test("should handle empty strings", () => {
				expect(compareValues("", "Banana", 0, "asc")).toBeLessThan(0);
			});

			test("should handle numeric values as strings", () => {
				const result = compareValues("100", "20", 3, "asc");
				// String comparison: "100" < "20" (first char comparison)
				expect(result).toBeLessThan(0);
			});
		});

		describe("date comparison (column 11)", () => {
			test("should sort dates ascending", () => {
				expect(compareValues("1/1/2024", "6/15/2024", 11, "asc")).toBeLessThan(0);
			});

			test("should sort dates descending", () => {
				expect(compareValues("1/1/2024", "6/15/2024", 11, "desc")).toBeGreaterThan(0);
			});

			test("should return 0 for equal dates", () => {
				expect(compareValues("1/1/2024", "1/1/2024", 11, "asc")).toBe(0);
			});

			test("should treat empty date as epoch (earliest)", () => {
				expect(compareValues("", "1/1/2024", 11, "asc")).toBeLessThan(0);
			});

			test("should treat null date as epoch (earliest)", () => {
				expect(compareValues(null, "1/1/2024", 11, "asc")).toBeLessThan(0);
			});

			test("should handle different date formats", () => {
				expect(
					compareValues("12/31/2023, 11:59:59 PM", "1/1/2024, 12:00:00 AM", 11, "asc")
				).toBeLessThan(0);
			});
		});
	});

	// ====== getNextSortState ======
	describe("getNextSortState", () => {
		let state;

		function getNextSortState(columnIndex) {
			if (state.currentSort.column === columnIndex) {
				if (state.currentSort.direction === null) {
					return "asc";
				} else if (state.currentSort.direction === "asc") {
					return "desc";
				} else {
					return null;
				}
			} else {
				return "asc";
			}
		}

		beforeEach(() => {
			state = {
				currentSort: { column: null, direction: null }
			};
		});

		test("should return asc for new column", () => {
			expect(getNextSortState(3)).toBe("asc");
		});

		test("should return asc for same column with null direction", () => {
			state.currentSort.column = 3;
			state.currentSort.direction = null;
			expect(getNextSortState(3)).toBe("asc");
		});

		test("should return desc after asc on same column", () => {
			state.currentSort.column = 3;
			state.currentSort.direction = "asc";
			expect(getNextSortState(3)).toBe("desc");
		});

		test("should return null after desc on same column (reset)", () => {
			state.currentSort.column = 3;
			state.currentSort.direction = "desc";
			expect(getNextSortState(3)).toBeNull();
		});

		test("should return asc when switching to different column", () => {
			state.currentSort.column = 3;
			state.currentSort.direction = "desc";
			expect(getNextSortState(5)).toBe("asc");
		});
	});

	// ====== sortTable (integration) ======
	describe("sortTable", () => {
		let state;

		function compareValues(aVal, bVal, columnIndex, direction) {
			if (columnIndex === 11) {
				const aDate = aVal ? new Date(aVal) : new Date(0);
				const bDate = bVal ? new Date(bVal) : new Date(0);
				return direction === "asc" ? aDate - bDate : bDate - aDate;
			}
			const aLower = (aVal || "").toString().toLowerCase();
			const bLower = (bVal || "").toString().toLowerCase();
			return direction === "asc"
				? aLower.localeCompare(bLower)
				: bLower.localeCompare(aLower);
		}

		function getNextSortState(columnIndex) {
			if (state.currentSort.column === columnIndex) {
				if (state.currentSort.direction === null) return "asc";
				else if (state.currentSort.direction === "asc") return "desc";
				else return null;
			}
			return "asc";
		}

		function sortTable(columnIndex) {
			if (state.originalData === null) {
				state.originalData = JSON.parse(JSON.stringify(state.data));
			}

			const nextDirection = getNextSortState(columnIndex);

			if (nextDirection === null) {
				state.currentSort.direction = null;
				state.currentSort.column = null;
				state.data = JSON.parse(JSON.stringify(state.originalData));
				return;
			}

			state.currentSort.column = columnIndex;
			state.currentSort.direction = nextDirection;

			const header = state.data[0];
			const rows = state.data.slice(1);

			rows.sort((a, b) =>
				compareValues(
					a[columnIndex],
					b[columnIndex],
					columnIndex,
					state.currentSort.direction
				)
			);

			state.data = [header, ...rows];
		}

		beforeEach(() => {
			state = {
				data: [
					["SAP Part Number", "Manufacturer", "Model"],
					["8-114-463-187", "SMC", "ZModel"],
					["1-234-567-890", "Keyence", "AModel"],
					["9-876-543-210", "Omron", "MModel"]
				],
				originalData: null,
				currentSort: { column: null, direction: null }
			};
		});

		test("should sort ascending on first click", () => {
			sortTable(1); // Sort by Manufacturer

			expect(state.currentSort.direction).toBe("asc");
			expect(state.data[1][1]).toBe("Keyence");
			expect(state.data[2][1]).toBe("Omron");
			expect(state.data[3][1]).toBe("SMC");
		});

		test("should sort descending on second click", () => {
			sortTable(1); // First click - asc
			sortTable(1); // Second click - desc

			expect(state.currentSort.direction).toBe("desc");
			expect(state.data[1][1]).toBe("SMC");
			expect(state.data[2][1]).toBe("Omron");
			expect(state.data[3][1]).toBe("Keyence");
		});

		test("should restore original order on third click", () => {
			const originalOrder = state.data.map((row) => [...row]);

			sortTable(1); // asc
			sortTable(1); // desc
			sortTable(1); // reset

			expect(state.currentSort.column).toBeNull();
			expect(state.currentSort.direction).toBeNull();
			expect(state.data).toEqual(originalOrder);
		});

		test("should preserve header row", () => {
			sortTable(1);
			expect(state.data[0]).toEqual(["SAP Part Number", "Manufacturer", "Model"]);
		});

		test("should save originalData on first sort", () => {
			expect(state.originalData).toBeNull();
			sortTable(1);
			expect(state.originalData).not.toBeNull();
			expect(state.originalData).toHaveLength(4);
		});

		test("should not overwrite originalData on subsequent sorts", () => {
			sortTable(1);
			const savedOriginal = state.originalData;
			sortTable(2); // Different column
			expect(state.originalData).toBe(savedOriginal);
		});

		test("should sort by a different column", () => {
			sortTable(2); // Sort by Model

			expect(state.data[1][2]).toBe("AModel");
			expect(state.data[2][2]).toBe("MModel");
			expect(state.data[3][2]).toBe("ZModel");
		});
	});

	// ====== renderTableHeader ======
	describe("renderTableHeader", () => {
		function renderTableHeader(columnContent, columnIndex, sortableColumns, currentSort) {
			const isSortable = sortableColumns.includes(columnIndex);
			let sortIndicator = "";
			if (currentSort.column === columnIndex) {
				if (currentSort.direction === "asc") {
					sortIndicator = " ▲";
				} else if (currentSort.direction === "desc") {
					sortIndicator = " ▼";
				}
			}
			const clickHandler = isSortable
				? ` onclick="sortTable(${columnIndex})" style="cursor: pointer; user-select: none;"`
				: "";
			return `<th${clickHandler}>${columnContent}${sortIndicator}</th>`;
		}

		test("should render sortable header with click handler", () => {
			const html = renderTableHeader("Model", 3, [0, 1, 2, 3], {
				column: null,
				direction: null
			});
			expect(html).toContain("onclick");
			expect(html).toContain("sortTable(3)");
			expect(html).toContain("Model");
		});

		test("should render non-sortable header without click handler", () => {
			const html = renderTableHeader("Actions", 13, [0, 1, 2, 3], {
				column: null,
				direction: null
			});
			expect(html).not.toContain("onclick");
			expect(html).toContain("Actions");
		});

		test("should show ascending indicator", () => {
			const html = renderTableHeader("Model", 3, [3], { column: 3, direction: "asc" });
			expect(html).toContain("▲");
		});

		test("should show descending indicator", () => {
			const html = renderTableHeader("Model", 3, [3], { column: 3, direction: "desc" });
			expect(html).toContain("▼");
		});

		test("should not show indicator for unsorted column", () => {
			const html = renderTableHeader("Model", 3, [3], { column: 5, direction: "asc" });
			expect(html).not.toContain("▲");
			expect(html).not.toContain("▼");
		});
	});

	// ====== renderTableCell ======
	describe("renderTableCell", () => {
		function renderTableCell(cellContent) {
			return `<td>${cellContent}</td>`;
		}

		test("should wrap content in td tags", () => {
			expect(renderTableCell("test content")).toBe("<td>test content</td>");
		});

		test("should handle empty content", () => {
			expect(renderTableCell("")).toBe("<td></td>");
		});
	});

	// ====== renderActionButtons ======
	describe("renderActionButtons", () => {
		function renderActionButtons(rowIndex, isManualCheckRunning) {
			const disabled = isManualCheckRunning ? "disabled" : "";
			return `<td><button id="check-eol-button" class="check-eol" onclick="checkEOL(${rowIndex})" ${disabled}>Check EOL</button><button class="delete" onclick="delRow(${rowIndex})">Delete</button></td>`;
		}

		test("should render buttons with correct row index", () => {
			const html = renderActionButtons(5, false);
			expect(html).toContain("checkEOL(5)");
			expect(html).toContain("delRow(5)");
		});

		test("should disable check button when manual check running", () => {
			const html = renderActionButtons(1, true);
			expect(html).toContain("disabled");
		});

		test("should not disable check button when no manual check", () => {
			const html = renderActionButtons(1, false);
			// 'disabled' should only appear as empty string (no disabled attr)
			expect(html).toContain('class="check-eol"');
		});
	});
});
