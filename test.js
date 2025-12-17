/**
 * Simple test suite for EOL Checker - NO API TOKEN USAGE
 *
 * Tests only pure logic functions that don't make external API calls:
 * - CSV parsing
 * - Input validation
 * - URL construction
 *
 * Run with: node test.js
 */

const { parseCSV, toCSV } = require('./netlify/functions/lib/csv-parser');
const { validateInitializeJob, sanitizeString } = require('./netlify/functions/lib/validators');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`✓ ${testName}`);
        passed++;
    } else {
        console.error(`✗ ${testName}`);
        failed++;
    }
}

function assertEqual(actual, expected, testName) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        console.log(`✓ ${testName}`);
        passed++;
    } else {
        console.error(`✗ ${testName}`);
        console.error(`  Expected: ${JSON.stringify(expected)}`);
        console.error(`  Got: ${JSON.stringify(actual)}`);
        failed++;
    }
}

console.log('=== CSV Parser Tests ===\n');

// Test 1: Basic CSV parsing
const basicCSV = 'col1,col2,col3\nval1,val2,val3';
const result1 = parseCSV(basicCSV);
assert(result1.success, 'Parse basic CSV');
assertEqual(result1.data.length, 2, 'Basic CSV has 2 rows');

// Test 2: Quoted fields with commas
const quotedCSV = 'name,description\n"Smith, John","Works at ACME, Inc."';
const result2 = parseCSV(quotedCSV);
assert(result2.success, 'Parse CSV with quoted commas');
assertEqual(result2.data[1][0], 'Smith, John', 'Quoted comma in field 1');
assertEqual(result2.data[1][1], 'Works at ACME, Inc.', 'Quoted comma in field 2');

// Test 3: Empty CSV
const result3 = parseCSV('');
assert(result3.success, 'Parse empty CSV');
assertEqual(result3.data.length, 0, 'Empty CSV returns empty array');

// Test 4: Escaped quotes
const escapedCSV = 'text\n"He said ""Hello"""';
const result4 = parseCSV(escapedCSV);
assert(result4.success, 'Parse CSV with escaped quotes');
assertEqual(result4.data[1][0], 'He said "Hello"', 'Escaped quotes handled correctly');

// Test 5: Column mismatch detection
const mismatchCSV = 'a,b,c\n1,2,3\n4,5';  // 2nd row has only 2 columns
const result5 = parseCSV(mismatchCSV);
assert(result5.success, 'Parse CSV with column mismatch (with warnings)');
assert(result5.error !== null, 'Column mismatch generates warning');
assert(result5.error.includes('Column count mismatch'), 'Warning mentions column mismatch');

// Test 6: Invalid input type
const result6 = parseCSV(12345);
assert(!result6.success, 'Reject non-string input');
assert(result6.error.includes('Invalid CSV content type'), 'Error mentions type mismatch');

// Test 7: toCSV conversion
const data = [['a', 'b'], ['c', 'd']];
const csvString = toCSV(data);
assertEqual(csvString, '"a","b"\n"c","d"', 'toCSV converts array to CSV string');

console.log('\n=== Validation Tests ===\n');

// Test 8: Valid initialization
const valid = validateInitializeJob({ maker: 'SMC', model: 'KQ2H08-01AS' });
assert(valid.valid, 'Valid maker and model');
assertEqual(valid.errors.length, 0, 'No errors for valid input');

// Test 9: Missing maker
const noMaker = validateInitializeJob({ model: 'ABC-123' });
assert(!noMaker.valid, 'Reject missing maker');
assert(noMaker.errors.some(e => e.includes('Maker is required')), 'Error mentions missing maker');

// Test 10: Missing model
const noModel = validateInitializeJob({ maker: 'SMC' });
assert(!noModel.valid, 'Reject missing model');
assert(noModel.errors.some(e => e.includes('Model is required')), 'Error mentions missing model');

// Test 11: String sanitization
assertEqual(sanitizeString('  hello  '), 'hello', 'Trim whitespace');
assertEqual(sanitizeString('hello\x00world'), 'helloworld', 'Remove null bytes');

// Test 12: Long string truncation
const longString = 'a'.repeat(2000);
const sanitized = sanitizeString(longString);
assert(sanitized.length <= 1000, 'Truncate strings longer than 1000 chars');

console.log('\n=== Test Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed === 0) {
    console.log('\n✓ All tests passed!');
    process.exit(0);
} else {
    console.log(`\n✗ ${failed} test(s) failed`);
    process.exit(1);
}
