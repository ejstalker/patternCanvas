import type {
  BlockInstance,
  BlockMeasurementSource,
  BlockVariableBinding,
  BlockVariableDecl,
} from '../../project/types';
import type { MeasurementSet } from '../../project/measurements';
import { measurementValueCm } from '../rulers';
import type { BlockDefinition } from './spec';

/**
 * Turning a binding into a centimetre value.
 *
 * Same contract as a ruler's length: prefer the person's live measurement, fall
 * back to the snapshot stored on the binding, and only then to the declaration's
 * default — so a block always draws, even with no measurement library at all.
 */

/** The live value of a measurement source, or null if this person lacks it. */
export function sourceValueCm(
  source: BlockMeasurementSource,
  set: MeasurementSet | null | undefined
): number | null {
  const full = measurementValueCm(set, source.fieldId);
  if (full == null) return null;
  return full / source.divisor + source.offsetCm;
}

/** Resolve one binding against a person, ignoring the declaration's default. */
export function bindingValueCm(
  binding: BlockVariableBinding,
  set: MeasurementSet | null | undefined
): number {
  if (binding.mode === 'value') return binding.cm;
  return sourceValueCm(binding, set) ?? binding.fallbackCm;
}

/**
 * Keep a resolved value inside the bounds its declaration promises.
 *
 * Bounds are part of the contract: without this a single out-of-range number —
 * a hand-edited project, or a value written by an older build — throws the
 * whole draft off the table with no way back.
 */
export function clampToDeclared(variable: BlockVariableDecl, cm: number): number {
  return Math.min(variable.maxCm, Math.max(variable.minCm, cm));
}

/**
 * Resolve every variable for a definition. Anything the instance has no binding
 * for — a definition that gained a variable since the block was placed, say —
 * falls back to its declared default rather than blocking generation.
 */
export function resolveBlockValues(
  definition: BlockDefinition,
  instance: BlockInstance,
  set: MeasurementSet | null | undefined
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const variable of definition.variables) {
    const binding = instance.bindings[variable.id];
    const raw = binding ? bindingValueCm(binding, set) : variable.defaultValueCm;
    values[variable.id] = clampToDeclared(variable, raw);
  }
  return values;
}

/**
 * The bindings a freshly placed block starts with: every `suggested` measurement
 * is bound if this person actually has it, and everything else is the declared
 * default. This is what makes a skirt dropped on a measured person size itself
 * instead of arriving as a rectangle.
 */
export function defaultBindings(
  definition: BlockDefinition,
  set: MeasurementSet | null | undefined
): Record<string, BlockVariableBinding> {
  const bindings: Record<string, BlockVariableBinding> = {};
  for (const variable of definition.variables) {
    const suggested = variable.suggested;
    const live = suggested ? sourceValueCm(suggested, set) : null;
    if (suggested && live != null) {
      bindings[variable.id] = {
        mode: 'measurement',
        ...suggested,
        fallbackCm: live,
      };
    } else {
      bindings[variable.id] = { mode: 'value', cm: variable.defaultValueCm };
    }
  }
  return bindings;
}

/** A one-line summary of where a variable's number comes from. */
export function describeBinding(
  variable: BlockVariableDecl,
  binding: BlockVariableBinding | undefined,
  fieldLabel: (id: string) => string,
  format: (cm: number) => string,
  set: MeasurementSet | null | undefined
): string {
  if (!binding) return format(variable.defaultValueCm);
  if (binding.mode === 'value') return format(binding.cm);
  const live = sourceValueCm(binding, set);
  const parts: string[] = [];
  if (binding.divisor !== 1) parts.push(`${binding.divisor === 2 ? '½' : '¼'} × `);
  parts.push(fieldLabel(binding.fieldId));
  if (binding.offsetCm !== 0) {
    parts.push(binding.offsetCm > 0 ? ` + ${format(binding.offsetCm)}` : ` − ${format(-binding.offsetCm)}`);
  }
  if (live == null) parts.push(' (not measured)');
  return parts.join('');
}
