// ============================================================================
// TABLE RENDERING AND SORTING
// ============================================================================

import { state, setData, setOriginalData } from "./state.js";

// ============================================================================
// TABLE RENDERING
// ============================================================================

/**
 * Render table header cell
 */
function renderTableHeader(columnContent, columnIndex, sortableColumns) {
	const isSortable = sortableColumns.includes(columnIndex);
	let sortIndicator = "";
	if (state.currentSort.column === columnIndex) {
		if (state.currentSort.direction === "asc") {
			sortIndicator = " ▲";
		} else if (state.currentSort.direction === "desc") {
			sortIndicator = " ▼";
		}
	}
	const clickHandler = isSortable
		? ` onclick="sortTable(${columnIndex})" style="cursor: pointer; user-select: none;"`
		: "";
	return `<th${clickHandler}>${columnContent}${sortIndicator}</th>`;
}

/**
 * Render table data cell
 */
function renderTableCell(cellContent) {
	return `<td>${cellContent}</td>`;
}

/**
 * Render table action buttons
 */
function renderActionButtons(rowIndex) {
	const disabled = state.isManualCheckRunning ? "disabled" : "";
	return `<td><button id="check-eol-button" class="check-eol" onclick="checkEOL(${rowIndex})" ${disabled}>Check EOL</button><button class="delete" onclick="delRow(${rowIndex})">Delete</button></td>`;
}

/**
 * Update Check EOL button states after rendering
 */
async function updateButtonStates() {
	try {
		const response = await fetch("/.netlify/functions/get-auto-check-state");
		const autoCheckState = response.ok ? await response.json() : null;

		const shouldDisable =
			state.isManualCheckRunning || autoCheckState?.isRunning || !state.initComplete;
		updateCheckEOLButtons(shouldDisable);
	} catch (error) {
		console.warn("Failed to fetch auto-check state:", error);
		if (state.isManualCheckRunning) {
			updateCheckEOLButtons(true);
		}
	}
}

/**
 * Update Check EOL buttons
 */
export function updateCheckEOLButtons(isRunning) {
	const checkButtons = document.querySelectorAll(".check-eol");
	checkButtons.forEach((button) => {
		button.disabled = isRunning;
	});
}

/**
 * Get total number of pages
 */
export function getTotalPages() {
	const totalRows = state.data.length - 1; // exclude header
	return Math.max(1, Math.ceil(totalRows / state.rowsPerPage));
}

/**
 * Change to a specific page
 */
export function changePage(page) {
	const totalPages = getTotalPages();
	state.currentPage = Math.max(1, Math.min(page, totalPages));
	render();
	window.scrollTo(0, document.body.scrollHeight);
}

/**
 * Render pagination controls
 */
function renderPaginationControls() {
	const totalRows = state.data.length - 1;
	const totalPages = getTotalPages();

	if (totalRows <= state.rowsPerPage) return "";

	const start = (state.currentPage - 1) * state.rowsPerPage + 1;
	const end = Math.min(state.currentPage * state.rowsPerPage, totalRows);

	return `<div class="pagination-controls">
		<button onclick="changePage(1)" ${state.currentPage === 1 ? "disabled" : ""}>First</button>
		<button onclick="changePage(${state.currentPage - 1})" ${state.currentPage === 1 ? "disabled" : ""}>Prev</button>
		<span class="pagination-info">Rows ${start}-${end} of ${totalRows} (Page ${state.currentPage}/${totalPages})</span>
		<button onclick="changePage(${state.currentPage + 1})" ${state.currentPage === totalPages ? "disabled" : ""}>Next</button>
		<button onclick="changePage(${totalPages})" ${state.currentPage === totalPages ? "disabled" : ""}>Last</button>
	</div>`;
}

/**
 * Render the table
 */
export function render() {
	const sortableColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

	// Clamp current page to valid range
	const totalPages = getTotalPages();
	if (state.currentPage > totalPages) state.currentPage = totalPages;

	// Calculate page slice indices into state.data (1-based, since 0 is header)
	const startIdx = (state.currentPage - 1) * state.rowsPerPage + 1;
	const endIdx = Math.min(state.currentPage * state.rowsPerPage, state.data.length - 1);

	const header = state.data[0];
	const pageRows = state.data.slice(startIdx, endIdx + 1);

	const t = document.getElementById("table");
	const headerHtml = `<tr id="row-0">${header
		.map((c, j) => renderTableHeader(c, j, sortableColumns))
		.join("")}<th>Actions</th></tr>`;

	const rowsHtml = pageRows
		.map((r, pageIdx) => {
			const dataIndex = startIdx + pageIdx; // real index into state.data
			return `<tr id="row-${dataIndex}">${r
				.map((c) => renderTableCell(c))
				.join("")}${renderActionButtons(dataIndex)}</tr>`;
		})
		.join("");

	t.innerHTML = headerHtml + rowsHtml;

	// Render pagination controls
	let paginationContainer = document.getElementById("pagination");
	if (!paginationContainer) {
		paginationContainer = document.createElement("div");
		paginationContainer.id = "pagination";
		t.parentNode.insertBefore(paginationContainer, t.nextSibling);
	}
	paginationContainer.innerHTML = renderPaginationControls();

	updateButtonStates();
}

// ============================================================================
// SORTING FUNCTIONALITY
// ============================================================================

/**
 * Compare values for sorting
 */
function compareValues(aVal, bVal, columnIndex, direction) {
	if (columnIndex === 11) {
		const parseDate = (val) => {
			if (!val) return new Date(0);
			const [datePart, timePart] = val.split(", ");
			const [day, month, year] = datePart.split("/");
			return new Date(`${year}-${month}-${day}T${timePart}`);
		};
		const aDate = parseDate(aVal);
		const bDate = parseDate(bVal);
		return direction === "asc" ? aDate - bDate : bDate - aDate;
	}

	const aLower = (aVal || "").toString().toLowerCase();
	const bLower = (bVal || "").toString().toLowerCase();
	return direction === "asc" ? aLower.localeCompare(bLower) : bLower.localeCompare(aLower);
}

/**
 * Determine next sort state
 */
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

/**
 * Sort table by column
 */
export function sortTable(columnIndex) {
	if (state.originalData === null) {
		setOriginalData(structuredClone(state.data));
	}

	const nextDirection = getNextSortState(columnIndex);

	if (nextDirection === null) {
		state.currentSort.direction = null;
		state.currentSort.column = null;
		setData(structuredClone(state.originalData));
		render();
		return;
	}

	state.currentSort.column = columnIndex;
	state.currentSort.direction = nextDirection;

	const header = state.data[0];
	const rows = state.data.slice(1);

	rows.sort((a, b) =>
		compareValues(a[columnIndex], b[columnIndex], columnIndex, state.currentSort.direction)
	);

	setData([header, ...rows]);
	render();
}
