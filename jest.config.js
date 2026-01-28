module.exports = {
  // Test environment
  testEnvironment: 'node',

  // Test match patterns
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.js',
    '**/?(*.)+(spec|test).js'
  ],

  // Coverage configuration
  collectCoverage: false, // Only when --coverage flag is used
  coverageDirectory: 'coverage',
  coverageReporters: ['lcov', 'text', 'html'],

  // Files to collect coverage from
  collectCoverageFrom: [
    'netlify/functions/**/*.js',
    'scraping-service/**/*.js',
    'js/**/*.js',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!netlify/functions/lib/csv-parser.js', // Excluded per sonar-project.properties
    '!**/*.test.js',
    '!**/*.spec.js'
  ],

  // Coverage thresholds (optional - can be adjusted)
  coverageThreshold: {
    global: {
      statements: 0,
      branches: 0,
      functions: 0,
      lines: 0
    }
  },

  // Module paths
  roots: ['<rootDir>'],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/coverage/',
    '/test.js$'  // Exclude old custom test file
  ],

  // Verbose output
  verbose: true
};
