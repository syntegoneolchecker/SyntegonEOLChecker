/**
 * Jest test suite for Validators
 */

const { validateInitializeJob, sanitizeString } = require('../netlify/functions/lib/validators');

describe('Validation Tests', () => {
  test('Valid maker and model', () => {
    const valid = validateInitializeJob({ maker: 'SMC', model: 'KQ2H08-01AS' });
    expect(valid.valid).toBe(true);
    expect(valid.errors.length).toBe(0);
  });

  test('Reject missing maker', () => {
    const noMaker = validateInitializeJob({ model: 'ABC-123' });
    expect(noMaker.valid).toBe(false);
    expect(noMaker.errors.some(e => e.includes('Maker is required'))).toBe(true);
  });

  test('Reject missing model', () => {
    const noModel = validateInitializeJob({ maker: 'SMC' });
    expect(noModel.valid).toBe(false);
    expect(noModel.errors.some(e => e.includes('Model is required'))).toBe(true);
  });

  test('Trim whitespace', () => {
    expect(sanitizeString('  hello  ')).toBe('hello');
  });

  test('Remove null bytes', () => {
    expect(sanitizeString('hello\x00world')).toBe('helloworld');
  });

  test('Truncate strings longer than 1000 chars', () => {
    const longString = 'a'.repeat(2000);
    const sanitized = sanitizeString(longString);
    expect(sanitized.length).toBeLessThanOrEqual(1000);
  });
});
