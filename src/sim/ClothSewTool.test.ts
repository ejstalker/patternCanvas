import { afterEach, describe, expect, it, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import type { MeshGeometry, PatternDocument, SeamEdgeRef } from '../project/types';
import { ClothSewTool, type SewableCamera, type SewableCloth, type ViewportElement } from './ClothSewTool';

/**
 * Two short parallel edges (the two sides of one thin panel), the same layout the
 * picker tests use: with the identity projection and a 100 × 100 viewport, edge
 * a→b sits on screen y = 50 and c→d on y = 47.5.
 */
const mesh: MeshGeometry = {
  vertices: [
    { x: 0, y: 0 },
    { x: 0.2, y: 0 },
    { x: 0, y: 0.05 },
    { x: 0.2, y: 0.05 },
    { x: 0.1, y: 0.1 },
  ],
  triangles: [0, 1, 4, 1, 3, 4, 0, 4, 2, 2, 4, 3],
  edges: [],
  vertexPieceIds: ['p1', 'p1', 'p1', 'p1', 'p1'],
  boundary: [
    { pieceId: 'p1', fromPointId: 'a', toPointId: 'b', t: 1 },
    { pieceId: 'p1', fromPointId: 'a', toPointId: 'b', t: 0 },
    { pieceId: 'p1', fromPointId: 'c', toPointId: 'd', t: 1 },
    { pieceId: 'p1', fromPointId: 'c', toPointId: 'd', t: 0 },
    null,
  ],
};

const positions = new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.05, 0, 0.2, 0.05, 0, 0.1, 0.1, 0]);

// Anchored a little before the midpoint so they sit unambiguously in the first
// half: direction now depends on which half is picked (see FIRST_HALF below).
const ON_AB = [56, 50] as const;
const ON_CD = [56, 47.5] as const;

const seamRef = (fromPointId: string, toPointId: string): SeamEdgeRef => ({
  pieceId: 'p1',
  fromPointId,
  toPointId,
  t0: 0,
  t1: 1,
});

type Harness = {
  tool: ClothSewTool;
  host: HTMLElement;
  pattern: PatternDocument;
  onSewEdges: ReturnType<typeof vi.fn>;
  onReverseSeam: ReturnType<typeof vi.fn>;
  onDeleteSeam: ReturnType<typeof vi.fn>;
  hovered: () => string | null;
  source: () => string | null;
  sourceStart: () => string | null;
};

/** Every tool built by a test, torn down between tests so nothing leaks. */
const liveTools: ClothSewTool[] = [];
afterEach(() => {
  while (liveTools.length) liveTools.pop()!.destroy();
  document.querySelectorAll('.seam-context-menu').forEach((el) => el.remove());
});

/** Labels of the open seam popover's buttons, or null when it is closed. */
const seamMenuItems = (): string[] | null => {
  const menu = document.querySelector('.seam-context-menu');
  if (!menu) return null;
  return Array.from(menu.querySelectorAll('button')).map((b) => b.textContent ?? '');
};

/** Click the seam popover button with this label. */
const chooseSeamMenu = (label: string): void => {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.seam-context-menu button')
  ).find((b) => b.textContent === label);
  if (!button) throw new Error(`no seam menu item “${label}”`);
  button.click();
};

/** Points of a highlight line, as "x,y" pairs, or null when it is hidden. */
const pointsOf = (host: HTMLElement, kind: 'hover' | 'source'): string[] | null => {
  const el = host.querySelector(`.cloth-edge-line.is-${kind}`) as SVGPolylineElement | null;
  if (!el || el.style.display === 'none') return null;
  return (el.getAttribute('points') ?? '').split(' ');
};

/** The "read from here" dot of a highlight line, as "x,y". */
const startOf = (host: HTMLElement, kind: 'hover' | 'source'): string | null => {
  const el = host.querySelector(`.cloth-edge-start.is-${kind}`) as SVGCircleElement | null;
  if (!el || el.style.display === 'none') return null;
  return `${el.getAttribute('cx')},${el.getAttribute('cy')}`;
};

const makeTool = (seams: PatternDocument['seams'] = []): Harness => {
  const host = document.createElement('div');
  const canvas: ViewportElement = {
    clientWidth: 100,
    clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const camera: SewableCamera = {
    update: () => {},
    getViewProjectMtx: () => mat4.create(),
    getEyePosition: () => vec3.fromValues(0, 0, 5),
  };
  // Nothing occludes anything: the ray from the eye to an edge never lands early.
  const cloth: SewableCloth = {
    getPositionsSnapshot: () => positions,
    raycast: () => null,
  };
  const pattern = { id: 'pat1', seams } as unknown as PatternDocument;
  const onSewEdges = vi.fn();
  const onReverseSeam = vi.fn();
  const onDeleteSeam = vi.fn();
  const tool = new ClothSewTool({
    host,
    canvas,
    getCloth: () => cloth,
    getCamera: () => camera,
    getPattern: () => pattern,
    onSewEdges,
    onReverseSeam,
    onDeleteSeam,
  });
  liveTools.push(tool);
  tool.rebuild(mesh);
  tool.setEnabled(true);
  return {
    tool,
    host,
    pattern,
    onSewEdges,
    onReverseSeam,
    onDeleteSeam,
    hovered: () => (pointsOf(host, 'hover') ? 'edge' : null),
    source: () => pointsOf(host, 'source')?.join(' ') ?? null,
    sourceStart: () => startOf(host, 'source'),
  };
};

const click = (tool: ClothSewTool, at: readonly [number, number], moved = false): boolean => {
  tool.refreshHover(at[0], at[1]);
  tool.beginPress(at[0], at[1], 0);
  return tool.endPress(moved, 0);
};

describe('cloth sew tool', () => {
  it('has nothing to pick until it is given a mesh', () => {
    const h = makeTool();
    const bare = new ClothSewTool({
      host: document.createElement('div'),
      canvas: { clientWidth: 10, clientHeight: 10, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) },
      getCloth: () => null,
      getCamera: () => ({ update: () => {}, getViewProjectMtx: () => mat4.create(), getEyePosition: () => vec3.create() }),
      getPattern: () => null,
    });
    expect(bare.isAvailable()).toBe(false);
    bare.rebuild(null);
    expect(bare.isAvailable()).toBe(false);
    expect(h.tool.isAvailable()).toBe(true);
    bare.destroy();
  });

  it('highlights the edge under the pointer and drops it when disabled', () => {
    const h = makeTool();
    h.tool.refreshHover(ON_AB[0], ON_AB[1]);
    expect(h.hovered()).toBe('edge');
    h.tool.refreshHover(5, 5);
    expect(h.hovered()).toBeNull();

    h.tool.refreshHover(ON_AB[0], ON_AB[1]);
    h.tool.setEnabled(false);
    expect(h.hovered()).toBeNull();
  });

  it('keeps the first click lit until the second edge is clicked', () => {
    const h = makeTool();
    expect(click(h.tool, ON_AB)).toBe(true);
    expect(h.tool.hasPendingEdge()).toBe(true);
    expect(h.source()).toContain('50.00,50.00');
    expect(h.onSewEdges).not.toHaveBeenCalled();

    expect(click(h.tool, ON_CD)).toBe(true);
    expect(h.onSewEdges).toHaveBeenCalledWith(seamRef('a', 'b'), seamRef('c', 'd'));
    expect(h.tool.hasPendingEdge()).toBe(false);
  });

  it('takes the first click back when the same edge is clicked again', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    click(h.tool, ON_AB);
    expect(h.tool.hasPendingEdge()).toBe(false);
    expect(h.source()).toBeNull();
    expect(h.onSewEdges).not.toHaveBeenCalled();
  });

  // a→b runs on screen from x = 60 (read-from end) to x = 50, so 57.5 is its
  // first half and 52.5 its second — the Marvelous Designer direction gesture.
  const FIRST_HALF = [57.5, 50] as const;
  const SECOND_HALF = [52.5, 50] as const;

  it('hovering a half previews the direction a click there would sew', () => {
    const h = makeTool();
    h.tool.refreshHover(FIRST_HALF[0], FIRST_HALF[1]);
    expect(startOf(h.host, 'hover')).toBe('60.00,50.00');

    h.tool.refreshHover(SECOND_HALF[0], SECOND_HALF[1]);
    expect(startOf(h.host, 'hover')).toBe('50.00,50.00');
  });

  it('the clicked half sets the sewing direction of each edge', () => {
    const h = makeTool();
    // First edge picked on its second half → read from b back to a (reversed).
    expect(click(h.tool, SECOND_HALF)).toBe(true);
    expect(h.sourceStart()).toBe('50.00,50.00');
    // Second edge picked on its first half → forward.
    click(h.tool, ON_CD);
    expect(h.onSewEdges).toHaveBeenCalledWith(
      { ...seamRef('a', 'b'), t0: 1, t1: 0 },
      seamRef('c', 'd')
    );
  });

  it('clicking the other half of the pending edge flips it instead of cancelling', () => {
    const h = makeTool();
    click(h.tool, FIRST_HALF);
    expect(h.sourceStart()).toBe('60.00,50.00');

    // Other half of the same edge: same topology, opposite direction → flip.
    click(h.tool, SECOND_HALF);
    expect(h.tool.hasPendingEdge()).toBe(true);
    expect(h.sourceStart()).toBe('50.00,50.00');

    // Same half again now means "take it back".
    click(h.tool, SECOND_HALF);
    expect(h.tool.hasPendingEdge()).toBe(false);
  });

  it('previews the stitches a second click would make', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    // Picked, but the pointer still sits on the picked edge: nothing to pair.
    expect(h.host.querySelectorAll('.cloth-edge-stitch-line')).toHaveLength(0);

    h.tool.refreshHover(ON_CD[0], ON_CD[1]);
    const lines = h.host.querySelectorAll('.cloth-edge-stitch-line');
    expect(lines).toHaveLength(2);
    // Forward on both edges: straight across, both ends at x 60 and 50.
    expect(lines[0].getAttribute('x1')).toBe('60.00');
    expect(lines[0].getAttribute('x2')).toBe('60.00');
    expect(lines[1].getAttribute('x1')).toBe('50.00');
    expect(lines[1].getAttribute('x2')).toBe('50.00');

    // Back onto the source edge: no pairing to show.
    h.tool.refreshHover(ON_AB[0], ON_AB[1]);
    expect(h.host.querySelectorAll('.cloth-edge-stitch-line')).toHaveLength(0);
  });

  it('the hovered half turns the preview into a crossing', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    // c→d reads from t 0 at screen x 60 to t 1 at x 50, so x 52.5 is its second
    // (t 0.75) half — picking there reverses that side and the lines cross.
    h.tool.refreshHover(52.5, 47.5);
    const lines = h.host.querySelectorAll('.cloth-edge-stitch-line');
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute('x1')).toBe('60.00');
    expect(lines[0].getAttribute('x2')).toBe('50.00');
  });

  it('never sews on a drag — a press that moves is the camera', () => {
    const h = makeTool();
    click(h.tool, ON_AB, true);
    expect(h.tool.hasPendingEdge()).toBe(false);
    click(h.tool, ON_CD, true);
    expect(h.onSewEdges).not.toHaveBeenCalled();
  });

  it('refuses to start on an edge that is already sewn', () => {
    const h = makeTool([
      { id: 'seam1', a: seamRef('a', 'b'), b: seamRef('c', 'd'), restGapCm: 0.15 },
    ]);
    click(h.tool, ON_AB);
    expect(h.tool.hasPendingEdge()).toBe(false);
  });

  it('does not make the same pair twice', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    click(h.tool, ON_CD);
    expect(h.onSewEdges).toHaveBeenCalledTimes(1);
    // The seam now exists, so the same two edges are refused, in either order.
    h.pattern.seams.push({
      id: 'seam1',
      a: seamRef('a', 'b'),
      b: seamRef('c', 'd'),
      restGapCm: 0.15,
    });
    click(h.tool, ON_CD);
    click(h.tool, ON_AB);
    expect(h.onSewEdges).toHaveBeenCalledTimes(1);
  });

  it('right-click a sewn edge opens a reverse / delete popover', () => {
    const h = makeTool([
      { id: 'seam1', a: seamRef('a', 'b'), b: seamRef('c', 'd'), restGapCm: 0.15 },
    ]);
    h.tool.refreshHover(ON_CD[0], ON_CD[1]);
    h.tool.beginPress(ON_CD[0], ON_CD[1], 2);
    expect(h.tool.endPress(false, 2)).toBe(true);
    // Nothing happens until a menu item is chosen.
    expect(h.onReverseSeam).not.toHaveBeenCalled();
    expect(h.onDeleteSeam).not.toHaveBeenCalled();
    expect(seamMenuItems()).toEqual(['Reverse seam', 'Delete seam']);
  });

  it('the popover reverses the seam it was opened on', () => {
    const h = makeTool([
      { id: 'seam1', a: seamRef('a', 'b'), b: seamRef('c', 'd'), restGapCm: 0.15 },
    ]);
    h.tool.refreshHover(ON_CD[0], ON_CD[1]);
    h.tool.beginPress(ON_CD[0], ON_CD[1], 2);
    h.tool.endPress(false, 2);
    chooseSeamMenu('Reverse seam');
    expect(h.onReverseSeam).toHaveBeenCalledWith('seam1');
    expect(seamMenuItems()).toBeNull();
  });

  it('the popover deletes the seam it was opened on', () => {
    const h = makeTool([
      { id: 'seam1', a: seamRef('a', 'b'), b: seamRef('c', 'd'), restGapCm: 0.15 },
    ]);
    h.tool.refreshHover(ON_CD[0], ON_CD[1]);
    h.tool.beginPress(ON_CD[0], ON_CD[1], 2);
    h.tool.endPress(false, 2);
    chooseSeamMenu('Delete seam');
    expect(h.onDeleteSeam).toHaveBeenCalledWith('seam1');
    expect(seamMenuItems()).toBeNull();
  });

  it('right-click on an unsewn edge is left for the view to handle', () => {
    const h = makeTool();
    h.tool.refreshHover(ON_CD[0], ON_CD[1]);
    h.tool.beginPress(ON_CD[0], ON_CD[1], 2);
    // Not consumed, so the viewport can show its own (piece) popover instead.
    expect(h.tool.endPress(false, 2)).toBe(false);
    expect(seamMenuItems()).toBeNull();
  });

  it('right-click flips the pending pick when nothing is sewn there yet', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    // In this mesh a→b is tagged running right to left, so it is read from x = 0.2.
    expect(h.sourceStart()).toBe('60.00,50.00');
    h.tool.beginPress(ON_AB[0], ON_AB[1], 2);
    h.tool.endPress(false, 2);
    expect(h.onReverseSeam).not.toHaveBeenCalled();
    expect(h.tool.hasPendingEdge()).toBe(true);
    // The same edge, now read from its other end.
    expect(h.sourceStart()).toBe('50.00,50.00');
    expect(h.source()).toBe('50.00,50.00 60.00,50.00');
  });

  it('a click on bare fabric means never mind, not deselect', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    expect(click(h.tool, [5, 5])).toBe(true);
    expect(h.tool.hasPendingEdge()).toBe(false);

    // With nothing pending there is nothing for the tool to take.
    expect(click(h.tool, [5, 5])).toBe(false);
  });

  it('forgets a half-made seam when the cloth is rebuilt', () => {
    const h = makeTool();
    click(h.tool, ON_AB);
    h.tool.rebuild(mesh);
    expect(h.tool.hasPendingEdge()).toBe(false);
    expect(h.source()).toBeNull();
  });
});

/**
 * One edge carrying two seams, the way a many-to-many sew leaves it: side by
 * side, told apart only by where along the edge they sit. a→b is tagged from
 * x = 0.2 (t 0) to x = 0 (t 1), so on screen it runs 60 → 50.
 */
describe('cloth sew tool on an edge with several seams', () => {
  const half = (t0: number, t1: number): SeamEdgeRef => ({
    pieceId: 'p1',
    fromPointId: 'a',
    toPointId: 'b',
    t0,
    t1,
  });

  const makeSplit = () => {
    const h = makeTool([
      { id: 'first', a: half(0, 0.5), b: seamRef('c', 'd'), restGapCm: 0.15 },
      { id: 'second', a: half(0.5, 1), b: seamRef('c', 'd'), restGapCm: 0.15 },
    ]);
    return h;
  };

  it('targets the seam the pointer is actually on', () => {
    // t 0.25 and t 0.75 of a→b: 57.5 is inside the [0, 0.5] seam, 52.5 inside
    // the [0.5, 1] one. By edge alone these are the same click.
    const inFirst = 57.5;
    const inSecond = 52.5;

    const first = makeSplit();
    first.tool.refreshHover(inFirst, 50);
    first.tool.beginPress(inFirst, 50, 2);
    first.tool.endPress(false, 2);
    chooseSeamMenu('Delete seam');
    expect(first.onDeleteSeam).toHaveBeenCalledWith('first');

    const second = makeSplit();
    second.tool.refreshHover(inSecond, 50);
    second.tool.beginPress(inSecond, 50, 2);
    second.tool.endPress(false, 2);
    chooseSeamMenu('Reverse seam');
    expect(second.onReverseSeam).toHaveBeenCalledWith('second');
  });

  it('still allows sewing the free part of a half-sewn edge', () => {
    const inFirst = 57.5; // inside the seam that already exists
    const inSecond = 52.5; // the half that is still free

    const h = makeTool([{ id: 'first', a: half(0, 0.5), b: seamRef('c', 'd'), restGapCm: 0.15 }]);
    click(h.tool, [inSecond, 50]);
    expect(h.tool.hasPendingEdge()).toBe(true);

    const sewn = makeTool([
      { id: 'first', a: half(0, 0.5), b: seamRef('c', 'd'), restGapCm: 0.15 },
    ]);
    click(sewn.tool, [inFirst, 50]);
    expect(sewn.tool.hasPendingEdge()).toBe(false);
  });
});
