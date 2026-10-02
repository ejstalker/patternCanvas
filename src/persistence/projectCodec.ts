import type { MeshDocument, ProjectDocument } from '../project/types';
import { createMeshDocument, uid } from '../project/createDefault';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';

export function normalizeProject(project: ProjectDocument): ProjectDocument {
  const normalized: ProjectDocument = {
    ...project,
    transforms: project.transforms ?? [],
    meshTransformAssignments: project.meshTransformAssignments ?? [],
    transformSimAssignments: project.transformSimAssignments ?? [],
  };

  for (const transform of normalized.transforms) {
    if (!transform.pieceTransforms) transform.pieceTransforms = {};
  }

  const transformIds = new Set(normalized.transforms.map((transform) => transform.id));
  const claimedIds = new Set<string>();
  for (const node of normalized.canvas.nodes) {
    if (node.type !== 'transform3d') continue;
    if (transformIds.has(node.transformId)) {
      claimedIds.add(node.transformId);
      continue;
    }

    const staleId = node.transformId;
    const replacement = normalized.transforms.find(
      (transform) => !claimedIds.has(transform.id)
    );
    if (!replacement) continue;

    node.transformId = replacement.id;
    claimedIds.add(replacement.id);
    for (const assignment of normalized.meshTransformAssignments) {
      if (assignment.transformId === staleId) {
        assignment.transformId = replacement.id;
      }
    }
    for (const assignment of normalized.transformSimAssignments) {
      if (assignment.transformId === staleId) {
        assignment.transformId = replacement.id;
      }
    }
  }

  const seenTransformLinks = new Set<string>();
  normalized.meshTransformAssignments = normalized.meshTransformAssignments.filter((assignment) => {
    if (!transformIds.has(assignment.transformId)) return false;
    if (seenTransformLinks.has(assignment.transformId)) return false;
    seenTransformLinks.add(assignment.transformId);
    return true;
  });

  return normalized;
}

export function serializeProject(project: ProjectDocument): string {
  return JSON.stringify(project);
}

export function parseProject(json: string): ProjectDocument {
  const raw = JSON.parse(json) as {
    version: number;
    id: string;
    name: string;
    displayUnit: ProjectDocument['displayUnit'];
    canvas?: ProjectDocument['canvas'];
    patterns?: ProjectDocument['patterns'];
    meshes?: MeshDocument[];
    sims?: ProjectDocument['sims'];
    assignments?: Array<{ id: string; patternId?: string; meshId?: string; simId: string }>;
    activeSimId?: string | null;
  };

  if (raw.version === 2 && Array.isArray(raw.meshes)) {
    return normalizeProject(raw as ProjectDocument);
  }

  if (raw.version === 1) {
    const patterns = raw.patterns ?? [];
    const sims = raw.sims ?? [];
    const meshes: MeshDocument[] = [];
    const assignments: ProjectDocument['assignments'] = [];
    const nodes = [...(raw.canvas?.nodes ?? [])];

    const oldAssigns = (raw.assignments ?? []).filter((a) => a.patternId && a.simId);
    const patternIds = new Set(oldAssigns.map((a) => a.patternId!));
    if (patternIds.size === 0 && patterns[0]) patternIds.add(patterns[0].id);

    let meshOffset = 0;
    for (const patternId of patternIds) {
      const pattern = patterns.find((p) => p.id === patternId);
      const mesh = createMeshDocument(patternId, `Mesh · ${pattern?.name ?? 'panel'}`);
      mesh.geometry = triangulatePattern(pattern, mesh.settings ?? { ...DEFAULT_MESH_SETTINGS });
      meshes.push(mesh);
      nodes.push({
        type: 'meshFrame',
        id: uid('node'),
        meshId: mesh.id,
        x: 420,
        y: 100 + meshOffset * 40,
        width: 136,
        height: 160,
        zIndex: 50 + meshOffset,
      });
      meshOffset += 1;
      for (const a of oldAssigns.filter((x) => x.patternId === patternId)) {
        assignments.push({ id: uid('assign'), meshId: mesh.id, simId: a.simId });
      }
    }

    return normalizeProject({
      version: 2,
      id: raw.id,
      name: raw.name,
      displayUnit: raw.displayUnit,
      canvas: {
        panX: raw.canvas?.panX ?? 0,
        panY: raw.canvas?.panY ?? 0,
        zoom: raw.canvas?.zoom ?? 1,
        nodes,
      },
      patterns,
      meshes,
      transforms: [],
      sims,
      assignments,
      meshTransformAssignments: [],
      transformSimAssignments: [],
      activeSimId: raw.activeSimId ?? null,
    });
  }

  throw new Error(`Unsupported project version: ${raw.version}`);
}
