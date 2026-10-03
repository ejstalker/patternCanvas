import { describe, expect, it } from 'vitest';
import { installNumberInputWheel, nudgeNumberInput } from './numberInputWheel';

// One install for the whole file — the module guards against repeat wiring.
installNumberInputWheel();

function makeInput(attrs: Record<string, string> = {}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  for (const [key, value] of Object.entries(attrs)) input.setAttribute(key, value);
  document.body.appendChild(input);
  return input;
}

function wheel(input: HTMLInputElement, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: -1,
    ...init,
  });
  input.dispatchEvent(event);
  return event;
}

describe('number input alt+wheel', () => {
  it('steps up on wheel up and down on wheel down', () => {
    const input = makeInput({ step: '0.5', value: '17.5' });
    input.focus();

    wheel(input, { altKey: true, deltaY: -1 });
    expect(input.value).toBe('18');

    wheel(input, { altKey: true, deltaY: 1 });
    expect(input.value).toBe('17.5');
  });

  it('uses a step of 1 when the field declares none', () => {
    const input = makeInput({ value: '4' });
    input.focus();
    wheel(input, { altKey: true, deltaY: -1 });
    expect(input.value).toBe('5');
  });

  it('fires input and change so existing listeners run', () => {
    const input = makeInput({ step: '0.5', value: '0' });
    input.focus();
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));
    input.addEventListener('change', () => seen.push('change'));

    wheel(input, { altKey: true, deltaY: -1 });
    expect(seen).toEqual(['input', 'change']);
  });

  it('edits nothing without Alt, and suppresses the browser spin that would', () => {
    // Chromium spins a focused number input on a bare wheel — a silent edit
    // when all you meant to do was scroll or zoom.
    const input = makeInput({ step: '0.5', value: '1' });
    input.focus();
    const event = wheel(input, { altKey: false, deltaY: -1 });
    expect(input.value).toBe('1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets an unfocused field pass the wheel through so panels still scroll', () => {
    // The measurement list is a scroller full of number inputs; suppressing
    // every wheel over them would make it unscrollable.
    const input = makeInput({ step: '0.5', value: '1' });
    const other = makeInput({ step: '0.5', value: '5' });
    other.focus();
    const event = wheel(input, { altKey: false, deltaY: -1 });
    expect(input.value).toBe('1');
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores the wheel when the field is not focused', () => {
    const input = makeInput({ step: '0.5', value: '1' });
    const other = makeInput({ step: '0.5', value: '5' });
    other.focus();
    const event = wheel(input, { altKey: true, deltaY: -1 });
    expect(input.value).toBe('1');
    expect(event.defaultPrevented).toBe(false);
  });

  it('swallows the gesture so the panel behind it does not scroll', () => {
    const input = makeInput({ step: '0.5', value: '1' });
    input.focus();
    expect(wheel(input, { altKey: true, deltaY: -1 }).defaultPrevented).toBe(true);
  });

  it('clamps to min and max', () => {
    const low = makeInput({ step: '0.5', value: '0', min: '0', max: '5' });
    low.focus();
    wheel(low, { altKey: true, deltaY: 1 });
    expect(low.value).toBe('0');

    const high = makeInput({ step: '0.5', value: '5', min: '0', max: '5' });
    high.focus();
    wheel(high, { altKey: true, deltaY: -1 });
    expect(high.value).toBe('5');
  });

  it('does not send events that would be a lie at a bound', () => {
    const input = makeInput({ step: '0.5', value: '5', min: '0', max: '5' });
    input.focus();
    let fired = 0;
    input.addEventListener('change', () => (fired += 1));
    wheel(input, { altKey: true, deltaY: -1 });
    expect(fired).toBe(0);
  });

  it('does not accumulate binary float noise on fine steps', () => {
    // The measurement fields use step 0.1; naive addition gives 94.20000000000002.
    const input = makeInput({ step: '0.1', value: '94' });
    input.focus();
    wheel(input, { altKey: true, deltaY: -1 });
    expect(input.value).toBe('94.1');
    wheel(input, { altKey: true, deltaY: -1 });
    expect(input.value).toBe('94.2');
  });

  it('starts an empty field from its floor, or zero when it has none', () => {
    // A floor: the first tick lands on a legal value, clamped up to `min`.
    const floored = makeInput({ step: '0.5', min: '2' });
    floored.value = '';
    floored.focus();
    wheel(floored, { altKey: true, deltaY: 1 });
    expect(floored.value).toBe('2');
    wheel(floored, { altKey: true, deltaY: -1 });
    expect(floored.value).toBe('2.5');

    // No floor: step straight off zero, which is what an unmeasured field wants
    // (a measurement of exactly 0 would be meaningless).
    const measured = makeInput({ step: '0.1' });
    measured.value = '';
    measured.focus();
    wheel(measured, { altKey: true, deltaY: -1 });
    expect(measured.value).toBe('0.1');
  });

  it('leaves disabled and read-only fields alone', () => {
    const disabled = makeInput({ step: '0.5', value: '1' });
    disabled.disabled = true;
    disabled.focus();
    wheel(disabled, { altKey: true, deltaY: -1 });
    expect(disabled.value).toBe('1');

    const readonly = makeInput({ step: '0.5', value: '1' });
    readonly.readOnly = true;
    readonly.focus();
    wheel(readonly, { altKey: true, deltaY: -1 });
    expect(readonly.value).toBe('1');
  });

  it('ignores horizontal-only wheel ticks and text inputs', () => {
    const input = makeInput({ step: '0.5', value: '1' });
    input.focus();
    wheel(input, { altKey: true, deltaY: 0 });
    expect(input.value).toBe('1');

    const text = document.createElement('input');
    text.type = 'text';
    text.value = 'abc';
    document.body.appendChild(text);
    text.focus();
    wheel(text, { altKey: true, deltaY: -1 });
    expect(text.value).toBe('abc');
  });
});

describe('nudgeNumberInput', () => {
  it('reports whether it changed anything', () => {
    const input = makeInput({ step: '0.5', value: '1' });
    expect(nudgeNumberInput(input, 1)).toBe(true);
    expect(input.value).toBe('1.5');
  });

  it('treats a non-numeric step as 1', () => {
    const input = makeInput({ value: '1' });
    input.setAttribute('step', 'any');
    expect(nudgeNumberInput(input, 1)).toBe(true);
    expect(input.value).toBe('2');
  });
});
