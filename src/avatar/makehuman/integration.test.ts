import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bakeDistances } from '../../mesh/sdfBakeCore';
import { floorLift } from '../../mesh/floorLift';
import { parseBaseMesh } from './baseMesh';
import { parseTarget, type TargetDelta } from './targetFile';
import { macroTargetRequests, allMeasureTargetNames } from './macroTargets';
import { generateAvatar, FIELD_READERS } from './generate';
import { heightCm, measureCm } from './ruler';
import {
  analyzeCollisionMesh,
  clipAbovePlane,
  composeAvatarMesh,
  NECK_TOP_VERTEX,
} from '../generateMesh';

const ASSET_DIR = resolvePath(process.cwd(), 'refPpl/mh');

function loadTargets(): Map<string, TargetDelta> {
  const names = [...macroTargetRequests(0, 0.5).map((r) => r.name), ...allMeasureTargetNames()];
  // Load a superset so the solver can request any macro height target.
  const extra = [
    'caucasian-female-young',
    'caucasian-male-young',
    'universal-female-young-averagemuscle-averageweight',
    'universal-male-young-averagemuscle-averageweight',
    'female-young-averagemuscle-averageweight-minheight',
    'female-young-averagemuscle-averageweight-maxheight',
    'male-young-averagemuscle-averageweight-minheight',
    'male-young-averagemuscle-averageweight-maxheight',
  ];
  const all = new Set([...names, ...extra]);
  const map = new Map<string, TargetDelta>();
  for (const name of all) {
    try {
      map.set(name, parseTarget(readFileSync(`${ASSET_DIR}/targets/${name}.target`, 'utf8')));
    } catch {
      /* measure targets without files are skipped */
    }
  }
  return map;
}

describe('MakeHuman integration (real vendored assets)', () => {
  const base = parseBaseMesh(readFileSync(`${ASSET_DIR}/base.obj`, 'utf8'));
  const targets = loadTargets();
  const resolve = (name: string): TargetDelta | null => targets.get(name) ?? null;

  it('neutral base mesh is ~169.5 cm and 19158 verts', () => {
    expect(base.positions.length / 3).toBe(19158);
    expect(heightCm(base.positions)).toBeCloseTo(169.455, 1);
  });

  it('generates a plausible neutral body', () => {
    const result = generateAvatar({
      base: base.positions,
      indices: base.bodyTriangleIndices,
      resolve,
      gender: 0.5,
      heightCm: 170,
    });
    expect(result.measured.height).toBeCloseTo(170, 0);

    // Every readable field should be a sensible positive length.
    for (const [field, names] of Object.entries(FIELD_READERS)) {
      const value = measureCm(result.positions, names);
      expect(value, field).toBeGreaterThan(1);
    }
    expect(result.measured.waist).toBeGreaterThan(50);
    expect(result.measured.waist).toBeLessThan(120);
    expect(result.measured.hip).toBeGreaterThan(60);
    expect(result.measured.inseam).toBeGreaterThan(50);
    expect(result.measured.inseam).toBeLessThan(100);
  });

  it('drives entered measurements and derives the rest', () => {
    const result = generateAvatar({
      base: base.positions,
      indices: base.bodyTriangleIndices,
      resolve,
      gender: 0,
      heightCm: 165,
      measurements: { waist: 72, inseam: 82 },
    });

    expect(result.measured.height).toBeCloseTo(165, 1);
    expect(result.measured.waist).toBeCloseTo(72, 0);
    expect(result.measured.inseam).toBeCloseTo(82, 0);
    expect(result.saturated).toEqual([]);
    // Derived fields are still sensible.
    expect(result.measured.bust).toBeGreaterThan(60);
    expect(result.measured.napeToWaist).toBeGreaterThan(20);
  });

  it('reports a goal outside the achievable range as saturated', () => {
    const result = generateAvatar({
      base: base.positions,
      resolve,
      gender: 0,
      heightCm: 165,
      measurements: { inseam: 60 },
    });
    expect(result.saturated).toContain('inseam');
  });

  it('derives the plane-slice measurements', () => {
    const result = generateAvatar({
      base: base.positions,
      indices: base.bodyTriangleIndices,
      resolve,
      gender: 0.5,
      heightCm: 170,
    });
    const fields = [
      'highBust', 'highHip', 'acrossBack', 'acrossFront', 'shoulderWidth', 'bustSpan',
      'bustArc', 'backArc', 'waistArc', 'hipArc', 'dartPlacement', 'elbow', 'forearm',
      'backNeck', 'shoulderToWaistBack', 'shoulderToWaistFront', 'armscyeDepth',
      'neckToBustPoint', 'centerFrontLength', 'sideLength', 'sideHipDepth', 'outseam',
      'trouserLength', 'weight',
    ];
    const rounded: Record<string, number> = {};
    for (const field of fields) {
      const value = result.measured[field];
      expect(Number.isFinite(value), field).toBe(true);
      rounded[field] = Math.round((value ?? 0) * 10) / 10;
    }
    // eslint-disable-next-line no-console
    console.log('DERIVED', JSON.stringify(rounded));
  });

  it('collision mesh removes the head but keeps the neck', () => {
    const result = generateAvatar({ base: base.positions, resolve, gender: 0.5, heightCm: 170 });
    const render = result.positions;
    const planeY = render[NECK_TOP_VERTEX * 3 + 1]!;
    // Build the render mesh via the same path the service uses.
    const collision = clipAbovePlane(
      base.positions.slice(),
      base.bodyTriangleIndices.slice(),
      planeY
    );

    let collisionMaxY = -Infinity;
    for (let i = 1; i < collision.positions.length; i += 3) {
      collisionMaxY = Math.max(collisionMaxY, collision.positions[i]!);
    }
    expect(collisionMaxY).toBeCloseTo(planeY, 4);
    expect(collision.indices.length).toBeGreaterThan(0);
  });
});

/**
 * The collision mesh's *frame*, which is the part that is easy to get wrong: the
 * cloth is simulated with the avatar's feet on the floor, so anything baked from
 * the collision mesh has to be in that same frame.
 */
describe('generated avatar collision mesh (real assets)', () => {
  const base = parseBaseMesh(readFileSync(`${ASSET_DIR}/base.obj`, 'utf8'));
  const targets = loadTargets();
  const mesh = composeAvatarMesh(base, (name: string) => targets.get(name) ?? null, {
    gender: 0.5,
    heightCm: 170,
  });

  const yBounds = (positions: Float32Array) => {
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) {
      minY = Math.min(minY, positions[i]!);
      maxY = Math.max(maxY, positions[i]!);
    }
    return { minY, maxY };
  };

  it('is emitted in body space, resting on the floor', () => {
    const render = yBounds(mesh.render.positions);
    const collision = yBounds(mesh.collision.positions);

    // The render mesh stays in the morph's own frame: hips at 0, feet below.
    expect(render.minY).toBeLessThan(-5);
    expect(mesh.floorLift).toBeCloseTo(-render.minY, 6);
    expect(mesh.floorLift).toBeCloseTo(floorLift(mesh.render.positions), 6);

    // The collision mesh is moved into the frame AvatarBody and the cloth use,
    // which is also the frame the pattern view's avatar overlay is aligned to.
    expect(collision.minY).toBeCloseTo(0, 6);
    const neckTop = mesh.positions[NECK_TOP_VERTEX * 3 + 1]!;
    expect(collision.maxY).toBeCloseTo(neckTop + mesh.floorLift, 4);
    // Head removed, body kept.
    expect(collision.maxY).toBeLessThan(yBounds(mesh.positions).maxY + mesh.floorLift - 1);
    expect(mesh.collision.indices.length / 3).toBeGreaterThan(5000);
  });

  it('bakes a field that classifies points in that frame correctly', () => {
    // A 5 cm voxel box around the pelvis and lower torso, placed using the body
    // frame only: 10 cm below the hip origin to 40 cm above it.
    const voxelSize = 0.5;
    const origin: [number, number, number] = [-1.5, mesh.floorLift - 1, -1.5];
    const dim: [number, number, number] = [6, 10, 6];
    const distances = bakeDistances({
      positions: mesh.collision.positions,
      indices: mesh.collision.indices,
      origin,
      voxelSize,
      dim,
    });

    const inside = [...distances].filter((d) => d < 0).length;
    const fraction = inside / distances.length;
    // Not empty (the field would be nowhere near the body), and not solid.
    expect(fraction).toBeGreaterThan(0.15);
    expect(fraction).toBeLessThan(0.85);
  });

  it('documents the neck cut: open edges, and a cap wider than the neck (known gap)', () => {
    const a = analyzeCollisionMesh(mesh.collision.positions, mesh.collision.indices);
    expect(a.vertices).toBeGreaterThan(1000);
    expect(a.triangles).toBeGreaterThan(5000);
    expect(a.nonManifoldEdges).toBe(0);
    // Snapping the straddling triangles flat leaves one-sided edges behind, so
    // the mesh is not watertight. Measured: ~300 open edges on a neutral body.
    expect(a.openEdges).toBeGreaterThan(0);
    expect(a.openEdges).toBeLessThan(a.triangles * 0.05);
    expect(a.watertight).toBe(false);
    // The snapped cap is the head's projection as much as the neck's section:
    // a real neck ring is ~5-6 cm across, and this reaches ~17 cm from the axis.
    expect(a.cutReach).toBeGreaterThan(0.6);
    // The cut is the top of the mesh, and it sits at the neck.
    expect(a.maxY).toBeGreaterThan(0);
  });
});
