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
            ecmaVersion: 2021,
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
                // Browser globals (for script.js)
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                alert: 'readonly',
                confirm: 'readonly',
                AbortSignal: 'readonly'
            }
        },
        rules: {
            // Errors
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
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
    }
];
