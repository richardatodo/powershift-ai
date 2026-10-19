import { LosslessNumber } from 'lossless-json';
import type { Appliance, Sector } from './types';
import { text } from './types';

const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export function compare(a: string, b: string): number {
  function parts(value: string): [bigint, number] {
    if (!numeric.test(value) || value.length > 8224) throw new Error('Use a decimal number, for example 0.5.');
    const [mantissa, exponent = '0'] = value.toLowerCase().split('e');
    const digits = mantissa.replace('.', '');
    const power = Number(exponent) - (mantissa.split('.')[1]?.length || 0);
    if (!Number.isInteger(power) || Math.abs(power) > 4096 || digits.replace('-', '').length > 4096) throw new Error('This number exceeds the supported size.');
    return [BigInt(digits), power];
  }
  const [x, xp] = parts(a), [y, yp] = parts(b), base = Math.min(xp, yp);
  const left = x * 10n ** BigInt(xp - base), right = y * 10n ** BigInt(yp - base);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function numberError(value: string, min: string, max?: string, exclusive = false, integer = false): string | null {
  try {
    if (integer && !/^\d+$/.test(value)) return 'Use a whole number.';
    const comparison = compare(value, min);
    if (comparison < 0 || exclusive && comparison === 0) return exclusive ? `Enter a number greater than ${min}.` : `Enter ${min} or more.`;
    if (max && compare(value, max) > 0) return `Enter ${max} or less.`;
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'Use a valid number.'; }
}
export interface ApplianceForm {
  name: string; quantity: string; rated_watts: string; hours_per_day: string; effective_load_percent: string;
  brand: string; model: string; source_method: Appliance['source_method']; source_notes: string;
}
export type FieldErrors = Record<string, string>;
export const blankAppliance: ApplianceForm = { name: '', quantity: '1', rated_watts: '', hours_per_day: '', effective_load_percent: '', brand: '', model: '', source_method: 'manual', source_notes: '' };
export function fromAppliance(row: Appliance): ApplianceForm {
  return { name: row.name, quantity: text(row.quantity), rated_watts: text(row.rated_watts), hours_per_day: text(row.hours_per_day),
    effective_load_percent: text(row.effective_load_percent), brand: row.brand || '', model: row.model || '', source_method: row.source_method, source_notes: row.source_notes || '' };
}
export function validateAppliance(value: ApplianceForm, confirmed: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (!value.name.trim() || value.name.trim().length > 200) errors.name = 'Enter an appliance name, up to 200 characters.';
  for (const [field, min, max, exclusive, integer] of [
    ['quantity', '1', '9007199254740991', false, true], ['rated_watts', '0', undefined, true, false],
    ['hours_per_day', '0', '24', false, false], ['effective_load_percent', '0', '100', true, false],
  ] as const) {
    if (field !== 'quantity' && value[field].trim() === '') continue;
    const error = numberError(value[field].trim(), min, max, exclusive, integer);
    if (error) errors[field] = error;
  }
  for (const field of ['brand', 'model'] as const) if (value[field].trim().length > 200) errors[field] = 'Use up to 200 characters.';
  if (value.source_notes.length > 2000) errors.source_notes = 'Use up to 2,000 characters.';
  if (!confirmed) errors.confirmation = 'Confirm that you reviewed these values, including any unknowns.';
  return errors;
}
export function appliancePayload(value: ApplianceForm, confirmed: boolean, original?: Appliance) {
  const decimal = (input: string) => input.trim() === '' ? null : new LosslessNumber(input.trim());
  return { name: value.name.trim(), quantity: new LosslessNumber(value.quantity.trim()), rated_watts: decimal(value.rated_watts),
    hours_per_day: decimal(value.hours_per_day), effective_load_percent: decimal(value.effective_load_percent),
    brand: value.brand.trim() || null, model: value.model.trim() || null, source_method: value.source_method,
    source_notes: value.source_notes.trim() || null, scan_id: value.source_method === 'ai_label_extraction' ? original?.scan_id : null,
    confirmation: confirmed, ...(original ? { version: original.version } : {}) };
}
export const suggestions: Record<Sector, string[]> = {
  home: ['Ceiling fan', 'Refrigerator', 'Television', 'LED light', 'Air conditioner', 'Electric iron'],
  restaurant: ['Refrigerator', 'Freezer', 'Extractor fan', 'Blender', 'Lighting'],
  salon: ['Hair dryer', 'Hair clipper', 'Ceiling fan', 'Air conditioner', 'Lighting'],
  laundry: ['Washing machine', 'Dryer', 'Electric iron', 'Water pump', 'Lighting'],
  retail: ['Display refrigerator', 'Freezer', 'POS terminal', 'Lighting', 'Ceiling fan'],
  office: ['Laptop', 'Desktop computer', 'Printer', 'Air conditioner', 'Lighting'],
  hotel: ['Air conditioner', 'Water heater', 'Television', 'Refrigerator', 'Lighting'],
  workshop: ['Drill', 'Grinder', 'Compressor', 'Ventilation fan', 'Lighting'],
};
