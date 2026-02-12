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

	// Coverage thresholds - prevent regression without blocking development
	coverageThreshold: {
		global: {
			statements: 45,
			branches: 40,
			functions: 45,
			lines: 45
		},
		"./netlify/functions/lib/": {
			statements: 90,
			branches: 80,
			functions: 95,
			lines: 95
		}
	},

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
