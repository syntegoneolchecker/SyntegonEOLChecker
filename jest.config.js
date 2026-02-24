module.exports = {
	// Test environment
	testEnvironment: "node",

	// Test match patterns
	testMatch: ["**/tests/**/*.test.js", "**/__tests__/**/*.js", "**/?(*.)+(spec|test).js"],

	// Coverage configuration
	collectCoverage: false, // Only when --coverage flag is used
	coverageDirectory: "coverage",
	coverageReporters: ["lcov", "text", "html"],

	// Files to collect coverage from
	collectCoverageFrom: [
		"netlify/functions/**/*.js",
		"scraping-service/**/*.js",
		"js/**/*.js",
		"shared/**/*.js",
		"!**/node_modules/**",
		"!**/coverage/**",
		"!**/*.test.js",
		"!**/*.spec.js"
	],

	// Transform ES modules for frontend tests
	transform: {
		"^.+\\.js$": ["babel-jest", { configFile: "./babel.config.json" }]
	},
	transformIgnorePatterns: ["/node_modules/"],

	// Module paths
	roots: ["<rootDir>"],

	// Ignore patterns
	testPathIgnorePatterns: ["/node_modules/", "/coverage/"],

	// Verbose output
	verbose: true
};
