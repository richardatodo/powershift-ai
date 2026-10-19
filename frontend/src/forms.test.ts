import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'lossless-json';
import { appliancePayload, blankAppliance, compare, numberError, suggestions, validateAppliance } from './forms';

describe('manual form input boundaries', () => {
  it('keeps unknown factor incomplete even with zero hours', () => {
    const form = { ...blankAppliance, name: 'Fan', rated_watts: '100', hours_per_day: '0' };
    expect(validateAppliance(form, true)).toEqual({});
    const body = appliancePayload(form, true);
    expect(body.effective_load_percent).toBeNull();
    expect(String(body.hours_per_day)).toBe('0');
  });
  it('does not populate ratings when suggesting a name', () => {
    expect(Object.values(suggestions).flat().every(name => typeof name === 'string')).toBe(true);
    expect(blankAppliance.rated_watts).toBe('');
    expect(blankAppliance.hours_per_day).toBe('');
    expect(blankAppliance.effective_load_percent).toBe('');
  });
  it('requires review and a useful name', () => {
    expect(validateAppliance(blankAppliance, false)).toHaveProperty('name');
    expect(validateAppliance(blankAppliance, false)).toHaveProperty('confirmation');
  });
  it.each([
    ['quantity', '0'], ['quantity', '1.5'], ['quantity', '9007199254740992'],
    ['rated_watts', '0'], ['rated_watts', '-1'], ['rated_watts', 'Infinity'],
    ['hours_per_day', '24.00000000000000000000001'], ['hours_per_day', '-0.1'],
    ['effective_load_percent', '0'], ['effective_load_percent', '100.000000000000000001'],
  ])('rejects %s=%s without float rounding', (field, value) => {
    expect(validateAppliance({ ...blankAppliance, name: 'Fan', [field]: value }, true)).toHaveProperty(field);
  });
  it('supports exact numeric exponent inputs without energy arithmetic', () => {
    expect(compare('1.000e2', '100')).toBe(0);
    expect(compare('1e-20', '0')).toBe(1);
    expect(numberError('1e999999', '0')).not.toBeNull();
  });
  it('preserves long decimal input lexemes through HTTP serialization', () => {
    const value = '0.12345678901234567890123456789';
    const body = appliancePayload({ ...blankAppliance, name: 'Precision', rated_watts: value }, true);
    expect(stringify(body)).toContain(`"rated_watts":${value}`);
    const decoded = parse(stringify(body)! ) as Record<string, unknown>;
    expect(String(decoded.rated_watts)).toBe(value);
  });
});
