/**
 * Alt + wheel over a focused number input nudges its value by one `step`.
 *
 * Delegated from the document so it covers every number field in the app —
 * pattern ribbons, inspector panels and the modal dialogs — without each one
 * having to opt in.
 *
 * Fields that need to be selectable and caret-editable are `type="text"` with
 * `data-number-input` (a real number input cannot be selected at all), so the
 * query accepts both and only the native ones get the spin suppression.
 */

/** Every field this module drives. */
const NUMBER_FIELD = 'input[type="number"], input[data-number-input]';

/** Number inputs we have already wired, so repeated installs are harmless. */
const installed = new WeakSet<Document>();

/**
 * Decimal places implied by a step, so `0.1` steps do not accumulate binary
 * float noise (`94.1 + 0.1` → `94.20000000000002`).
 *
 * Returns -1 for steps small enough to be written in exponential form, where
 * counting digits from the string is meaningless and rounding would do harm.
 */
function stepPrecision(step: number): number {
  const text = String(step);
  if (text.includes('e') || text.includes('E')) return -1;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Step one number input up or down. Returns false when nothing changed — at a
 * `min`/`max` bound — so callers can skip firing events that would be a lie.
 */
export function nudgeNumberInput(input: HTMLInputElement, direction: -1 | 1): boolean {
  const declaredStep = Number.parseFloat(input.step);
  const step = Number.isFinite(declaredStep) && declaredStep > 0 ? declaredStep : 1;
  const min = input.min === '' ? -Infinity : Number.parseFloat(input.min);
  const max = input.max === '' ? Infinity : Number.parseFloat(input.max);
  const current = Number.parseFloat(input.value);
  // An empty field starts from its floor (or zero) rather than NaN.
  const base = Number.isFinite(current) ? current : Number.isFinite(min) ? min : 0;

  let next = base + direction * step;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  const precision = stepPrecision(step);
  if (precision >= 0 && precision <= 12) next = Number(next.toFixed(precision));

  if (next === current) return false;

  input.value = String(next);
  // Existing listeners ride on these, so the change lands wherever it needs to.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function onWheel(e: WheelEvent): void {
  if (e.deltaY === 0) return;
  const target = e.target;
  const input =
    target instanceof Element ? target.closest<HTMLInputElement>(NUMBER_FIELD) : null;
  if (!input || input.disabled || input.readOnly) return;
  const inHand = document.activeElement === input;

  if (!e.altKey) {
    // Chromium spins a *focused* number input on a bare wheel. Left alone that
    // silently edits values — you scroll the measurement list, or reach for the
    // canvas zoom with the pointer over a ribbon, and a number changes under
    // you. Only suppress it when the browser would actually fire, so an
    // enclosing panel can still scroll.
    if (inHand && input.type === 'number') e.preventDefault();
    return;
  }

  // Alt is the gesture, and it only acts on the field actually in hand —
  // otherwise a stray Alt+scroll would edit whatever was last focused.
  if (!inHand) return;
  e.preventDefault();
  nudgeNumberInput(input, e.deltaY < 0 ? 1 : -1);
}

/** Wire Alt+wheel nudge for every number input in this document. */
export function installNumberInputWheel(doc: Document = document): void {
  if (installed.has(doc)) return;
  installed.add(doc);
  // Capture phase and non-passive: the field usually sits inside a scrollable
  // panel that would otherwise swallow the gesture before we could preventDefault.
  doc.addEventListener('wheel', onWheel, { capture: true, passive: false });
}
