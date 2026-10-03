import { describe, expect, it } from 'vitest';
import { normalizeProject, parseProject, serializeProject } from './projectCodec';
import { documentToSavePayload, manifestToDocument } from './manifestCodec';
import { packMeshGeometry, unpackMeshGeometry, packPose, unpackPose, type PoseRecord } from './schema';
import { createSmallFixture } from './fixtures';
import { createDefaultProject } from '../project/createDefault';
import { DEFAULT_DISPLAY_UNIT } from '../project/types';
import { projectStore } from './ProjectStore';
import { exportProjectArchiveBytes, importProjectArchive } from './projectArchive';

describe('projectCodec', () => {
  it('round-trips a small fixture', () => {
    const project = createSmallFixture();
    const json = serializeProject(project);
    const parsed = parseProject(json);
    expect(parsed.id).toBe(project.id);
    expect(parsed.patterns.length).toBe(project.patterns.length);
  });

  it('normalizes missing transform arrays', () => {
    const project = createSmallFixture();
    const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    delete raw.transforms;
    delete raw.meshTransformAssignments;
    const normalized = normalizeProject(raw as never);
    expect(Array.isArray(normalized.transforms)).toBe(true);
  });

  it('keeps transform settings through a JSON round trip', () => {
    const project = createSmallFixture();
    const pieceId = project.patterns[0]!.pieces[0]!.id;
    const expected = project.transforms[0]!.pieceTransforms[pieceId];
    expect(expected).toBeDefined();

    const parsed = parseProject(serializeProject(project));
    expect(parsed.transforms).toHaveLength(1);
    expect(parsed.transforms[0]!.pieceTransforms[pieceId]).toEqual(expected);
    expect(parsed.meshTransformAssignments).toHaveLength(1);
  });
});

describe('display units', () => {
  it('opens a new project in the default unit', () => {
    expect(DEFAULT_DISPLAY_UNIT).toBe('in');
    expect(createDefaultProject().displayUnit).toBe(DEFAULT_DISPLAY_UNIT);
  });

  it('does not convert a project that already has a unit', () => {
    // Changing the default must never rewrite a project you already drafted in.
    const project = createSmallFixture();
    project.displayUnit = 'cm';
    const parsed = parseProject(serializeProject(project));
    expect(parsed.displayUnit).toBe('cm');
    expect(parseProject(serializeProject(createDefaultProject())).displayUnit).toBe(
      DEFAULT_DISPLAY_UNIT
    );
  });

  it('falls back to the default when a file carries no usable unit', () => {
    const project = createSmallFixture();
    const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    delete raw.displayUnit;
    expect(normalizeProject(raw as never).displayUnit).toBe(DEFAULT_DISPLAY_UNIT);

    const bogus = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    bogus.displayUnit = 'furlongs';
    expect(normalizeProject(bogus as never).displayUnit).toBe(DEFAULT_DISPLAY_UNIT);
  });

  it('survives the compressed save payload', async () => {
    const project = createSmallFixture();
    project.displayUnit = 'in';
    const payload = await documentToSavePayload(project, { projectId: project.id, revision: 1 });
    const hydrated = manifestToDocument(
      payload.manifest,
      new Map(payload.assets.map((a) => [a.id, a.blob])),
      new Map(payload.poses.map((p) => [p.id, p])),
      new Map(payload.meshCaches.map((m) => [m.id, m])),
      (_id, blob) => URL.createObjectURL(blob)
    );
    expect(hydrated.displayUnit).toBe('in');
  });
});

describe('transform persistence through the save payload', () => {
  it('keeps per-piece transform settings', async () => {
    const project = createSmallFixture();
    const pieceId = project.patterns[0]!.pieces[0]!.id;
    const expected = project.transforms[0]!.pieceTransforms[pieceId];

    const payload = await documentToSavePayload(project, {
      projectId: project.id,
      revision: 1,
    });
    const hydrated = manifestToDocument(
      payload.manifest,
      new Map(payload.assets.map((a) => [a.id, a.blob])),
      new Map(payload.poses.map((p) => [p.id, p])),
      new Map(payload.meshCaches.map((m) => [m.id, m])),
      (_id, blob) => URL.createObjectURL(blob)
    );

    expect(hydrated.transforms).toHaveLength(1);
    expect(hydrated.transforms[0]!.name).toBe('Transform 3D');
    expect(hydrated.transforms[0]!.meshId).toBe(project.transforms[0]!.meshId);
    expect(hydrated.transforms[0]!.camera).toEqual(project.transforms[0]!.camera);
    expect(hydrated.transforms[0]!.pieceTransforms[pieceId]).toEqual(expected);
  });

  it('keeps transform settings through an archive round trip', async () => {
    const project = createSmallFixture();
    const pieceId = project.patterns[0]!.pieces[0]!.id;
    const expected = project.transforms[0]!.pieceTransforms[pieceId];

    const bytes = await exportProjectArchiveBytes(project);
    const imported = await importProjectArchive(bytes);

    expect(imported.transforms).toHaveLength(1);
    expect(imported.transforms[0]!.pieceTransforms[pieceId]).toEqual(expected);
  });
});

describe('mesh geometry pack/unpack', () => {
  it('preserves vertices and triangles', () => {
    const project = createSmallFixture();
    const geom = project.meshes[0]!.geometry!;
    const packed = packMeshGeometry(geom);
    const restored = unpackMeshGeometry(packed);
    expect(restored.vertices.length).toBe(geom.vertices.length);
    expect(restored.triangles.length).toBe(geom.triangles.length);
  });
});

describe('pose pack/unpack', () => {
  it('preserves float arrays', () => {
    const positions = [0, 1, 2, 3, 4, 5];
    const packed = packPose(positions, [0, 0, 0, 0, 0, 0]);
    const record: PoseRecord = {
      id: 'pose_test',
      projectId: 'p',
      ownerType: 'sim',
      ownerId: 'sim',
      vertexCount: 2,
      topologyHash: 'h',
      positions: packed.positions,
      velocities: packed.velocities,
      updatedAt: Date.now(),
    };
    const restored = unpackPose(record);
    expect(restored.positions).toEqual(positions);
  });
});

describe('manifest codec', () => {
  it('externalizes and hydrates a project', async () => {
    const project = createSmallFixture();
    const payload = await documentToSavePayload(project, {
      projectId: project.id,
      revision: 1,
    });
    expect(payload.manifest.version).toBe(3);
    const assets = new Map(payload.assets.map((a) => [a.id, a.blob]));
    const poses = new Map(payload.poses.map((p) => [p.id, p]));
    const meshCaches = new Map(payload.meshCaches.map((m) => [m.id, m]));
    const hydrated = manifestToDocument(
      payload.manifest,
      assets,
      poses,
      meshCaches,
      (_id, blob) => URL.createObjectURL(blob)
    );
    expect(hydrated.meshes[0]?.geometry?.vertices.length).toBe(
      project.meshes[0]?.geometry?.vertices.length
    );
  });
});

describe('ProjectStore', () => {
  it('saves and loads a project from IndexedDB', async () => {
    const project = createSmallFixture();
    await projectStore.initialize();
    const save = await projectStore.saveProject(project, { forceFull: true });
    expect(save.ok).toBe(true);
    const loaded = await projectStore.load(project.id);
    expect(loaded?.name).toBe(project.name);
    expect(loaded?.patterns.length).toBe(project.patterns.length);
  });
});

describe('project archive', () => {
  it('exports and imports a zip archive', async () => {
    const project = createSmallFixture();
    const bytes = await exportProjectArchiveBytes(project);
    const imported = await importProjectArchive(bytes);
    expect(imported.id).toBe(project.id);
    expect(imported.patterns.length).toBe(project.patterns.length);
  });
});
