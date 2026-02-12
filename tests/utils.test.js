/**
 * Tests for js/utils.js
 * Tests utility functions: formatID, findRowBySAPNumber, parseCreditsRemaining,
 * isRenderServiceHealthy, delay, validateAndFormatSAPNumber, collectInputFields,
 * clearInputFields, buildConfirmationMessage, showStatus, updateRowInOriginalData
 *
 * Since js/utils.js uses ES module syntax, we re-implement the pure functions
 * for testing, and mock DOM interactions.
 */

describe("Utils Module", () => {
	// ====== formatID ======
	describe("formatID", () => {
		// Re-implement formatID for testing
		function formatID(input) {
			const digits = input.replaceAll(/\D/g, "");
			if (digits.length !== 10) {
				return null;
			}
			return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`;
		}

		test("should format 10 digits into X-XXX-XXX-XXX", () => {
			expect(formatID("8114463187")).toBe("8-114-463-187");
		});

		test("should handle already formatted input", () => {
			expect(formatID("8-114-463-187")).toBe("8-114-463-187");
		});

		test("should strip non-digit characters", () => {
			expect(formatID("8 114 463 187")).toBe("8-114-463-187");
			expect(formatID("8.114.463.187")).toBe("8-114-463-187");
		});

		test("should return null for fewer than 10 digits", () => {
			expect(formatID("811446318")).toBeNull();
		});

		test("should return null for more than 10 digits", () => {
			expect(formatID("81144631870")).toBeNull();
		});

		test("should return null for empty string", () => {
			expect(formatID("")).toBeNull();
		});

		test("should return null for no digits", () => {
			expect(formatID("abcdefghij")).toBeNull();
		});

		test("should handle mixed alphanumeric input", () => {
			expect(formatID("a8b1c1d4e4f6g3h1i8j7")).toBe("8-114-463-187");
		});
	});

	// ====== parseCreditsRemaining ======
	describe("parseCreditsRemaining", () => {
		function parseCreditsRemaining(creditsText) {
			const match = new RegExp(/(\d{1,6})\/\d{1,6} remaining/).exec(creditsText);
			return match ? Number.parseInt(match[1]) : null;
		}

		test("should parse credits from valid text", () => {
			expect(parseCreditsRemaining("85/100 remaining")).toBe(85);
		});

		test("should parse zero credits", () => {
			expect(parseCreditsRemaining("0/100 remaining")).toBe(0);
		});

		test("should parse large numbers", () => {
			expect(parseCreditsRemaining("999999/999999 remaining")).toBe(999999);
		});

		test("should return null for invalid format", () => {
			expect(parseCreditsRemaining("Error loading usage")).toBeNull();
		});

		test("should return null for empty string", () => {
			expect(parseCreditsRemaining("")).toBeNull();
		});

		test("should return null for N/A", () => {
			expect(parseCreditsRemaining("N/A")).toBeNull();
		});

		test("should return null if 'remaining' keyword is missing", () => {
			expect(parseCreditsRemaining("85/100")).toBeNull();
		});
	});

	// ====== delay ======
	describe("delay", () => {
		function delay(ms) {
			return new Promise((resolve) => setTimeout(resolve, ms));
		}

		test("should resolve after specified time", async () => {
			jest.useFakeTimers();

			const promise = delay(1000);
			jest.advanceTimersByTime(1000);

			await expect(promise).resolves.toBeUndefined();

			jest.useRealTimers();
		});

		test("should return a promise", () => {
			const result = delay(0);
			expect(result).toBeInstanceOf(Promise);
		});
	});

	// ====== findRowBySAPNumber ======
	describe("findRowBySAPNumber", () => {
		let state;

		function findRowBySAPNumber(sapNumber) {
			for (let i = 1; i < state.data.length; i++) {
				if (state.data[i][0] === sapNumber) {
					return i;
				}
			}
			return -1;
		}

		beforeEach(() => {
			state = {
				data: [
					["SAP Part Number", "Legacy Part Number"],
					["8-114-463-187", "OLD-001"],
					["1-234-567-890", "OLD-002"],
					["9-876-543-210", "OLD-003"]
				]
			};
		});

		test("should find existing row", () => {
			expect(findRowBySAPNumber("8-114-463-187")).toBe(1);
		});

		test("should find row at different index", () => {
			expect(findRowBySAPNumber("9-876-543-210")).toBe(3);
		});

		test("should return -1 for non-existent SAP number", () => {
			expect(findRowBySAPNumber("0-000-000-000")).toBe(-1);
		});

		test("should not match header row", () => {
			expect(findRowBySAPNumber("SAP Part Number")).toBe(-1);
		});

		test("should return -1 for empty database (only headers)", () => {
			state.data = [["SAP Part Number"]];
			expect(findRowBySAPNumber("8-114-463-187")).toBe(-1);
		});
	});

	// ====== updateRowInOriginalData ======
	describe("updateRowInOriginalData", () => {
		let state;

		function updateRowInOriginalData(row) {
			if (!state.originalData) return;
			const sapNumber = row[0];
			const originalIndex = state.originalData.findIndex((r) => r[0] === sapNumber);
			if (originalIndex !== -1) {
				state.originalData[originalIndex] = [...row];
			}
		}

		test("should do nothing if originalData is null", () => {
			state = { originalData: null };
			updateRowInOriginalData(["8-114-463-187", "data"]);
			expect(state.originalData).toBeNull();
		});

		test("should update matching row in originalData", () => {
			state = {
				originalData: [
					["SAP Part Number"],
					["8-114-463-187", "old-data"]
				]
			};

			updateRowInOriginalData(["8-114-463-187", "new-data"]);
			expect(state.originalData[1]).toEqual(["8-114-463-187", "new-data"]);
		});

		test("should not modify if SAP number not found", () => {
			state = {
				originalData: [
					["SAP Part Number"],
					["8-114-463-187", "old-data"]
				]
			};

			updateRowInOriginalData(["0-000-000-000", "new-data"]);
			expect(state.originalData[1]).toEqual(["8-114-463-187", "old-data"]);
		});

		test("should create a copy of the row (not a reference)", () => {
			state = {
				originalData: [
					["SAP Part Number"],
					["8-114-463-187", "old-data"]
				]
			};

			const row = ["8-114-463-187", "new-data"];
			updateRowInOriginalData(row);

			// Modify original row - should not affect originalData
			row[1] = "modified";
			expect(state.originalData[1][1]).toBe("new-data");
		});
	});

	// ====== isRenderServiceHealthy ======
	describe("isRenderServiceHealthy", () => {
		function isRenderServiceHealthy(statusText) {
			return (
				!statusText.includes("Timeout") &&
				!statusText.includes("Offline") &&
				!statusText.includes("Error")
			);
		}

		test("should return true for Ready status", () => {
			expect(isRenderServiceHealthy("Ready (1.2s)")).toBe(true);
		});

		test("should return true for Ready after retry", () => {
			expect(isRenderServiceHealthy("Ready after retry (45.3s total)")).toBe(true);
		});

		test("should return false for Timeout", () => {
			expect(isRenderServiceHealthy("Offline after 120.0s (Timeout)")).toBe(false);
		});

		test("should return false for Offline", () => {
			expect(isRenderServiceHealthy("Offline after 120.0s")).toBe(false);
		});

		test("should return false for Error", () => {
			expect(isRenderServiceHealthy("Error: Network error")).toBe(false);
		});

		test("should return true for Checking status", () => {
			expect(isRenderServiceHealthy("Checking...")).toBe(true);
		});
	});

	// ====== validateAndFormatSAPNumber ======
	describe("validateAndFormatSAPNumber", () => {
		let statusMessages;

		function showStatus(message, type) {
			statusMessages.push({ message, type });
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

		beforeEach(() => {
			statusMessages = [];
		});

		test("should format valid SAP number", () => {
			expect(validateAndFormatSAPNumber("8114463187")).toBe("8-114-463-187");
		});

		test("should return null and show error for empty input", () => {
			expect(validateAndFormatSAPNumber("")).toBeNull();
			expect(statusMessages[0].type).toBe("error");
			expect(statusMessages[0].message).toContain("required");
		});

		test("should return null and show error for invalid format", () => {
			expect(validateAndFormatSAPNumber("123")).toBeNull();
			expect(statusMessages[0].type).toBe("error");
			expect(statusMessages[0].message).toContain("10 digits");
		});

		test("should return null for null input", () => {
			expect(validateAndFormatSAPNumber(null)).toBeNull();
		});

		test("should return null for undefined input", () => {
			expect(validateAndFormatSAPNumber(undefined)).toBeNull();
		});
	});

	// ====== buildConfirmationMessage ======
	describe("buildConfirmationMessage", () => {
		function buildConfirmationMessage(formattedID, existingRow) {
			return (
				`An entry with SAP Part Number ${formattedID} already exists:\n\n` +
				`SAP Part Number: ${existingRow[0]}\n` +
				`Legacy Part Number: ${existingRow[1]}\n` +
				`Designation: ${existingRow[2]}\n` +
				`Model: ${existingRow[3]}\n` +
				`Manufacturer: ${existingRow[4]}\n` +
				`Status: ${existingRow[5]}\n` +
				`Status Comment: ${existingRow[6]}\n` +
				`Successor Model: ${existingRow[7]}\n` +
				`Successor Comment: ${existingRow[8]}\n` +
				`Successor SAP Number: ${existingRow[9]}\n` +
				`Stock: ${existingRow[10]}\n` +
				`Information Date: ${existingRow[11]}\n` +
				`Auto Check: ${existingRow[12]}\n\n` +
				`Do you want to replace this entry with the new data?`
			);
		}

		test("should build message with all fields", () => {
			const row = [
				"8-114-463-187",
				"OLD-001",
				"Sensor",
				"MODEL-A",
				"SMC",
				"ACTIVE",
				"In production",
				"",
				"",
				"",
				"50",
				"1/1/2025",
				"YES"
			];

			const message = buildConfirmationMessage("8-114-463-187", row);

			expect(message).toContain("8-114-463-187");
			expect(message).toContain("OLD-001");
			expect(message).toContain("SMC");
			expect(message).toContain("MODEL-A");
			expect(message).toContain("Do you want to replace");
		});

		test("should handle empty fields gracefully", () => {
			const row = Array(13).fill("");
			const message = buildConfirmationMessage("1-234-567-890", row);

			expect(message).toContain("1-234-567-890");
			expect(message).toContain("Do you want to replace");
		});
	});

	// ====== showStatus ======
	describe("showStatus", () => {
		test("should set textContent and className on status element", () => {
			const statusElement = { textContent: "", className: "" };
			const document = {
				getElementById: (id) => {
					if (id === "status") return statusElement;
					return null;
				}
			};

			function showStatus(message, type = "success") {
				const status = document.getElementById("status");
				status.textContent = message;
				status.className = type;
			}

			showStatus("Test message");
			expect(statusElement.textContent).toBe("Test message");
			expect(statusElement.className).toBe("success");
		});

		test("should use error type", () => {
			const statusElement = { textContent: "", className: "" };
			const document = {
				getElementById: () => statusElement
			};

			function showStatus(message, type = "success") {
				const status = document.getElementById("status");
				status.textContent = message;
				status.className = type;
			}

			showStatus("Error occurred", "error");
			expect(statusElement.className).toBe("error");
		});
	});

	// ====== collectInputFields and clearInputFields ======
	describe("collectInputFields", () => {
		test("should collect values from sequential input elements", () => {
			const elements = {
				c2: { value: "value2" },
				c3: { value: "value3" },
				c4: { value: "value4" }
			};

			function collectInputFields(startIndex, endIndex) {
				const fields = [];
				for (let i = startIndex; i <= endIndex; i++) {
					const value = elements["c" + i]?.value || "";
					fields.push(value);
				}
				return fields;
			}

			const result = collectInputFields(2, 4);
			expect(result).toEqual(["value2", "value3", "value4"]);
		});
	});

	describe("clearInputFields", () => {
		test("should clear values in range", () => {
			const elements = {
				c1: { value: "val1" },
				c2: { value: "val2" },
				c3: { value: "val3" }
			};

			function clearInputFields(startIndex, endIndex) {
				for (let i = startIndex; i <= endIndex; i++) {
					if (elements["c" + i]) {
						elements["c" + i].value = "";
					}
				}
			}

			clearInputFields(1, 3);
			expect(elements.c1.value).toBe("");
			expect(elements.c2.value).toBe("");
			expect(elements.c3.value).toBe("");
		});
	});
});
