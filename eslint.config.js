// ESLint v9+ flat config format
module.exports = [
    {
        ignores: [
            '**/node_modules/**',
            '**/*.min.js',
            '**/dist/**',
            '**/.netlify/**'
        ]
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022, // Updated to support class fields
            sourceType: 'commonjs',
            globals: {
                // Node.js globals
                console: 'readonly',
                process: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                Promise: 'readonly',
                URL: 'readonly',
                Event: 'readonly',
                crypto: 'readonly',
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                alert: 'readonly',
                confirm: 'readonly',
                AbortSignal: 'readonly',
                AbortController: 'readonly',
                FileReader: 'readonly',
                Blob: 'readonly',
                structuredClone: 'readonly', // Modern browser API
                URLSearchParams: 'readonly',
                // External libraries
                XLSX: 'readonly'
            }
        },
        rules: {
            // Errors
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',

            // Warnings
            'prefer-const': 'warn',
            'no-trailing-spaces': 'warn',
            'no-multiple-empty-lines': ['warn', { max: 2 }],

            // Off
            'no-console': 'off'
        }
    },
    // Jest test files configuration
    {
        files: ['**/*.test.js', '**/tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Jest globals
                describe: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                jest: 'readonly',
                it: 'readonly'
            }
        }
    },
    // Frontend modules - ES module files in js/ directory
    {
        files: ['**/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module', // Enable ES modules
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                alert: 'readonly',
                confirm: 'readonly',
                AbortSignal: 'readonly',
                AbortController: 'readonly',
                FileReader: 'readonly',
                Blob: 'readonly',
                structuredClone: 'readonly',
                globalThis: 'readonly',
                localStorage: 'readonly',
                // External libraries
                XLSX: 'readonly'
            }
        },
        rules: {
            // Disable unused vars check for frontend - functions are called from HTML
            'no-unused-vars': 'off'
        }
    }
];
