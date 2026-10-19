import type { Assessment } from './types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function reportPath(value: unknown): string {
  if (typeof value !== 'string') return '/';
  const match = /^\/\?report=([^&]+)$/.exec(value);
  return match && uuid.test(match[1]!) ? '/?report=' + match[1] : '/';
}
export function reportId(): string | null { return new URLSearchParams(location.search).get('report'); }
export function sameReportTotals(dashboard: Assessment, saved: Assessment): boolean {
  return (['daily_kwh', 'period_kwh', 'grid_equivalent_cost_ngn'] as const)
    .every(key => dashboard.totals[key] === saved.totals[key])
    && (['total', 'eligible', 'incomplete', 'invalid', 'unconfirmed'] as const)
      .every(key => String(dashboard.counts[key]) === String(saved.counts[key]));
}
