/**
 * Tests for netlify/functions/get-csv.js
 */

const mockGetStore = jest.fn();
jest.mock("@netlify/blobs", () => ({
	getStore: mockGetStore
}));

jest.mock("../netlify/functions/lib/csv-parser", () => ({
	parseCSV: jest.fn()
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

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
}));

const { handler } = require("../netlify/functions/get-csv");
const { parseCSV } = require("../netlify/functions/lib/csv-parser");

describe("get-csv handler", () => {
	let mockStore;

	beforeEach(() => {
		jest.clearAllMocks();
		mockStore = {
			get: jest.fn()
		};
		mockGetStore.mockReturnValue(mockStore);
		process.env.SITE_ID = "test-site";
		process.env.NETLIFY_TOKEN = "test-token";
	});

	test("returns default headers when no CSV data exists", async () => {
		mockStore.get.mockResolvedValue(null);

		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toContain("SAP Part Number");
		expect(body.data[0]).toHaveLength(13);
	});

	test("returns parsed CSV data on success", async () => {
		mockStore.get.mockResolvedValue("header1,header2\nval1,val2");
		parseCSV.mockReturnValue({
			success: true,
			data: [
				["header1", "header2"],
				["val1", "val2"]
			],
			error: null
		});

		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.data).toHaveLength(2);
		expect(body.warnings).toBeNull();
	});

	test("returns warnings from CSV parsing", async () => {
		mockStore.get.mockResolvedValue("data");
		parseCSV.mockReturnValue({
			success: true,
			data: [["col1"]],
			error: "Some field had issues"
		});

		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.warnings).toBe("Some field had issues");
	});

	test("returns 500 when CSV parsing fails", async () => {
		mockStore.get.mockResolvedValue("malformed data");
		parseCSV.mockReturnValue({
			success: false,
			data: null,
			error: "Unexpected end of input"
		});

		const result = await handler({}, {});

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.error).toBe("CSV parsing failed");
	});

	test("returns 500 on blob storage error", async () => {
		mockStore.get.mockRejectedValue(new Error("Blob storage error"));

		const result = await handler({}, {});

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Failed to read CSV data");
	});

	test("includes CORS headers in response", async () => {
		mockStore.get.mockResolvedValue(null);

		const result = await handler({}, {});

		expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
		expect(result.headers["Content-Type"]).toBe("application/json");
	});
});
