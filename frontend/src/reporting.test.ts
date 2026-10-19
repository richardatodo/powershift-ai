import { describe, expect, it } from 'vitest';
import { LosslessNumber } from 'lossless-json';
import { reportPath, sameReportTotals } from './reporting';
import type { Assessment } from './types';

describe('report return paths', () => {
  const path = '/?report=11111111-1111-4111-8111-111111111111';
  it('preserves only an internal canonical report link', () => { expect(reportPath(path)).toBe(path); });
  it.each([undefined, null, {}, 'https://evil.example/', '//evil.example/', '/?report=bad',
    path + '&redirect=https://evil.example', '/auth/callback?code=secret'])('rejects %s', value => {
    expect(reportPath(value)).toBe('/');
  });
});
describe('dashboard versus captured totals', () => {
  const original = { totals: {daily_kwh:'0.123457',period_kwh:'3.703704',grid_equivalent_cost_ngn:'370.37'},
    counts: {total:new LosslessNumber('2'),eligible:new LosslessNumber('1'),incomplete:new LosslessNumber('1'),
      invalid:new LosslessNumber('0'),unconfirmed:new LosslessNumber('0')} } as Assessment;
  it('compares authoritative strings without recomputing arithmetic', () => { expect(sameReportTotals(original, original)).toBe(true); });
  it('detects a concurrent change to totals or exclusion counts', () => {
    expect(sameReportTotals(original, {...original,totals:{...original.totals,period_kwh:'3.703705'}})).toBe(false);
    expect(sameReportTotals(original, {...original,counts:{...original.counts,incomplete:new LosslessNumber('2')}})).toBe(false);
  });
});
