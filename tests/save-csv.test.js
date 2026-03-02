/**
 * Tests for netlify/functions/save-csv.js
 */

const mockGetStore = jest.fn();
jest.mock("@netlify/blobs", () => ({
	getStore: mockGetStore
}));

jest.mock("../netlify/functions/lib/csv-parser", () => ({
	toCSV: jest.fn(() => "col1,col2\nval1,val2")
}));

jest.mock("../netlify/functions/lib/validators", () => ({
	validateCsvData: jest.fn(() => ({ valid: true }))
}));

jest.mock("../netlify/functions/lib/config", () => ({
	CSV_COLUMN_COUNT: 13
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireAuth: jest.fn((handler) => handler)
}));

const { handler } = require("../netlify/functions/save-csv");
const { validateCsvData } = require("../netlify/functions/lib/validators");

describe("save-csv handler", () => {
	let mockStore;

	beforeEach(() => {
		jest.clearAllMocks();
		mockStore = { set: jest.fn().mockResolvedValue(undefined) };
		mockGetStore.mockReturnValue(mockStore);
		process.env.SITE_ID = "test-site";
		process.env.NETLIFY_TOKEN = "test-token";
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(405);
	});

	test("returns 400 when data field is missing", async () => {
		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ notData: true })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("data");
	});

	test("returns 400 when CSV validation fails", async () => {
		validateCsvData.mockReturnValue({ valid: false, error: "Data must be an array" });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ data: "not-array" })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.error).toBe("Data must be an array");
	});

	test("returns 400 when column count is wrong", async () => {
		validateCsvData.mockReturnValue({ valid: true });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ data: [["col1", "col2"]] })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Invalid column count");
	});

	test("saves CSV data successfully", async () => {
		validateCsvData.mockReturnValue({ valid: true });

		const data = [Array(13).fill("test")];
		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ data })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.message).toBe("Data saved successfully");
		expect(body.rows).toBe(1);
		expect(mockStore.set).toHaveBeenCalledWith("database.csv", expect.any(String));
	});

	test("returns 500 on storage error", async () => {
		validateCsvData.mockReturnValue({ valid: true });
		mockStore.set.mockRejectedValue(new Error("Write failed"));

		const data = [Array(13).fill("test")];
		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ data })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Failed to save CSV data");
	});
});
