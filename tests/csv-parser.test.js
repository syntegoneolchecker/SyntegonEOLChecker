/**
 * Jest test suite for CSV Parser
 */

const { parseCSV, toCSV } = require('../netlify/functions/lib/csv-parser');

describe('CSV Parser Tests', () => {
  test('Parse basic CSV', () => {
    const basicCSV = 'col1,col2,col3\nval1,val2,val3';
    const result = parseCSV(basicCSV);
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(2);
  });

  test('Parse CSV with quoted commas', () => {
    const quotedCSV = 'name,description\n"Smith, John","Works at ACME, Inc."';
    const result = parseCSV(quotedCSV);
    expect(result.success).toBe(true);
    expect(result.data[1][0]).toBe('Smith, John');
    expect(result.data[1][1]).toBe('Works at ACME, Inc.');
  });

  test('Parse empty CSV', () => {
    const result = parseCSV('');
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(0);
  });

  test('Parse CSV with escaped quotes', () => {
    const escapedCSV = 'text\n"He said ""Hello"""';
    const result = parseCSV(escapedCSV);
    expect(result.success).toBe(true);
    expect(result.data[1][0]).toBe('He said "Hello"');
  });

  test('Parse CSV with column mismatch (with warnings)', () => {
    const mismatchCSV = 'a,b,c\n1,2,3\n4,5';  // 2nd row has only 2 columns
    const result = parseCSV(mismatchCSV);
    expect(result.success).toBe(true);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('Column count mismatch');
  });

  test('Reject non-string input', () => {
    const result = parseCSV(12345);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid CSV content type');
  });

  test('toCSV converts array to CSV string', () => {
    const data = [['a', 'b'], ['c', 'd']];
    const csvString = toCSV(data);
    expect(csvString).toBe('"a","b"\n"c","d"');
  });
});
