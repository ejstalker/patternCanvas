import { describe, expect, it } from 'vitest';
import type { BlockInstance, PatternPiece, Vec2 } from '../../project/types';
import {
  MEASUREMENT_FIELDS,
  newMeasurementSet,
  type MeasurementSet,
} from '../../project/measurements';
import { bindingValueCm, defaultBindings, resolveBlockValues } from './resolve';
import { BODICE_BACK_BLOCK, BODICE_FRONT_BLOCK } from './bodice';
import { drivenPointIds } from './driven';
import { generateBlockPieces } from './generate';
import { BLOCK_DEFINITIONS, getBlockDefinition } from './registry';
import type { BlockDefinition } from './spec';

const MEASUREMENT_IDS = new Set(MEASUREMENT_FIELDS.map((field) => field.id));

function instance(definition: BlockDefinition, bindings: Record<string, never> = {}): BlockInstance {
  return {
    id: 'blk1',
    definitionId: definition.id,
    personId: null,
    personName: '',
    origin: { x: 0, y: 0 },
    bindings,
    pieces: [],
  };
}

function person(values: Record<string, number>, unit: 'cm' | 'in' = 'cm'): MeasurementSet {
  const set = newMeasurementSet('Alex', unit);
  set.values = values;
  return set;
}

/** The single piece a bodice block drafts. */
function piece(definition: BlockDefinition, overrides: Record<string, number> = {}, origin: Vec2 = { x: 0, y: 0 }): PatternPiece {
  const base = resolveBlockValues(definition, instance(definition), null);
  const values = { ...base, ...overrides };
  return generateBlockPieces(
    definition,
    {
      ...instance(definition),
      origin,
      bindings: Object.fromEntries(
        Object.entries(values).map(([id, cm]) => [id, { mode: 'value' as const, cm }])
      ),
    },
    null
  )[0]!.piece;
}

function point(p: PatternPiece, key: string) {
  const found = p.points.find((candidate) => candidate.id.endsWith(`:${key}`));
  expect(found, `no point ${key}`).toBeDefined();
  return found!;
}

const BODICES = [
  { name: 'front', definition: BODICE_FRONT_BLOCK, role: 'bodiceFront' },
  { name: 'back', definition: BODICE_BACK_BLOCK, role: 'bodiceBack' },
] as const;

/**
 * Point keys a variable moves, deduped — optionally for one role only.
 *
 * Each half is drafted with its mirror, and both answer to the same point keys,
 * so the raw id list names every point twice. The role filter is for the
 * questions that are about one half: the mirror also *slides* when the block
 * changes width, because that is what keeping clear of the original costs.
 */
function drivenKeys(definition: BlockDefinition, varId: string, role?: string): string[] {
  const ids = [...(drivenPointIds(definition, instance(definition), null, varId) ?? [])];
  const keys = ids
    .filter((id) => (role ? id.split(':')[1] === role : true))
    .map((id) => id.split(':').pop()!);
  return [...new Set(keys)].sort();
}

/** The ease a variable adds on top of its measurement when suggested. */
function defaultEase(definition: BlockDefinition, id: string): number {
  return definition.variables.find((v) => v.id === id)!.suggested!.offsetCm;
}

describe('bodice blocks', () => {
  it('are both in the library, under the bodice category', () => {
    expect(getBlockDefinition('bodiceFront')).toBe(BODICE_FRONT_BLOCK);
    expect(getBlockDefinition('bodiceBack')).toBe(BODICE_BACK_BLOCK);
    expect(BODICE_FRONT_BLOCK.category).toBe('bodice');
    expect(BODICE_BACK_BLOCK.category).toBe('bodice');
  });

  it('expose the three neckline controls', () => {
    for (const { definition } of BODICES) {
      const neck = definition.variables.filter((v) => v.group === 'Neckline').map((v) => v.id);
      expect(neck).toEqual(['neckWidth', 'neckDepth', 'neckCurve']);
      const curve = definition.variables.find((v) => v.id === 'neckCurve')!;
      expect(curve.kind).toBe('factor');
      expect(curve.minCm).toBe(0);
      expect(curve.maxCm).toBe(1);
    }
  });

  it('draft a closed outline and its mirrored half', () => {
    for (const { definition, role } of BODICES) {
      const generated = generateBlockPieces(definition, instance(definition), null);
      expect(generated.map((g) => g.role)).toEqual([role, `${role}Mirror`]);
      for (const { piece: drawn } of generated) {
        expect(drawn.closed).toBe(true);
        expect(drawn.points.length).toBe(10);
        expect(drawn.grainline).toBeDefined();
      }
    }
  });

  it('name every point the same way on both sides', () => {
    const keys = (definition: BlockDefinition) => piece(definition).points.map((p) => p.id.split(':').pop());
    expect(keys(BODICE_FRONT_BLOCK)).toEqual(keys(BODICE_BACK_BLOCK));
  });

  it('only suggests measurements the library actually has', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      for (const variable of definition.variables) {
        if (!variable.suggested) continue;
        expect(MEASUREMENT_IDS.has(variable.suggested.fieldId)).toBe(true);
      }
    }
  });

  it('suggests the head and armhole slots the book uses', () => {
    const front = Object.fromEntries(
      BODICE_FRONT_BLOCK.variables
        .filter((v) => v.suggested)
        .map((v) => [v.id, v.suggested!.fieldId])
    );
    expect(front).toMatchObject({
      neckWidth: 'backNeck',
      length: 'napeToWaist',
      width: 'bust',
      sideLength: 'sideLength',
      waistWidth: 'waist',
      shoulderLength: 'shoulderLength',
      shoulderSlope: 'shoulderSlope',
      dartPlacement: 'dartPlacement',
    });
    const back = Object.fromEntries(
      BODICE_BACK_BLOCK.variables
        .filter((v) => v.suggested)
        .map((v) => [v.id, v.suggested!.fieldId])
    );
    // Both sides draw their height from the same field, because the side seams
    // have to meet. Front and back take the same width off the same measurement
    // for the same reason.
    expect(back.length).toBe('napeToWaist');
    expect(back.length).toBe(front.length);
    expect(back.width).toBe('bust');
    expect(back.width).toBe(front.width);
  });

  it('size to a real body through the suggested bindings', () => {
    // A 96 cm bust, 74 cm waist, 40 cm nape-to-waist.
    const set = person({
      bust: 96,
      waist: 74,
      centerFrontLength: 33,
      napeToWaist: 40,
      sideLength: 18,
      shoulderLength: 12.5,
      shoulderSlope: 5.5,
      backNeck: 7,
      dartPlacement: 9,
    });
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      const bindings = defaultBindings(definition, set);
      const values = resolveBlockValues(definition, { ...instance(definition), bindings }, set);
      // Every suggested binding must have taken, not fallen back to a default.
      for (const variable of definition.variables) {
        if (!variable.suggested) continue;
        const binding = bindings[variable.id]!;
        expect(binding.mode).toBe('measurement');
        // The binding divides before it offsets — a quarter bust is not a bust.
        expect(bindingValueCm(binding, set)).toBeCloseTo(
          set.values[variable.suggested.fieldId]! / variable.suggested.divisor +
            variable.suggested.offsetCm,
          6
        );
      }
      expect(values.length).toBeGreaterThan(0);
      // And it drew a bodice quarter-bust wide rather than the placeholder.
      expect(values.width).toBeCloseTo(96 / 4 + defaultEase(definition, 'width'), 6);
    }
  });
});

describe('bodice neckline', () => {
  it('is a straight chord when the curve factor is zero', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition, { neckCurve: 0 });
      const shoulder = point(drawn, 'neckShoulder');
      const centre = point(drawn, 'neckCentre');
      // Handles collapse onto their own endpoints, so the cubic degenerates to
      // the line between them.
      expect(shoulder.handleOut).toEqual(shoulder.anchor);
      expect(centre.handleIn).toEqual(centre.anchor);
    }
  });

  it('meets both axes square at full curve, without overshooting either', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition, { neckCurve: 1, neckWidth: 8, neckDepth: 6 });
      const shoulder = point(drawn, 'neckShoulder');
      const centre = point(drawn, 'neckCentre');
      // The tangent at the neck point runs parallel to the centre line, and the
      // tangent at the neck point on the centre line runs parallel to the
      // shoulder line. That is a quarter round — the deepest a neck is ever cut.
      expect(shoulder.handleOut!.x).toBeCloseTo(shoulder.anchor.x, 6);
      expect(centre.handleIn!.y).toBeCloseTo(centre.anchor.y, 6);
      // Reaches along each axis, never past it: 0.5523 is the cubic circle
      // constant, and more than that bulges outside the ellipse it approximates.
      const reach = 0.5523;
      expect(shoulder.handleOut!.y).toBeCloseTo(
        shoulder.anchor.y + (centre.anchor.y - shoulder.anchor.y) * reach,
        4
      );
      expect(centre.handleIn!.x).toBeCloseTo(
        centre.anchor.x + (shoulder.anchor.x - centre.anchor.x) * reach,
        4
      );
      expect(shoulder.handleOut!.y).toBeGreaterThan(shoulder.anchor.y);
      expect(centre.handleIn!.x).toBeLessThan(shoulder.anchor.x);
    }
  });

  it('cuts the neck down into the top line rather than growing the block', () => {
    for (const { definition } of BODICES) {
      const shallow = piece(definition, { length: 40, neckDepth: 2 });
      const deep = piece(definition, { length: 40, neckDepth: 9 });
      // The top line is the datum the centre length is measured from, so it holds
      // still: a deeper neck cuts further *down* the centre line and the block
      // stays exactly as tall as it was asked to be.
      expect(point(deep, 'neckShoulder').anchor).toEqual(point(shallow, 'neckShoulder').anchor);
      expect(point(deep, 'neckCentre').anchor.y - point(shallow, 'neckCentre').anchor.y).toBeCloseTo(7, 6);
      // Which means the whole block is `length` tall, top line to hem.
      expect(
        point(shallow, 'centreWaist').anchor.y - point(shallow, 'neckShoulder').anchor.y
      ).toBeCloseTo(40, 6);
      for (const key of ['centreWaist', 'waistSide', 'dartApex', 'underarm', 'across', 'shoulderTip']) {
        expect(point(deep, key).anchor, key).toEqual(point(shallow, key).anchor);
      }
    }
  });

  it('moves the shoulder-neck point and only that when the width changes', () => {
    for (const { definition } of BODICES) {
      const narrow = piece(definition, { neckWidth: 5 });
      const wide = piece(definition, { neckWidth: 10 });
      expect(point(wide, 'neckShoulder').anchor.x - point(narrow, 'neckShoulder').anchor.x).toBeCloseTo(5, 6);
      expect(point(wide, 'neckCentre').anchor).toEqual(point(narrow, 'neckCentre').anchor);
      // Moving the neck point along the shoulder line carries the shoulder tip
      // with it — the shoulder length is measured from there.
      expect(point(wide, 'shoulderTip').anchor.x - point(narrow, 'shoulderTip').anchor.x).toBeCloseTo(5, 6);
    }
  });

  it('scoops the neckline away from its chord as the curve factor rises', () => {
    for (const { definition } of BODICES) {
      const at = (k: number) => {
        const drawn = piece(definition, { neckCurve: k, neckWidth: 10, neckDepth: 10 });
        const shoulder = point(drawn, 'neckShoulder');
        const centre = point(drawn, 'neckCentre');
        // Sample the cubic at its midpoint and measure how far it sits from the
        // straight chord, on the chest side. The corner the neck is cut out of
        // lies on the *other* side, so a neckline whose handles point at the
        // corner instead of along the curve comes out negative here — which is
        // the bug this pins down.
        const mid: Vec2 = {
          x: (shoulder.anchor.x + 3 * shoulder.handleOut!.x + 3 * centre.handleIn!.x + centre.anchor.x) / 8,
          y: (shoulder.anchor.y + 3 * shoulder.handleOut!.y + 3 * centre.handleIn!.y + centre.anchor.y) / 8,
        };
        const ax = shoulder.anchor.x - centre.anchor.x;
        const ay = shoulder.anchor.y - centre.anchor.y;
        const mx = mid.x - centre.anchor.x;
        const my = mid.y - centre.anchor.y;
        return (my * ax - mx * ay) / Math.hypot(ax, ay);
      };
      expect(at(0)).toBeCloseTo(0, 6);
      // Positive is scooped, and more of it as the factor climbs to a full
      // quarter round. Nothing here should ever bend the other way.
      expect(at(0.5)).toBeGreaterThan(0);
      expect(at(0.8)).toBeGreaterThan(at(0.5));
      expect(at(1)).toBeGreaterThan(at(0.8));
    }
  });

  it('gives the back a shallower neck than the front out of the box', () => {
    const depth = (definition: BlockDefinition) =>
      point(piece(definition), 'neckCentre').anchor.y - point(piece(definition), 'neckShoulder').anchor.y;
    expect(depth(BODICE_BACK_BLOCK)).toBeLessThan(depth(BODICE_FRONT_BLOCK));
  });

  it('agrees across the shoulder seam, which is why they share a builder', () => {
    const seam = (definition: BlockDefinition) => {
      const drawn = piece(definition);
      const neck = point(drawn, 'neckShoulder').anchor;
      const tip = point(drawn, 'shoulderTip').anchor;
      return Math.hypot(tip.x - neck.x, tip.y - neck.y);
    };
    // Same shoulder length, same slope, so the two seams come out the same
    // length to the millimetre.
    expect(seam(BODICE_FRONT_BLOCK)).toBeCloseTo(seam(BODICE_BACK_BLOCK), 6);
  });
});

describe('bodice body', () => {
  it('anchors the underarm to the waist on both sides', () => {
    // The library's armscye depth runs nape → underarm, which is a different
    // reference point on each side. Anchoring the block at the waist and placing
    // the underarm from the *side length* sidesteps that entirely: both pieces
    // land at the same underarm, and no neckline control can move it.
    for (const { definition } of BODICES) {
      const drawn = piece(definition, { sideLength: 18, neckDepth: 7 });
      expect(point(drawn, 'underarm').anchor.y).toBeCloseTo(-18, 6);
      expect(point(drawn, 'centreWaist').anchor.y).toBeCloseTo(0, 6);
    }
    const a = piece(BODICE_FRONT_BLOCK, { sideLength: 18, neckDepth: 3 });
    const b = piece(BODICE_FRONT_BLOCK, { sideLength: 18, neckDepth: 12 });
    expect(point(a, 'underarm').anchor).toEqual(point(b, 'underarm').anchor);
  });

  it('aligns front and back at the waist and the underarm', () => {
    // The whole reason the waist is the anchor: draft both to one person and the
    // two seams that must match come out at the same place.
    const set = person({
      bust: 96,
      waist: 74,
      centerFrontLength: 33,
      napeToWaist: 40,
      sideLength: 18,
    });
    const draft = (definition: BlockDefinition) => {
      const bindings = defaultBindings(definition, set);
      return generateBlockPieces(definition, { ...instance(definition), bindings }, set)[0]!.piece;
    };
    const front = draft(BODICE_FRONT_BLOCK);
    const back = draft(BODICE_BACK_BLOCK);
    const at = (p: PatternPiece, key: string) => p.points.find((x) => x.id.endsWith(`:${key}`))!;
    expect(at(front, 'centreWaist').anchor.y).toBeCloseTo(at(back, 'centreWaist').anchor.y, 6);
    expect(at(front, 'underarm').anchor.y).toBeCloseTo(at(back, 'underarm').anchor.y, 6);
    // Same width off the same bust, so the side seam is a single line when the
    // two pieces are laid against each other.
    expect(at(front, 'underarm').anchor.x).toBeCloseTo(at(back, 'underarm').anchor.x, 6);
    // The shoulder lines agree exactly, because both sides take their height from
    // the same nape-to-waist field. A centre-front length is the hollow to the
    // waist — the front's height less its neck depth — so binding the height to
    // it would leave the two pieces a neckline apart at the shoulder.
    const frontShoulder = at(front, 'neckShoulder').anchor.y;
    const backShoulder = at(back, 'neckShoulder').anchor.y;
    expect(frontShoulder).toBeCloseTo(backShoulder, 6);
    expect(frontShoulder).toBeCloseTo(-40, 6);
    // And the hollow is cut down into that height, so the front's centre line is
    // shorter than the block by exactly the neck depth.
    expect(at(front, 'neckCentre').anchor.y - frontShoulder).toBeCloseTo(7, 6);
  });

  it('drafts the whole block width from the bust', () => {
    // The reference's rectangle: upper bust ÷ 4 plus underarm ease. The person is
    // measured whole and the divisor lives in the binding, where a quarter can be
    // undone if the reading turns out to be a full circumference.
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      const width = definition.variables.find((v) => v.id === 'width')!;
      expect(width.suggested!.fieldId).toBe('bust');
      expect(width.suggested!.divisor).toBe(4);
      expect(width.suggested!.offsetCm).toBeGreaterThan(0);
    }
    // And it really is the block's width: widening it moves the side seam and
    // the scye with it, and leaves the waist dart alone.
    const narrow = piece(BODICE_FRONT_BLOCK, { width: 20 });
    const wide = piece(BODICE_FRONT_BLOCK, { width: 28 });
    expect(point(wide, 'underarm').anchor.x - point(narrow, 'underarm').anchor.x).toBeCloseTo(8, 6);
    expect(point(wide, 'waistSide').anchor).toEqual(point(narrow, 'waistSide').anchor);
  });

  it('suggests arc measurements whole, since an arc is already a quarter', () => {
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      for (const id of ['length', 'neckWidth', 'shoulderLength']) {
        const variable = definition.variables.find((v) => v.id === id)!;
        expect(variable.suggested!.divisor, id).toBe(1);
      }
      // The two widths are the exception: a block is a quarter of a torso, so
      // these divide their measurement before easing it.
      for (const id of ['width', 'waistWidth']) {
        expect(definition.variables.find((v) => v.id === id)!.suggested!.divisor, id).toBe(4);
      }
      // And the side length goes the other way. The avatar derives it from the
      // underarm landmark on the under-bust loop, which sits well above the
      // armpit, so what it reports is a half length.
      expect(definition.variables.find((v) => v.id === 'sideLength')!.suggested!.divisor).toBe(
        0.5
      );
    }
  });

  it('hangs the shoulder line above the neck point', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition);
      // y grows downward, so the shoulder line must sit above the neck point.
      expect(point(drawn, 'neckShoulder').anchor.y).toBeLessThan(
        point(drawn, 'neckCentre').anchor.y
      );
    }
  });

  it('puts the underarm below the shoulder tip and the waist below that', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition);
      const tip = point(drawn, 'shoulderTip').anchor.y;
      const underarm = point(drawn, 'underarm').anchor.y;
      const waist = point(drawn, 'centreWaist').anchor.y;
      expect(underarm).toBeGreaterThan(tip);
      expect(waist).toBeGreaterThan(underarm);
    }
  });

  it('takes the dart back out of a waist that already has the dart in it', () => {
    // The flat hem runs from the centre out to the side seam with the dart's
    // fabric inside it, so what the dart closes up is the measured waist. Bind
    // the hem to the ease alone and the bodice drafts a dart width too tight,
    // which is invisible on screen and wrong on the body.
    const set = person({
      bust: 96,
      waist: 74,
      centerFrontLength: 33,
      napeToWaist: 40,
      sideLength: 18,
    });
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      const bindings = defaultBindings(definition, set);
      const drawn = generateBlockPieces(
        definition,
        { ...instance(definition), bindings },
        set
      )[0]!.piece;
      const hem = point(drawn, 'waistSide').anchor.x;
      const intake = point(drawn, 'dartB').anchor.x - point(drawn, 'dartA').anchor.x;
      const dart = definition.variables.find((v) => v.id === 'dartIntake')!.defaultValueCm;
      const offset = definition.variables.find((v) => v.id === 'waistWidth')!.suggested!.offsetCm;
      expect(intake).toBeCloseTo(dart, 6);
      // Hem less the dart is the measurement plus the ease, which is what the
      // sewing line actually measures.
      expect(offset).toBeGreaterThan(dart);
      expect(hem - intake).toBeCloseTo(74 / 4 + offset - dart, 6);
    }
  });

  it('notches the waist with one dart, apex upward', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition, { dartPlacement: 9, dartIntake: 3, dartLength: 11 });
      const a = point(drawn, 'dartA').anchor;
      const apex = point(drawn, 'dartApex').anchor;
      const b = point(drawn, 'dartB').anchor;
      expect(a.y).toBeCloseTo(b.y, 6);
      expect(apex.y).toBeCloseTo(a.y - 11, 6);
      expect(apex.x).toBeCloseTo((a.x + b.x) / 2, 6);
      expect(b.x - a.x).toBeCloseTo(3, 6);
    }
  });

  it('slopes the side seam outward from waist to underarm', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition);
      expect(point(drawn, 'underarm').anchor.x).toBeGreaterThan(point(drawn, 'waistSide').anchor.x);
    }
  });

  it('curves the scye through the across mark, inside the underarm', () => {
    for (const { definition } of BODICES) {
      const drawn = piece(definition);
      const across = point(drawn, 'across').anchor;
      const underarm = point(drawn, 'underarm').anchor;
      const tip = point(drawn, 'shoulderTip').anchor;
      expect(across.y).toBeGreaterThan(tip.y);
      expect(across.y).toBeLessThan(underarm.y);
      expect(across.x).toBeLessThan(underarm.x);
      // Real handles on the scye, so it is a French curve and not three chords.
      expect(point(drawn, 'underarm').handleOut).toBeTruthy();
      expect(point(drawn, 'across').handleIn).toBeTruthy();
      expect(point(drawn, 'across').handleOut).toBeTruthy();
      expect(point(drawn, 'shoulderTip').handleIn).toBeTruthy();
    }
  });

  it('keeps the across mark on the scye at every width', () => {
    for (const { definition } of BODICES) {
      // The mark is a share of the block's own width rather than a measurement,
      // so no width can push the hollow outside the armhole it carves.
      for (const width of [16, 24.5, 34, 42]) {
        const drawn = piece(definition, { width });
        const across = point(drawn, 'across').anchor;
        const underarm = point(drawn, 'underarm').anchor;
        const tip = point(drawn, 'shoulderTip').anchor;
        // It is the hollow: inboard of both ends, between them in height.
        expect(across.x, `width ${width}`).toBeLessThan(Math.min(underarm.x, tip.x));
        expect(across.x, `width ${width}`).toBeGreaterThan(3);
        expect(across.y).toBeGreaterThan(tip.y);
        expect(across.y).toBeLessThan(underarm.y);
      }
    }
  });

  it('keeps the neckline shape controls out of the scye', () => {
    for (const { definition } of BODICES) {
      const a = piece(definition, { neckDepth: 2, neckCurve: 0.1 });
      const b = piece(definition, { neckDepth: 12, neckCurve: 0.9 });
      // Nothing in the scye moves for a neckline edit — not one anchor, not one
      // handle. The tip hangs from the top line by the shoulder slope, and the
      // top line is fixed by the block's height, so the neckline cannot reach it
      // however it is set.
      for (const key of ['underarm', 'across', 'shoulderTip']) {
        expect(point(b, key).anchor, key).toEqual(point(a, key).anchor);
      }
      for (const [key, side] of [
        ['underarm', 'handleOut'],
        ['across', 'handleIn'],
        ['across', 'handleOut'],
        ['shoulderTip', 'handleIn'],
      ] as const) {
        expect(point(b, key)[side], `${key}.${side}`).toEqual(point(a, key)[side]);
      }
      // The neckline itself is the only thing that has moved.
      expect(point(b, 'neckCentre').anchor).not.toEqual(point(a, 'neckCentre').anchor);
    }
  });

  it('does not let the neck width move the underarm', () => {
    for (const { definition } of BODICES) {
      const narrow = piece(definition, { neckWidth: 5 });
      const wide = piece(definition, { neckWidth: 11 });
      // The underarm and the side seam are body measurements and must not follow
      // a neckline reading.
      expect(point(wide, 'underarm').anchor).toEqual(point(narrow, 'underarm').anchor);
      expect(point(wide, 'waistSide').anchor).toEqual(point(narrow, 'waistSide').anchor);
      // The shoulder tip *is* the top of the scye, so it moves, and the hollow
      // bites in from whichever end is nearest the centre.
      const across = point(wide, 'across').anchor;
      expect(across.y).toBeCloseTo(point(narrow, 'across').anchor.y, 6);
      expect(across.x).toBeLessThan(point(wide, 'shoulderTip').anchor.x);
      expect(across.x).toBeLessThan(point(wide, 'underarm').anchor.x);
    }
  });

  it('follows the origin it is given', () => {
    for (const { definition } of BODICES) {
      const here = piece(definition);
      const there = piece(definition, {}, { x: 25, y: 12 });
      for (let i = 0; i < here.points.length; i++) {
        expect(there.points[i]!.anchor.x - here.points[i]!.anchor.x).toBeCloseTo(25, 6);
        expect(there.points[i]!.anchor.y - here.points[i]!.anchor.y).toBeCloseTo(12, 6);
      }
    }
  });

  it('regenerates to identical geometry from identical values', () => {
    for (const { definition } of BODICES) {
      const a = generateBlockPieces(definition, instance(definition), null);
      const b = generateBlockPieces(definition, instance(definition), null);
      expect(a).toEqual(b);
    }
  });

  it('resolves finite geometry from defaults alone, with no library', () => {
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      for (const p of generateBlockPieces(definition, instance(definition), null)) {
        for (const pt of p.piece.points) {
          expect(Number.isFinite(pt.anchor.x)).toBe(true);
          expect(Number.isFinite(pt.anchor.y)).toBe(true);
          if (pt.handleIn) expect(Number.isFinite(pt.handleIn.x)).toBe(true);
          if (pt.handleOut) expect(Number.isFinite(pt.handleOut.y)).toBe(true);
        }
      }
    }
  });

  it('does the right thing when a measurement is missing', () => {
    const set = person({}); // nobody has been measured
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      const bindings = defaultBindings(definition, set);
      const values = resolveBlockValues(definition, instance(definition), set);
      const drawn = generateBlockPieces(definition, { ...instance(definition), bindings }, set);
      expect(drawn).toHaveLength(2);
      for (const variable of definition.variables) {
        expect(Number.isFinite(values[variable.id]!)).toBe(true);
      }
    }
  });
});

describe('bodice inspector integration', () => {
  it('lights up the neckline when a neckline control is hovered', () => {
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      for (const varId of ['neckWidth', 'neckDepth', 'neckCurve']) {
        const driven = drivenPointIds(definition, instance(definition), null, varId);
        expect(driven, varId).not.toBeNull();
        expect(drivenKeys(definition, varId), varId).toContain('neckShoulder');
      }
      // The curve factor moves no anchor at all — it only bends the cubic — so
      // this one only works because handles count as movement.
      expect(drivenKeys(definition, 'neckCurve')).toEqual(['neckCentre', 'neckShoulder']);
    }
  });

  it('lights up the neckline when the depth changes', () => {
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      // The depth cuts the hollow further down the centre line, so that anchor
      // moves and the handle hanging off the neck point stretches with it.
      // Nothing else does — the top line, and through it the shoulder tip and
      // the whole armhole, is pinned by the block's height.
      expect(drivenKeys(definition, 'neckDepth')).toEqual(['neckCentre', 'neckShoulder']);
      const shallow = piece(definition, { neckDepth: 2 });
      const deep = piece(definition, { neckDepth: 9 });
      expect(point(deep, 'neckShoulder').anchor).toEqual(point(shallow, 'neckShoulder').anchor);
      expect(point(deep, 'shoulderTip').anchor).toEqual(point(shallow, 'shoulderTip').anchor);
      expect(point(deep, 'underarm').anchor).toEqual(point(shallow, 'underarm').anchor);
      expect(point(deep, 'across').anchor).toEqual(point(shallow, 'across').anchor);
    }
  });

  it('leaves the neckline alone when a body control is hovered', () => {
    for (const definition of [BODICE_FRONT_BLOCK, BODICE_BACK_BLOCK]) {
      const keys = drivenKeys(definition, 'dartIntake');
      expect(keys).not.toContain('neckCentre');
      expect(keys).not.toContain('neckShoulder');
      expect(keys).toContain('dartApex');
    }
  });

  it('drives the scye from the block width', () => {
    for (const { definition, role } of BODICES) {
      const keys = drivenKeys(definition, 'width', role);
      expect(keys).toContain('underarm');
      expect(keys).toContain('across');
      expect(keys).not.toContain('centreWaist');
    }
  });
});
