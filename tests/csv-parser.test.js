/**
 * Jest test suite for CSV Parser
 */

const { parseCSV, parseLine, validateColumnConsistency, toCSV } = require('../netlify/functions/lib/csv-parser');

describe('parseLine', () => {
    test('parses simple comma-separated values', () => {
        const { cells, hasUnclosedQuote } = parseLine('a,b,c');
        expect(cells).toEqual(['a', 'b', 'c']);
        expect(hasUnclosedQuote).toBe(false);
    });

    test('parses a single value with no commas', () => {
        const { cells, hasUnclosedQuote } = parseLine('hello');
        expect(cells).toEqual(['hello']);
        expect(hasUnclosedQuote).toBe(false);
    });

    test('trims whitespace from cell values', () => {
        const { cells } = parseLine('  a , b , c  ');
        expect(cells).toEqual(['a', 'b', 'c']);
    });

    test('handles quoted fields containing commas', () => {
        const { cells, hasUnclosedQuote } = parseLine('"Smith, John","ACME, Inc."');
        expect(cells).toEqual(['Smith, John', 'ACME, Inc.']);
        expect(hasUnclosedQuote).toBe(false);
    });

    test('handles escaped double quotes inside quoted fields', () => {
        const { cells } = parseLine('"He said ""Hello""",normal');
        expect(cells).toEqual(['He said "Hello"', 'normal']);
    });

    test('handles empty fields', () => {
        const { cells } = parseLine('a,,c');
        expect(cells).toEqual(['a', '', 'c']);
    });

    test('handles empty quoted fields', () => {
        const { cells } = parseLine('"",b,""');
        expect(cells).toEqual(['', 'b', '']);
    });

    test('detects unclosed quotes', () => {
        const { cells, hasUnclosedQuote } = parseLine('"unclosed,value');
        expect(hasUnclosedQuote).toBe(true);
        expect(cells.length).toBeGreaterThan(0);
    });

    test('handles an empty string', () => {
        const { cells, hasUnclosedQuote } = parseLine('');
        expect(cells).toEqual(['']);
        expect(hasUnclosedQuote).toBe(false);
    });

    test('handles mixed quoted and unquoted fields', () => {
        const { cells } = parseLine('plain,"quoted, with comma",another');
        expect(cells).toEqual(['plain', 'quoted, with comma', 'another']);
    });
});

describe('validateColumnConsistency', () => {
    test('returns null for empty data', () => {
        expect(validateColumnConsistency([])).toBeNull();
    });

    test('returns null for a single row', () => {
        expect(validateColumnConsistency([['a', 'b', 'c']])).toBeNull();
    });

    test('returns null when all rows have the same column count', () => {
        const data = [['a', 'b'], ['c', 'd'], ['e', 'f']];
        expect(validateColumnConsistency(data)).toBeNull();
    });

    test('returns error message when rows have different column counts', () => {
        const data = [['a', 'b', 'c'], ['1', '2', '3'], ['x', 'y']];
        const result = validateColumnConsistency(data);
        expect(result).toContain('Column count mismatch');
        expect(result).toContain('Expected 3 columns');
        expect(result).toContain('rows [3]');
    });

    test('reports all inconsistent rows', () => {
        const data = [['a', 'b'], ['1'], ['2', '3'], ['4']];
        const result = validateColumnConsistency(data);
        expect(result).toContain('rows [2, 4]');
    });
});

describe('parseCSV', () => {
    test('parses multi-line CSV into rows and columns', () => {
        const result = parseCSV('col1,col2,col3\nval1,val2,val3');
        expect(result.success).toBe(true);
        expect(result.error).toBeNull();
        expect(result.data).toEqual([
            ['col1', 'col2', 'col3'],
            ['val1', 'val2', 'val3']
        ]);
    });

    test('returns empty data for empty string', () => {
        const result = parseCSV('');
        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
        expect(result.error).toBeNull();
    });

    test('returns empty data for null/undefined', () => {
        expect(parseCSV(null)).toEqual({ success: true, data: [], error: null });
        expect(parseCSV(undefined)).toEqual({ success: true, data: [], error: null });
    });

    test('returns empty data for whitespace-only content', () => {
        const result = parseCSV('   \n   \n  ');
        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
    });

    test('rejects non-string input', () => {
        const result = parseCSV(12345);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid CSV content type');
        expect(result.error).toContain('number');
    });

    test('skips blank lines', () => {
        const result = parseCSV('a,b\n\nc,d\n');
        expect(result.success).toBe(true);
        expect(result.data).toEqual([['a', 'b'], ['c', 'd']]);
    });

    test('reports unclosed quote warning but still returns data', () => {
        const result = parseCSV('header\n"unclosed');
        expect(result.success).toBe(true);
        expect(result.data.length).toBe(2);
        expect(result.error).toContain('Unclosed quote');
    });

    test('reports column mismatch warning but still returns data', () => {
        const result = parseCSV('a,b,c\n1,2,3\n4,5');
        expect(result.success).toBe(true);
        expect(result.data.length).toBe(3);
        expect(result.error).toContain('Column count mismatch');
    });

    test('combines multiple warnings', () => {
        const result = parseCSV('a,b\n"unclosed\n1');
        expect(result.success).toBe(true);
        expect(result.error).toContain('Unclosed quote');
        expect(result.error).toContain('Column count mismatch');
    });
});

describe('toCSV', () => {
    test('converts 2D array to quoted CSV string', () => {
        const data = [['a', 'b'], ['c', 'd']];
        expect(toCSV(data)).toBe('"a","b"\n"c","d"');
    });

    test('returns empty string for null', () => {
        expect(toCSV(null)).toBe('');
    });

    test('returns empty string for undefined', () => {
        expect(toCSV(undefined)).toBe('');
    });

    test('returns empty string for non-array input', () => {
        expect(toCSV('not an array')).toBe('');
    });

    test('handles single row', () => {
        expect(toCSV([['x', 'y']])).toBe('"x","y"');
    });

    test('handles empty array', () => {
        expect(toCSV([])).toBe('');
    });
});
