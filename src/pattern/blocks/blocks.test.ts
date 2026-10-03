import { describe, expect, it } from 'vitest';
import type { BlockInstance, BlockVariableBinding, PatternPiece } from '../../project/types';
import {
  MEASUREMENT_FIELDS,
  newMeasurementSet,
  type MeasurementSet,
} from '../../project/measurements';
import { bindingValueCm, clampToDeclared, defaultBindings, resolveBlockValues, sourceValueCm } from './resolve';
import {
  createBlockInstance,
  generateBlockPieces,
  nextBlockOrigin,
  spliceBlockPieces,
} from './generate';
import { drivenPointIds } from './driven';
import { materializePiece, blockPieceId, blockPointId } from './spec';
import { SKIRT_BLOCK, dartLayout } from './skirt';
import { BLOCK_DEFINITIONS, blockDefinitionsByCategory, getBlockDefinition } from './registry';

const MEASUREMENT_IDS = new Set(MEASUREMENT_FIELDS.map((field) => field.id));

function person(values: Record<string, number>, unit: 'cm' | 'in' = 'cm'): MeasurementSet {
  const set = newMeasurementSet('Alex', unit);
  set.values = values;
  return set;
}

function instance(bindings: Record<string, BlockVariableBinding> = {}): BlockInstance {
  return {
    id: 'blk1',
    definitionId: 'skirt',
    personId: null,
    personName: '',
    origin: { x: 0, y: 0 },
    bindings,
    pieces: [],
  };
}

describe('block variable resolution', () => {
  it('divides and offsets a measurement', () => {
    const set = person({ hip: 96 });
    expect(sourceValueCm({ fieldId: 'hip', divisor: 4, offsetCm: 1.27 }, set)).toBeCloseTo(25.27, 6);
    expect(sourceValueCm({ fieldId: 'hip', divisor: 2, offsetCm: 0 }, set)).toBeCloseTo(48, 6);
    expect(sourceValueCm({ fieldId: 'hip', divisor: 1, offsetCm: 0 }, set)).toBeCloseTo(96, 6);
  });

  it('converts a person measured in inches to canonical cm', () => {
    const set = person({ hip: 38 }, 'in');
    // 38 in ÷ 4 + 0.5 in = 10 in = 25.4 cm
    expect(sourceValueCm({ fieldId: 'hip', divisor: 4, offsetCm: 1.27 }, set)).toBeCloseTo(25.4, 6);
  });

  it('reports null for a measurement this person has not taken', () => {
    expect(sourceValueCm({ fieldId: 'hip', divisor: 4, offsetCm: 0 }, person({}))).toBeNull();
    expect(sourceValueCm({ fieldId: 'hip', divisor: 4, offsetCm: 0 }, null)).toBeNull();
    // A measurement of zero is "not taken", not a real value.
    expect(sourceValueCm({ fieldId: 'hip', divisor: 4, offsetCm: 0 }, person({ hip: 0 }))).toBeNull();
  });

  it('falls back to the snapshot when the library has gone', () => {
    const binding: BlockVariableBinding = {
      mode: 'measurement',
      fieldId: 'hip',
      divisor: 4,
      offsetCm: 1.27,
      fallbackCm: 25.27,
    };
    expect(bindingValueCm(binding, null)).toBeCloseTo(25.27, 6);
    // And prefers the live value when the person does have one.
    expect(bindingValueCm(binding, person({ hip: 100 }))).toBeCloseTo(26.27, 6);
  });

  it('uses a literal binding regardless of the library', () => {
    expect(bindingValueCm({ mode: 'value', cm: 42 }, person({ hip: 96 }))).toBe(42);
    expect(bindingValueCm({ mode: 'value', cm: 42 }, null)).toBe(42);
  });

  it('resolves every declared variable, defaulting what is unbound', () => {
    const values = resolveBlockValues(SKIRT_BLOCK, instance(), null);
    for (const variable of SKIRT_BLOCK.variables) {
      expect(Number.isFinite(values[variable.id])).toBe(true);
    }
    expect(values.skirtLength).toBe(60);
  });

  it('binds suggested measurements on a person who has them', () => {
    const bindings = defaultBindings(SKIRT_BLOCK, person({ hip: 96, waist: 73 }));
    // Hip arc = quarter hip + 1/2"
    expect(bindingValueCm(bindings.hipArcBack!, person({ hip: 96 }))).toBeCloseTo(24 + 1.27, 6);
    expect(bindingValueCm(bindings.waistArcFront!, person({ waist: 73 }))).toBeCloseTo(
      18.25 + 0.635,
      6
    );
    // Skirt length has no suggested measurement, so it stays a literal.
    expect(bindings.skirtLength!.mode).toBe('value');
  });

  it('leaves a suggested binding as a literal when the person has no value', () => {
    const bindings = defaultBindings(SKIRT_BLOCK, person({}));
    expect(bindings.hipArcBack!.mode).toBe('value');
    expect(bindingValueCm(bindings.hipArcBack!, null)).toBe(25);
  });

  it('keeps a snapshot so a block still draws after the library disappears', () => {
    const measured = person({ hip: 96 });
    const bindings = defaultBindings(SKIRT_BLOCK, measured);
    // Bind on the person, then resolve with no library at all.
    expect(bindingValueCm(bindings.hipArcBack!, null)).toBeCloseTo(25.27, 6);
  });
});

describe('dart layout', () => {
  const base = { placement: 9, intake: 5.08, count: 2, space: 3.175, length: 14 };

  it('spreads the intake evenly with the given space between darts', () => {
    const legs = dartLayout(base, 30);
    expect(legs).toHaveLength(2);
    const width = 5.08 / 2;
    expect(legs[0]![0]).toBeCloseTo(9, 6);
    expect(legs[0]![1] - legs[0]![0]).toBeCloseTo(width, 6);
    expect(legs[1]![0] - legs[0]![1]).toBeCloseTo(3.175, 6);
  });

  it('scales darts down rather than letting them overrun the side seam', () => {
    const tight = dartLayout({ ...base, placement: 20 }, 22);
    const last = tight[tight.length - 1]!;
    expect(last[1]).toBeLessThanOrEqual(22 + 1e-6);
    expect(tight[0]![0]).toBeLessThan(tight[1]![0]);
  });

  it('honours a single dart by taking the whole intake', () => {
    const one = dartLayout({ ...base, count: 1 }, 30);
    expect(one).toHaveLength(1);
    expect(one[0]![1] - one[0]![0]).toBeCloseTo(5.08, 6);
  });

  it('never produces a zero-width dart', () => {
    const legs = dartLayout({ ...base, intake: 0 }, 30);
    for (const [a, b] of legs) expect(b - a).toBeGreaterThan(0);
  });
});

describe('skirt block geometry', () => {
  const values = resolveBlockValues(SKIRT_BLOCK, instance(), null);

  it('produces back, front and waistband in that order', () => {
    const pieces = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    expect(pieces.map((p) => p.role)).toEqual(['skirtBack', 'skirtFront', 'waistband']);
  });

  it('gives every piece a closed outline of at least four points', () => {
    for (const piece of SKIRT_BLOCK.build(values, { x: 0, y: 0 })) {
      expect(piece.points.length).toBeGreaterThanOrEqual(4);
      const keys = piece.points.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('walks the waist out to the arc plus the dart intake', () => {
    const [back] = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    const waistSide = back!.points.find((p) => p.key === 'waistSide')!;
    expect(waistSide.anchor.x).toBeCloseTo(values.waistArcBack + values.backDartIntake, 6);
  });

  it('lifts the side-seam waist above the centre waist by the depth difference', () => {
    const [back] = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    const centre = back!.points.find((p) => p.key === 'centreWaist')!;
    const side = back!.points.find((p) => p.key === 'sideWaist')!;
    expect(side.anchor.x).toBeCloseTo(values.hipArcBack, 6);
    expect(centre.anchor.y - side.anchor.y).toBeCloseTo(
      values.sideHipDepth - values.hipDepth,
      6
    );
  });

  it('puts the hem exactly the skirt length below the centre waist', () => {
    const [back] = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    const hem = back!.points.find((p) => p.key === 'centreHem')!;
    expect(hem.anchor.y).toBeCloseTo(values.skirtLength, 6);
  });

  it('notches the waist with one apex per dart', () => {
    const [back] = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    const apexes = back!.points.filter((p) => p.key.includes('apex'));
    expect(apexes).toHaveLength(Math.round(values.backDartCount));
    for (const apex of apexes) {
      expect(apex.anchor.y).toBeCloseTo(values.backDartLength, 6);
    }
  });

  it('lays the front panel clear of the back, and the band below both', () => {
    const [back, front, band] = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    const backMax = Math.max(...back!.points.map((p) => p.anchor.x));
    const frontMin = Math.min(...front!.points.map((p) => p.anchor.x));
    expect(frontMin).toBeGreaterThan(backMax);
    const skirtMinY = Math.min(...band!.points.map((p) => p.anchor.y));
    expect(skirtMinY).toBeGreaterThan(values.skirtLength);
  });

  it('follows the origin it is given', () => {
    const moved = SKIRT_BLOCK.build(values, { x: 100, y: 50 });
    const origin = SKIRT_BLOCK.build(values, { x: 0, y: 0 });
    expect(moved[0]!.points[0]!.anchor.x - origin[0]!.points[0]!.anchor.x).toBeCloseTo(100, 6);
    expect(moved[0]!.points[0]!.anchor.y - origin[0]!.points[0]!.anchor.y).toBeCloseTo(50, 6);
  });

  it('sizes to a real body through the suggested bindings', () => {
    // A 96 cm hip should give two panels of a quarter hip plus ease, side by side.
    const set = person({ hip: 96, waist: 73, hipDepth: 20, sideHipDepth: 21 });
    const measured = resolveBlockValues(SKIRT_BLOCK, instance(defaultBindings(SKIRT_BLOCK, set)), set);
    const [back, front] = SKIRT_BLOCK.build(measured, { x: 0, y: 0 });
    expect(measured.hipArcBack).toBeCloseTo(96 / 4 + 1.27, 6);
    expect(Math.max(...back!.points.map((p) => p.anchor.x))).toBeCloseTo(25.27, 6);
    expect(measured.hipDepth).toBeCloseTo(20, 6);
    expect(front!.points.length).toBeGreaterThan(4);
  });
});

describe('stable identity', () => {
  it('derives ids from the instance and role so regeneration cannot renumber', () => {
    expect(blockPieceId('blk1', 'skirtBack')).toBe('blk1:skirtBack');
    expect(blockPointId('blk1', 'skirtBack', 'centreWaist')).toBe(
      'blk1:skirtBack:centreWaist'
    );
  });

  it('regenerating the same values twice yields identical ids and geometry', () => {
    const values = resolveBlockValues(SKIRT_BLOCK, instance(), null);
    const a = SKIRT_BLOCK.build(values, { x: 0, y: 0 }).map((p) =>
      materializePiece(p, 'blk1', 'piece')
    );
    const b = SKIRT_BLOCK.build(values, { x: 0, y: 0 }).map((p) =>
      materializePiece(p, 'blk1', 'piece')
    );
    expect(a).toEqual(b);
    expect(a[0]!.points[0]!.id).toBe('blk1:skirtBack:centreWaist');
  });

  it('materializes closed pieces with null-safe handles', () => {
    const [spec] = SKIRT_BLOCK.build(resolveBlockValues(SKIRT_BLOCK, instance(), null), {
      x: 0,
      y: 0,
    });
    const piece = materializePiece(spec!, 'blk1', 'Fallback');
    expect(piece.closed).toBe(true);
    expect(piece.name).toBe('Skirt back');
    for (const point of piece.points) {
      expect(point.handlesParallel).toBeTypeOf('boolean');
    }
  });

  it('keeps ids stable when only a variable changes', () => {
    const small = resolveBlockValues(SKIRT_BLOCK, instance(), null);
    const large = { ...small, skirtLength: small.skirtLength + 20 };
    const a = SKIRT_BLOCK.build(small, { x: 0, y: 0 })[0]!;
    const b = SKIRT_BLOCK.build(large, { x: 0, y: 0 })[0]!;
    expect(a.points.map((p) => p.key)).toEqual(b.points.map((p) => p.key));
  });
});

describe('block registry', () => {
  it('exposes the built-in definitions by id', () => {
    expect(getBlockDefinition('skirt')).toBe(SKIRT_BLOCK);
    expect(getBlockDefinition('nope')).toBeNull();
  });

  it('gives every definition unique variable ids and non-empty roles', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      const ids = definition.variables.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(definition.roles.length).toBeGreaterThan(0);
      expect(definition.variables.length).toBeGreaterThan(0);
    }
  });

  it('declares every variable within its own bounds', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      for (const variable of definition.variables) {
        expect(variable.defaultValueCm).toBeGreaterThanOrEqual(variable.minCm);
        expect(variable.defaultValueCm).toBeLessThanOrEqual(variable.maxCm);
        expect(variable.minCm).toBeLessThanOrEqual(variable.maxCm);
      }
    }
  });

  it('builds cleanly from defaults alone, with no measurement library', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      const values = resolveBlockValues(definition, instance(), null);
      const pieces = definition.build(values, { x: 0, y: 0 });
      const roles = pieces.map((p) => p.role);
      for (const role of definition.roles) expect(roles).toContain(role);
      for (const piece of pieces) {
        for (const point of piece.points) {
          expect(Number.isFinite(point.anchor.x)).toBe(true);
          expect(Number.isFinite(point.anchor.y)).toBe(true);
        }
      }
    }
  });

  it('groups definitions for the placement menu', () => {
    const groups = blockDefinitionsByCategory();
    expect(groups.map((g) => g.category)).toEqual(['skirt']);
    expect(groups[0]!.label).toBe('Skirt');
  });
});

describe('driven geometry', () => {
  const driven = (varId: string, block: BlockInstance = instance()) =>
    drivenPointIds(SKIRT_BLOCK, block, null, varId);

  it('names the points a length moves, and nothing else', () => {
    const ids = driven('skirtLength');
    expect(ids).not.toBeNull();
    // Hems drop, waists do not.
    expect(ids!.has('blk1:skirtBack:centreHem')).toBe(true);
    expect(ids!.has('blk1:skirtBack:sideHem')).toBe(true);
    expect(ids!.has('blk1:skirtFront:centreHem')).toBe(true);
    expect(ids!.has('blk1:skirtBack:centreWaist')).toBe(false);
    expect(ids!.has('blk1:skirtBack:sideWaist')).toBe(false);
  });

  it('separates the centre hip depth from the side one', () => {
    const centre = driven('hipDepth')!;
    const side = driven('sideHipDepth')!;
    // The centre hip depth sets the level of the hip notch on the side seam.
    expect(centre.has('blk1:skirtBack:sideHip')).toBe(true);
    // The side hip depth only raises the side-seam waist, which is the whole
    // point of it: the side seam is longer, so its waist rides higher.
    expect(side.has('blk1:skirtBack:sideWaist')).toBe(true);
    expect(side.has('blk1:skirtBack:sideHip')).toBe(false);
  });

  it('scopes a dart variable to the panel that has that dart', () => {
    const ids = driven('backDartIntake')!;
    // Darts are inset from the centre, and the first leg sits at the placement
    // distance, so only the far leg and the apex answer to the intake.
    expect(ids.has('blk1:skirtBack:centreWaist')).toBe(false);
    expect(ids.has('blk1:skirtBack:dart0a')).toBe(false);
    expect(ids.has('blk1:skirtBack:dart0b')).toBe(true);
    expect(ids.has('blk1:skirtBack:dart0apex')).toBe(true);
    expect([...ids].some((id) => id.startsWith('blk1:skirtFront:'))).toBe(false);
  });

  it('does not touch the waistband when a panel changes', () => {
    const ids = driven('hipArcBack')!;
    expect(ids.has('blk1:skirtBack:sideHip')).toBe(true);
    expect([...ids].some((id) => id.startsWith('blk1:waistband:'))).toBe(false);
  });

  it('reaches the waistband for a waistband variable', () => {
    const ids = driven('waistbandDepth')!;
    expect(ids.has('blk1:waistband:band-br')).toBe(true);
    expect([...ids].some((id) => id.startsWith('blk1:skirtBack:'))).toBe(false);
  });

  it('still answers for a count, which reshapes rather than nudges', () => {
    const ids = driven('backDartCount')!;
    expect(ids).not.toBeNull();
    expect(ids.size).toBeGreaterThan(0);
  });

  it('sees past a clamp that a small nudge could never escape', () => {
    // Side hip depth *below* centre hip depth is clamped out of the `lift`
    // rule, so it currently does nothing. A one-step probe would report "no
    // effect"; the variable still plainly owns the side waist, and hovering it
    // has to say so.
    const shallow: BlockInstance = {
      ...instance(),
      bindings: {
        ...defaultBindings(SKIRT_BLOCK, null),
        hipDepth: { mode: 'value', cm: 20 },
        sideHipDepth: { mode: 'value', cm: 10 },
      },
    };
    const ids = drivenPointIds(SKIRT_BLOCK, shallow, null, 'sideHipDepth');
    expect(ids).not.toBeNull();
    expect(ids!.has('blk1:skirtBack:sideWaist')).toBe(true);
  });

  it('answers the same way wherever the current number came from', () => {
    const set = person({ hip: 96 });
    const measured: BlockInstance = {
      ...instance(),
      bindings: {
        ...defaultBindings(SKIRT_BLOCK, set),
        hipArcBack: { mode: 'measurement', fieldId: 'hip', divisor: 4, offsetCm: 0, fallbackCm: 24 },
      },
    };
    expect([...driven('hipArcBack', measured)!].sort()).toEqual(
      [...driven('hipArcBack')!].sort()
    );
  });

  it('returns null rather than guessing when the variable is unknown', () => {
    expect(drivenPointIds(SKIRT_BLOCK, instance(), null, 'nope')).toBeNull();
  });

  it('only names points that exist on the block', () => {
    const known = new Set(
      generateBlockPieces(SKIRT_BLOCK, instance(), null).flatMap((g) =>
        g.piece.points.map((p) => p.id)
      )
    );
    for (const variable of SKIRT_BLOCK.variables) {
      for (const id of driven(variable.id) ?? []) {
        expect(known.has(id)).toBe(true);
      }
    }
  });
});

describe('declared bounds', () => {
  it('clamps a resolved value that fell outside its declaration', () => {
    const length = SKIRT_BLOCK.variables.find((v) => v.id === 'skirtLength')!;
    expect(clampToDeclared(length, 2)).toBe(length.minCm);
    expect(clampToDeclared(length, 9999)).toBe(length.maxCm);
    expect(clampToDeclared(length, 75)).toBe(75);
  });

  it('generation is immune to an out-of-range binding', () => {
    // An older build wrote a display value straight in as cm; a draft built from
    // that must still come out the right size rather than collapsing.
    const broken: BlockInstance = {
      ...instance(),
      bindings: { skirtLength: { mode: 'value', cm: 2 } },
    };
    const values = resolveBlockValues(SKIRT_BLOCK, broken, null);
    expect(values.skirtLength).toBe(SKIRT_BLOCK.variables.find((v) => v.id === 'skirtLength')!.minCm);
    const healthy = resolveBlockValues(SKIRT_BLOCK, instance(), null);
    const brokenPieces = generateBlockPieces(SKIRT_BLOCK, broken, null);
    const healthyPieces = generateBlockPieces(SKIRT_BLOCK, instance(), null);
    expect(brokenPieces[0]!.piece.points.map((p) => p.anchor.x)).toEqual(
      healthyPieces[0]!.piece.points.map((p) => p.anchor.x)
    );
    expect(values.skirtLength).toBeLessThan(healthy.skirtLength);
  });
});

describe('block instances', () => {
  it('mints a fresh id every time and copies the origin it is handed', () => {
    const origin = { x: 10, y: 20 };
    const a = createBlockInstance(SKIRT_BLOCK, origin, null, '', null);
    const b = createBlockInstance(SKIRT_BLOCK, origin, null, '', null);
    expect(a.id).not.toBe(b.id);
    expect(a.definitionId).toBe('skirt');
    origin.x = 999;
    expect(a.origin).toEqual({ x: 10, y: 20 });
  });

  it('defaults its bindings against the person it is created for', () => {
    const set = person({ hip: 96, waist: 73 });
    set.id = 'mset1';
    const created = createBlockInstance(SKIRT_BLOCK, { x: 0, y: 0 }, 'mset1', 'Alex', set);
    expect(created.personId).toBe('mset1');
    expect(created.personName).toBe('Alex');
    const hip = created.bindings.hipArcBack;
    expect(hip?.mode).toBe('measurement');
    expect(hip && hip.mode === 'measurement' ? hip.fieldId : null).toBe('hip');
  });
});

describe('block generation', () => {
  it('emits one piece per declared role, in role order', () => {
    const block = instance();
    const generated = generateBlockPieces(SKIRT_BLOCK, block, null);
    expect(generated.map((g) => g.role)).toEqual(['skirtBack', 'skirtFront', 'waistband']);
    expect(generated.map((g) => g.piece.id)).toEqual(
      SKIRT_BLOCK.roles.map((role) => blockPieceId('blk1', role))
    );
  });

  it('draws from the origin on the instance, not the definition', () => {
    const a = generateBlockPieces(SKIRT_BLOCK, instance(), null);
    const moved = { ...instance(), origin: { x: 40, y: 15 } };
    const b = generateBlockPieces(SKIRT_BLOCK, moved, null);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < a[i]!.piece.points.length; j++) {
        expect(b[i]!.piece.points[j]!.anchor.x - a[i]!.piece.points[j]!.anchor.x).toBeCloseTo(40, 6);
        expect(b[i]!.piece.points[j]!.anchor.y - a[i]!.piece.points[j]!.anchor.y).toBeCloseTo(15, 6);
      }
    }
  });

  it('keeps ids and topology steady while a variable is re-bound', () => {
    const set = person({ waist: 73 });
    const block = instance(defaultBindings(SKIRT_BLOCK, set));
    const before = generateBlockPieces(SKIRT_BLOCK, block, set);
    const rebound: BlockInstance = {
      ...block,
      bindings: {
        ...block.bindings,
        waistArcBack: {
          mode: 'measurement',
          fieldId: 'waist',
          divisor: 2,
          offsetCm: 0,
          fallbackCm: 18,
        },
      },
    };
    const after = generateBlockPieces(SKIRT_BLOCK, rebound, set);
    expect(after.map((g) => g.piece.id)).toEqual(before.map((g) => g.piece.id));
    expect(after[0]!.piece.points.map((p) => p.id)).toEqual(
      before[0]!.piece.points.map((p) => p.id)
    );
    // Half the waist rather than a quarter must actually widen the panel.
    const width = (g: { piece: { points: Array<{ anchor: { x: number } }> } }) =>
      Math.max(...g.piece.points.map((p) => p.anchor.x));
    expect(width(after[0]!)).toBeGreaterThan(width(before[0]!));
  });
});

describe('splicing generated pieces into a pattern', () => {
  const other: PatternPiece = {
    id: 'piece_a',
    name: 'A',
    closed: true,
    points: [
      { id: 'p1', anchor: { x: 0, y: 0 } },
      { id: 'p2', anchor: { x: 1, y: 0 } },
      { id: 'p3', anchor: { x: 1, y: 1 } },
    ],
  } as PatternPiece;

  it('appends the block pieces and leaves everything else alone', () => {
    const block = instance();
    const generated = generateBlockPieces(SKIRT_BLOCK, block, null);
    const { pieces, ownership } = spliceBlockPieces([other], block, generated);
    expect(pieces).toHaveLength(4);
    expect(pieces[0]).toBe(other);
    expect(pieces.slice(1).map((p) => p.id)).toEqual(generated.map((g) => g.piece.id));
    expect(ownership).toEqual([
      { role: 'skirtBack', pieceId: 'blk1:skirtBack' },
      { role: 'skirtFront', pieceId: 'blk1:skirtFront' },
      { role: 'waistband', pieceId: 'blk1:waistband' },
    ]);
  });

  it('replaces in place instead of piling up copies on every regeneration', () => {
    const block = instance();
    const first = spliceBlockPieces([other], block, generateBlockPieces(SKIRT_BLOCK, block, null));
    const owned: BlockInstance = { ...block, pieces: first.ownership };
    const second = spliceBlockPieces(
      first.pieces,
      owned,
      generateBlockPieces(SKIRT_BLOCK, owned, null)
    );
    expect(second.pieces).toHaveLength(4);
    expect(second.pieces.map((p) => p.id)).toEqual(first.pieces.map((p) => p.id));
    expect(second.pieces[0]).toBe(other);
  });

  it('drops pieces the block no longer produces', () => {
    const block: BlockInstance = {
      ...instance(),
      pieces: [
        { role: 'skirtBack', pieceId: 'blk1:skirtBack' },
        { role: 'retired', pieceId: 'blk1:retired' },
      ],
    };
    const stale: PatternPiece = { ...other, id: 'blk1:retired' };
    const generated = generateBlockPieces(SKIRT_BLOCK, block, null);
    const { pieces } = spliceBlockPieces([other, stale], block, generated);
    expect(pieces.map((p) => p.id)).not.toContain('blk1:retired');
    expect(pieces.map((p) => p.id)).toContain('blk1:skirtBack');
  });
});

describe('block placement', () => {
  it('drops a new block clear of everything already on the table', () => {
    const pieces = [
      {
        id: 'a',
        name: 'A',
        closed: true,
        points: [
          { id: 'a1', anchor: { x: 10, y: 30 } },
          { id: 'a2', anchor: { x: 60, y: 15 } },
        ],
      },
    ] as PatternPiece[];
    expect(nextBlockOrigin(pieces, { x: 0, y: 0 })).toEqual({ x: 72, y: 15 });
    expect(nextBlockOrigin(pieces, { x: 0, y: 0 }, 5)).toEqual({ x: 65, y: 15 });
  });

  it('falls back when the pattern is empty', () => {
    expect(nextBlockOrigin([], { x: 7, y: 9 })).toEqual({ x: 7, y: 9 });
  });
});

describe('armstrong measurement slots', () => {
  it('are all present in the library', () => {
    for (const id of [
      'shoulderLength',
      'backNeck',
      'bustArc',
      'backArc',
      'waistArc',
      'hipArc',
      'dartPlacement',
      'centerFrontLength',
      'sideLength',
      'shoulderSlope',
      'hipDepth',
      'sideHipDepth',
    ]) {
      expect(MEASUREMENT_IDS.has(id)).toBe(true);
    }
  });
});
