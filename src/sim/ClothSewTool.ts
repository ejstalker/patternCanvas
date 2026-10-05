import { vec3, type mat4 } from 'gl-matrix';
import type { MeshGeometry, PatternDocument, SeamEdgeRef } from '../project/types';
import { sameSeamEdgeTopology } from '../pattern/geometry';
import { findSeamThroughEdge, seamCoversEdge, type EdgeParamHit } from '../pattern/seamHit';
import { worldToCanvasPx } from './MoveGizmo';
import { ClothEdgeOverlay } from './ClothEdgeOverlay';
import {
  buildClothBoundaryEdges,
  pickClothEdge,
  seamRefForBoundaryEdge,
  type ClothBoundaryEdge,
  type ClothEdgeHit,
} from './clothEdgePick';

/**
 * Sewing on the cloth: hover a piece outline to light it up, click two of them
 * to join them, right-click a sewn one to turn the seam end for end.
 *
 * Shared by the transform and drape viewports, which differ in everything except
 * this: which camera they look through and where the cloth comes from. It owns
 * the highlight, the half-made seam, and the rules about what a click means —
 * one implementation, so the two views cannot drift apart in behaviour.
 *
 * The tool is deliberately narrow about the view: it asks for the cloth, the
 * camera and the pattern rather than holding them, because every one of those is
 * replaced whenever the view rebuilds.
 */

/** The parts of a cloth the tool needs — enough for a stub in a test. */
export type SewableCloth = {
  getPositionsSnapshot?: () => Float32Array | null;
  raycast(origin: vec3, dir: vec3): { t: number } | null;
};

/** The parts of a camera the tool needs. */
export type SewableCamera = {
  update(): void;
  getViewProjectMtx(): mat4;
  getEyePosition(): vec3;
};

/** Anything whose rectangle a pointer position can be measured against. */
export type ViewportElement = {
  clientWidth: number;
  clientHeight: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};

export type ClothSewToolHost = {
  /** Where the highlight layer is mounted — the viewport's own host element. */
  host: HTMLElement;
  canvas: ViewportElement;
  getCloth: () => SewableCloth | null;
  getCamera: () => SewableCamera;
  /** Seams live in the pattern; the tool reads them to know what to reverse. */
  getPattern: () => PatternDocument | null;
  onSewEdges?: (a: SeamEdgeRef, b: SeamEdgeRef) => void;
  onReverseSeam?: (seamId: string) => void;
};

/** How far from the pointer an edge may be and still be picked. CSS pixels. */
const PICK_THRESHOLD_PX = 9;

export class ClothSewTool {
  private readonly options: ClothSewToolHost;
  private readonly overlay: ClothEdgeOverlay;
  /** The cloth outline, as pattern edges keyed by the mesh vertices along them. */
  private edges: ClothBoundaryEdge[] = [];
  private enabled = false;
  private hovered: ClothBoundaryEdge | null = null;
  /** First edge of the seam being built, waiting for its partner. */
  private source: SeamEdgeRef | null = null;
  /** Where the pointer was on the edge it pressed, for telling seams apart. */
  private pressed: ClothEdgeHit | null = null;
  private pressWasPick = false;
  private reversePressed: ClothEdgeHit | null = null;

  constructor(options: ClothSewToolHost) {
    this.options = options;
    this.overlay = new ClothEdgeOverlay(options.host);
  }

  /**
   * Re-index the outline after the cloth was rebuilt, and drop any half-made
   * seam: the vertices it referred to are gone.
   */
  rebuild(mesh: MeshGeometry | null | undefined): void {
    this.edges = buildClothBoundaryEdges(mesh);
    this.clear();
  }

  /** False when the cloth has no outline to pick, e.g. no pattern behind it. */
  isAvailable(): boolean {
    return this.edges.length > 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
    else this.sync();
  }

  /** Drop the highlight and any half-made seam. */
  clear(): void {
    this.hovered = null;
    this.source = null;
    this.pressed = null;
    this.pressWasPick = false;
    this.reversePressed = null;
    this.overlay.setHover(null);
    this.overlay.setSource(null);
  }

  /** True while a first edge is picked and waiting for its partner. */
  hasPendingEdge(): boolean {
    return this.source !== null;
  }

  /** Re-pick the edge under the pointer. Cheap when it has not changed. */
  refreshHover(clientX: number, clientY: number): void {
    const next = this.pickAt(clientX, clientY);
    const same =
      (next?.edge.pieceId ?? null) === (this.hovered?.pieceId ?? null) &&
      (next?.edge.fromPointId ?? null) === (this.hovered?.fromPointId ?? null) &&
      (next?.edge.toPointId ?? null) === (this.hovered?.toPointId ?? null);
    if (same) return;
    this.hovered = next?.edge ?? null;
    this.sync();
  }

  /**
   * Remember what is under the pointer. Called from pointerdown, whatever the
   * button: a press that turns into a drag is the view's orbit, not a click.
   */
  beginPress(clientX: number, clientY: number, button: number): void {
    this.pressed = null;
    this.pressWasPick = false;
    this.reversePressed = null;
    if (button === 0) {
      this.pressWasPick = true;
      this.pressed = this.pickAt(clientX, clientY);
    } else if (button === 2) {
      this.reversePressed = this.pickAt(clientX, clientY);
    }
  }

  /**
   * Finish a gesture. Returns true when the tool acted, so the view knows not to
   * treat the same click as a selection.
   */
  endPress(moved: boolean, button: number): boolean {
    const pressed = this.pressed;
    const reversing = this.reversePressed;
    const wasPick = this.pressWasPick;
    this.pressed = null;
    this.pressWasPick = false;
    this.reversePressed = null;
    if (moved) return false;

    if (button === 2 && reversing) {
      this.reverseAt(this.paramHit(reversing));
      return true;
    }
    if (!wasPick || button !== 0) return false;
    if (pressed) {
      this.commitPick(this.paramHit(pressed));
      return true;
    }
    // A click on bare fabric means "never mind", not "deselect everything".
    const hadPending = this.hasPendingEdge();
    this.source = null;
    this.sync();
    return hadPending;
  }

  /** Re-project the highlight. Call once per frame: the cloth and camera move. */
  sync(): void {
    if (!this.enabled) {
      this.overlay.setHover(null);
      this.overlay.setSource(null);
      return;
    }
    this.overlay.setHover(this.projectEdge(this.hovered?.vertices ?? null));
    this.overlay.setSource(
      this.source ? this.projectEdge(this.verticesForSeamEdge(this.source)) : null
    );
  }

  destroy(): void {
    this.overlay.destroy();
    this.edges = [];
  }

  /**
   * The cloth edge under the pointer, if any.
   *
   * The ray decides what is in front: an edge whose midpoint the cloth hides is
   * rejected, because near a silhouette the far side of a panel projects just as
   * near the pointer as the near side does.
   */
  private pickAt(clientX: number, clientY: number): ClothEdgeHit | null {
    const cloth = this.options.getCloth();
    if (!cloth || this.edges.length === 0) return null;
    const positions = cloth.getPositionsSnapshot?.() ?? null;
    if (!positions || positions.length < 3) return null;
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const camera = this.options.getCamera();
    camera.update();
    const eye = camera.getEyePosition();
    const hit = pickClothEdge(
      this.edges,
      positions,
      camera.getViewProjectMtx(),
      rect,
      clientX,
      clientY,
      {
        thresholdPx: PICK_THRESHOLD_PX,
        isHidden: (point) => {
          const dx = point[0] - eye[0];
          const dy = point[1] - eye[1];
          const dz = point[2] - eye[2];
          const dist = Math.hypot(dx, dy, dz);
          if (dist < 1e-6) return false;
          const surface = cloth.raycast(
            eye,
            vec3.fromValues(dx / dist, dy / dist, dz / dist)
          );
          // Slack, so an edge lying on the surface counts as visible.
          return !!surface && surface.t < dist - 0.01;
        },
      }
    );
    return hit;
  }

  /** The `EdgeParamHit` a pick represents: the edge's ids plus where it landed. */
  private paramHit(pick: ClothEdgeHit): EdgeParamHit {
    return {
      pieceId: pick.edge.pieceId,
      fromPointId: pick.edge.fromPointId,
      toPointId: pick.edge.toPointId,
      t: pick.t,
    };
  }

  /** A click: pick, pair, or take the first pick back. */
  private commitPick(hit: EdgeParamHit): void {
    const ref: SeamEdgeRef = {
      pieceId: hit.pieceId,
      fromPointId: hit.fromPointId,
      toPointId: hit.toPointId,
      t0: 0,
      t1: 1,
    };
    if (!this.source) {
      if (this.edgeHasSeam(hit)) return;
      this.source = ref;
      this.sync();
      return;
    }
    // Clicking the same edge again takes the first pick back.
    if (sameSeamEdgeTopology(this.source, ref)) {
      this.source = null;
      this.sync();
      return;
    }
    const first = this.source;
    this.source = null;
    if (this.pairAlreadySewn(first, ref)) {
      this.sync();
      return;
    }
    this.options.onSewEdges?.(first, ref);
  }

  /**
   * Right-click: turn a seam end for end, so the two sides are read the same way.
   *
   * Which end of an edge meets which is decided by direction, and on a mirrored
   * piece "the same way" is not the way it looks. This is the escape hatch, the
   * one the pattern editor's seam menu also offers.
   */
  private reverseAt(hit: EdgeParamHit): void {
    // Only a seam the pointer is actually on: a click in the free half of a
    // half-sewn edge must not flip the neighbour it happens to share the edge
    // with. There is no highlight to warn you here, the click acts at once.
    const seam = this.seamThroughEdge(hit);
    if (seam && this.seamCovers(hit)) {
      this.options.onReverseSeam?.(seam);
      return;
    }
    // Nothing sewn here yet — flip the half-made seam instead, so the first pick
    // can be turned round before the second one is chosen.
    if (
      this.source &&
      this.source.pieceId === hit.pieceId &&
      this.source.fromPointId === hit.fromPointId &&
      this.source.toPointId === hit.toPointId
    ) {
      const t0 = this.source.t0;
      this.source.t0 = this.source.t1;
      this.source.t1 = t0;
      this.sync();
    }
  }

  /** Is a seam already covering this position on this edge? */
  private edgeHasSeam(hit: EdgeParamHit): boolean {
    return this.seamCovers(hit);
  }

  /** Is there a seam whose span covers the position the pointer landed on? */
  private seamCovers(hit: EdgeParamHit): boolean {
    return (this.options.getPattern()?.seams ?? []).some((seam) => seamCoversEdge(seam, hit));
  }

  /**
   * The seam nearest the position the pointer landed on.
   *
   * Which seam matters: one many-to-many sew leaves several seams along a single
   * edge, side by side, and they cannot be told apart by the edge alone.
   */
  private seamThroughEdge(hit: EdgeParamHit): string | null {
    return findSeamThroughEdge(this.options.getPattern()?.seams ?? [], hit)?.id ?? null;
  }

  private pairAlreadySewn(a: SeamEdgeRef, b: SeamEdgeRef): boolean {
    return (this.options.getPattern()?.seams ?? []).some(
      (seam) =>
        (sameSeamEdgeTopology(seam.a, a) && sameSeamEdgeTopology(seam.b, b)) ||
        (sameSeamEdgeTopology(seam.b, a) && sameSeamEdgeTopology(seam.a, b))
    );
  }

  /**
   * Mesh vertices along a seam edge, ordered the way the reference is read, so the
   * direction marker sits on the end that pairs with the other edge's start.
   */
  private verticesForSeamEdge(ref: SeamEdgeRef): number[] {
    const match = this.edges.find(
      (edge) =>
        edge.pieceId === ref.pieceId &&
        edge.fromPointId === ref.fromPointId &&
        edge.toPointId === ref.toPointId
    );
    if (match) return ref.t0 > ref.t1 ? [...match.vertices].reverse() : match.vertices;
    // A reference named from the other end reads along the same vertices.
    const flipped = this.edges.find(
      (edge) =>
        edge.pieceId === ref.pieceId &&
        edge.fromPointId === ref.toPointId &&
        edge.toPointId === ref.fromPointId
    );
    if (!flipped) return [];
    return ref.t0 > ref.t1 ? flipped.vertices : [...flipped.vertices].reverse();
  }

  private projectEdge(vertices: readonly number[] | null): Array<{ x: number; y: number }> | null {
    if (!vertices || vertices.length < 2) return null;
    const positions = this.options.getCloth()?.getPositionsSnapshot?.() ?? null;
    if (!positions) return null;
    const camera = this.options.getCamera();
    const points: Array<{ x: number; y: number }> = [];
    for (const vi of vertices) {
      if (vi < 0 || vi * 3 + 2 >= positions.length) return null;
      const px = worldToCanvasPx(
        vec3.fromValues(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]),
        camera,
        this.options.canvas
      );
      if (!px || px.behind) return null;
      points.push({ x: px.x, y: px.y });
    }
    return points.length >= 2 ? points : null;
  }
}
