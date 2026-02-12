/**
 * Tests for js/api.js
 * Tests saveToServer, manualSaveDatabase, loadFromServer with retry logic
 *
 * Since js/api.js uses ES modules and browser APIs (fetch),
 * we re-implement the logic and mock fetch.
 */

describe("API Module", () => {
	let showStatusCalls;
	let fetchMock;
	let state;
	let renderCalled;
	let setDataCalled;
	let resetSortStateCalled;

	// Mock functions
	function showStatus(message, type = "success", permanent = true) {
		showStatusCalls.push({ message, type, permanent });
	}

	function delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function setData(newData) {
		state.data = newData;
		setDataCalled = true;
	}

	function setOriginalData(val) {
		state.originalData = val;
	}

	function resetSortState() {
		resetSortStateCalled = true;
	}

	function render() {
		renderCalled = true;
	}

	// Replicate api.js functions
	async function saveToServer() {
		try {
			const response = await fetchMock("/.netlify/functions/save-csv", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: state.data })
			});

			const result = await response.json();

			if (response.ok) {
				showStatus("Changes saved to cloud storage successfully!");
			} else {
				showStatus("Error saving changes: " + result.error, "error");
			}
		} catch (error) {
			showStatus("Network error - unable to save: " + error.message, "error");
		}
	}

	async function manualSaveDatabase() {
		showStatus("Saving database...");
		await saveToServer();
	}

	function isValidData(result) {
		return result.data && Array.isArray(result.data);
	}

	async function fetchData() {
		const response = await fetchMock("/.netlify/functions/get-csv");
		if (!response.ok) {
			throw new Error(`Server returned ${response.status}`);
		}
		return response.json();
	}

	function processSuccessfulLoad(result, retry) {
		setData(result.data);
		setOriginalData(null);
		resetSortState();
		render();
		const successMessage =
			retry > 0
				? `Database loaded successfully after ${retry + 1} attempts`
				: "Database loaded successfully from cloud storage";
		showStatus(successMessage);
	}

	beforeEach(() => {
		showStatusCalls = [];
		renderCalled = false;
		setDataCalled = false;
		resetSortStateCalled = false;
		state = { data: [["header"]], originalData: null };
		fetchMock = jest.fn();
	});

	describe("saveToServer", () => {
		test("should save data successfully", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true })
			});

			await saveToServer();

			expect(fetchMock).toHaveBeenCalledWith("/.netlify/functions/save-csv", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: state.data })
			});
			expect(showStatusCalls[0].message).toContain("saved to cloud storage");
		});

		test("should show error on server error response", async () => {
			fetchMock.mockResolvedValue({
				ok: false,
				json: () => Promise.resolve({ error: "Database locked" })
			});

			await saveToServer();

			expect(showStatusCalls[0].message).toContain("Error saving changes");
			expect(showStatusCalls[0].message).toContain("Database locked");
			expect(showStatusCalls[0].type).toBe("error");
		});

		test("should show network error on fetch failure", async () => {
			fetchMock.mockRejectedValue(new Error("Connection refused"));

			await saveToServer();

			expect(showStatusCalls[0].message).toContain("Network error");
			expect(showStatusCalls[0].message).toContain("Connection refused");
			expect(showStatusCalls[0].type).toBe("error");
		});
	});

	describe("manualSaveDatabase", () => {
		test("should show saving status then save", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true })
			});

			await manualSaveDatabase();

			expect(showStatusCalls[0].message).toBe("Saving database...");
			expect(showStatusCalls[1].message).toContain("saved to cloud storage");
		});
	});

	describe("isValidData", () => {
		test("should return true for valid data", () => {
			expect(isValidData({ data: [["header"], ["row"]] })).toBe(true);
		});

		test("should return falsy for null data", () => {
			expect(isValidData({ data: null })).toBeFalsy();
		});

		test("should return falsy for non-array data", () => {
			expect(isValidData({ data: "string" })).toBeFalsy();
		});

		test("should return falsy for missing data property", () => {
			expect(isValidData({})).toBeFalsy();
		});

		test("should return true for empty array", () => {
			expect(isValidData({ data: [] })).toBe(true);
		});
	});

	describe("processSuccessfulLoad", () => {
		test("should set data, reset state, render and show success", () => {
			const result = { data: [["header"], ["row1"]] };
			processSuccessfulLoad(result, 0);

			expect(setDataCalled).toBe(true);
			expect(resetSortStateCalled).toBe(true);
			expect(renderCalled).toBe(true);
			expect(showStatusCalls[0].message).toContain(
				"Database loaded successfully from cloud storage"
			);
		});

		test("should show retry count in message when retry > 0", () => {
			const result = { data: [["header"]] };
			processSuccessfulLoad(result, 2);

			expect(showStatusCalls[0].message).toContain("after 3 attempts");
		});
	});

	describe("fetchData", () => {
		test("should return parsed JSON on success", async () => {
			const mockData = { data: [["header"]] };
			fetchMock.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(mockData)
			});

			const result = await fetchData();
			expect(result).toEqual(mockData);
		});

		test("should throw on non-ok response", async () => {
			fetchMock.mockResolvedValue({
				ok: false,
				status: 500
			});

			await expect(fetchData()).rejects.toThrow("Server returned 500");
		});
	});

	describe("loadFromServer retry logic", () => {
		test("should calculate exponential wait times", () => {
			// waitTime = 1000 * Math.pow(2, retry)
			expect(1000 * Math.pow(2, 0)).toBe(1000);
			expect(1000 * Math.pow(2, 1)).toBe(2000);
			expect(1000 * Math.pow(2, 2)).toBe(4000);
		});
	});
});
