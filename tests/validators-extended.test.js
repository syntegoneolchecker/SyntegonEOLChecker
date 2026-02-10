/**
 * Extended tests for validators.js
 * Covers validateCsvData and remaining paths in validateInitializeJob/sanitizeString
 */

const {
	validateInitializeJob,
	validateCsvData,
	sanitizeString
} = require("../netlify/functions/lib/validators");

describe("Validators - Extended Tests", () => {
	describe("validateInitializeJob", () => {
		test("should reject null input", () => {
			const result = validateInitializeJob(null);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Request body is required");
		});

		test("should reject undefined input", () => {
			const result = validateInitializeJob(undefined);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Request body is required");
		});

		test("should reject empty object (both missing)", () => {
			const result = validateInitializeJob({});
			expect(result.valid).toBe(false);
			expect(result.errors).toHaveLength(2);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					"Model is required and must be a string",
					"Maker is required and must be a string"
				])
			);
		});

		test("should reject non-string model", () => {
			const result = validateInitializeJob({ model: 123, maker: "SMC" });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Model is required and must be a string");
		});

		test("should reject non-string maker", () => {
			const result = validateInitializeJob({ model: "ABC-123", maker: 42 });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Maker is required and must be a string");
		});

		test("should reject empty model (whitespace only)", () => {
			const result = validateInitializeJob({ model: "   ", maker: "SMC" });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Model cannot be empty");
		});

		test("should reject empty maker (whitespace only)", () => {
			const result = validateInitializeJob({ model: "ABC-123", maker: "   " });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Maker cannot be empty");
		});

		test("should reject model longer than 200 characters", () => {
			const result = validateInitializeJob({ model: "A".repeat(201), maker: "SMC" });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Model name too long (max 200 characters)");
		});

		test("should reject maker longer than 200 characters", () => {
			const result = validateInitializeJob({ model: "ABC-123", maker: "M".repeat(201) });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Maker name too long (max 200 characters)");
		});

		test("should accept model at exactly 200 characters", () => {
			const result = validateInitializeJob({ model: "A".repeat(200), maker: "SMC" });
			expect(result.valid).toBe(true);
		});

		test("should accept maker at exactly 200 characters", () => {
			const result = validateInitializeJob({ model: "ABC", maker: "M".repeat(200) });
			expect(result.valid).toBe(true);
		});
	});

	describe("validateCsvData", () => {
		test("should reject null data", () => {
			const result = validateCsvData(null);
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Data is required");
		});

		test("should reject undefined data", () => {
			const result = validateCsvData(undefined);
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Data is required");
		});

		test("should reject non-array data", () => {
			const result = validateCsvData("not an array");
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Data must be an array");
		});

		test("should reject object data", () => {
			const result = validateCsvData({ a: 1 });
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Data must be an array");
		});

		test("should reject empty array", () => {
			const result = validateCsvData([]);
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Data cannot be empty");
		});

		test("should reject non-array rows", () => {
			const result = validateCsvData([["a", "b"], "not an array"]);
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Row 1 is not an array");
		});

		test("should reject rows with mismatched column count", () => {
			const result = validateCsvData([
				["a", "b", "c"],
				["1", "2"]
			]);
			expect(result.valid).toBe(false);
			expect(result.error).toBe("Row 1 has 2 columns, expected 3");
		});

		test("should accept valid data with consistent columns", () => {
			const result = validateCsvData([
				["a", "b"],
				["1", "2"],
				["3", "4"]
			]);
			expect(result.valid).toBe(true);
			expect(result.error).toBeNull();
		});

		test("should accept single-row data", () => {
			const result = validateCsvData([["a", "b", "c"]]);
			expect(result.valid).toBe(true);
			expect(result.error).toBeNull();
		});

		test("should accept data with empty strings in cells", () => {
			const result = validateCsvData([
				["", ""],
				["x", ""]
			]);
			expect(result.valid).toBe(true);
			expect(result.error).toBeNull();
		});
	});

	describe("sanitizeString", () => {
		test("should return empty string for non-string input", () => {
			expect(sanitizeString(123)).toBe("");
			expect(sanitizeString(null)).toBe("");
			expect(sanitizeString(undefined)).toBe("");
			expect(sanitizeString({})).toBe("");
			expect(sanitizeString([])).toBe("");
		});

		test("should respect custom maxLength parameter", () => {
			const result = sanitizeString("hello world", 5);
			expect(result).toBe("hello");
		});

		test("should handle string exactly at maxLength", () => {
			const result = sanitizeString("hello", 5);
			expect(result).toBe("hello");
		});

		test("should handle empty string", () => {
			expect(sanitizeString("")).toBe("");
		});

		test("should handle string with only whitespace", () => {
			expect(sanitizeString("   ")).toBe("");
		});

		test("should remove multiple null bytes", () => {
			expect(sanitizeString("a\0b\0c\0d")).toBe("abcd");
		});

		test("should trim then truncate (trim first)", () => {
			// 5 spaces + 10 chars + 5 spaces = 20 chars, but after trim it's 10
			const result = sanitizeString("     1234567890     ", 8);
			expect(result).toBe("12345678");
		});
	});
});
