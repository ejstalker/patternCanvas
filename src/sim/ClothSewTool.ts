import { vec3, type mat4 } from 'gl-matrix';
import type { MeshGeometry, PatternDocument, SeamEdgeRef } from '../project/types';
import { sameSeamEdgeTopology, seamReadsFromSecondHalf, seamRefFromHalf } from '../pattern/geometry';
import { findSeamThroughEdge, seamCoversEdge, type EdgeParamHit } from '../pattern/seamHit';
import { worldToCanvasPx } from './MoveGizmo';
import { ClothEdgeOverlay, type ClothEdgePoint } from './ClothEdgeOverlay';
import {
  buildClothBoundaryEdges,
  buildStitchPreviewPairs,
  pickClothEdge,
  seamRefForBoundaryEdge,
  type ClothBoundaryEdge,
  type ClothEdgeHit,
} from './clothEdgePick';

/**
 * Sewing on the cloth: hover a piece outline to light it up, click two of them
 * to join them, right-click a sewn one for its reverse / delete popover.
 *
 * Which *half* of an edge you hover or click sets the seam direction — the end
 * you pick is the end the edge is read from, so stitch order can be aimed
 * directly (the Marvelous Designer gesture). The hover marker previews it.
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
  /** Right-click → "Delete seam": the host drops it and rebuilds. */
  onDeleteSeam?: (seamId: string) => void;
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
  /** Where along the hovered edge the pointer is, 0..1 — sets the shown direction. */
  private hoverT = 0;
  /** First edge of the seam being built, waiting for its partner. */
  private source: SeamEdgeRef | null = null;
  /** Where the pointer was on the edge it pressed, for telling seams apart. */
  private pressed: ClothEdgeHit | null = null;
  private pressWasPick = false;
  private reversePressed: ClothEdgeHit | null = null;
  /** Where the pointer went down, so the seam popover can open there. */
  private pressX = 0;
  private pressY = 0;
  /** The right-click popover on a sewn edge (reverse / delete). */
  private seamMenu: HTMLElement | null = null;
  // Stable handlers so destroy() can remove the global dismiss listeners.
  private readonly onDocumentPointerDown = () => this.closeSeamMenu();
  private readonly onWindowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.closeSeamMenu();
  };
  private readonly onWindowResize = () => this.closeSeamMenu();

  constructor(options: ClothSewToolHost) {
    this.options = options;
    this.overlay = new ClothEdgeOverlay(options.host);
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
    window.addEventListener('keydown', this.onWindowKeyDown);
    window.addEventListener('resize', this.onWindowResize);
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

  /** Drop the highlight, any half-made seam, and the seam popover. */
  clear(): void {
    this.hovered = null;
    this.hoverT = 0;
    this.source = null;
    this.pressed = null;
    this.pressWasPick = false;
    this.reversePressed = null;
    this.closeSeamMenu();
    this.overlay.setHover(null);
    this.overlay.setSource(null);
    this.overlay.setStitch(null);
  }

  /** True while a first edge is picked and waiting for its partner. */
  hasPendingEdge(): boolean {
    return this.source !== null;
  }

  /** Re-pick the edge under the pointer. Cheap when it has not changed. */
  refreshHover(clientX: number, clientY: number): void {
    const next = this.pickAt(clientX, clientY);
    // Which half the pointer is on matters as much as the edge: it is the seam
    // direction preview, so crossing the midpoint has to re-project.
    const half = (next?.t ?? 0) > 0.5;
    const same =
      (next?.edge.pieceId ?? null) === (this.hovered?.pieceId ?? null) &&
      (next?.edge.fromPointId ?? null) === (this.hovered?.fromPointId ?? null) &&
      (next?.edge.toPointId ?? null) === (this.hovered?.toPointId ?? null) &&
      half === this.hoverT > 0.5; // both are "is the pointer past the midpoint"
    if (same) return;
    this.hovered = next?.edge ?? null;
    this.hoverT = next?.t ?? 0;
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
    this.pressX = clientX;
    this.pressY = clientY;
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
      return this.reverseAt(this.paramHit(reversing), this.pressX, this.pressY);
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
      this.overlay.setStitch(null);
      return;
    }
    // The hover highlight carries the direction a click here would sew: read
    // from the near half, so the marker sits at the end the pointer is on.
    const hoverVerts = this.hovered
      ? this.hoverT > 0.5
        ? [...this.hovered.vertices].reverse()
        : this.hovered.vertices
      : null;
    this.overlay.setHover(this.projectEdge(hoverVerts));
    this.overlay.setSource(
      this.source ? this.projectEdge(this.verticesForSeamEdge(this.source)) : null
    );
    this.overlay.setStitch(this.buildStitchPreview());
  }

  /**
   * The stitches a click would make, projected to screen. With one edge picked,
   * hovering a partner shows the pairing (rank-order zipped, exactly as the
   * mesher sews) — so a crossing, reversed run is visible before it is created.
   */
  private buildStitchPreview(): Array<[ClothEdgePoint, ClothEdgePoint]> | null {
    const source = this.source;
    const hovered = this.hovered;
    if (!source || !hovered) return null;
    const sourceEdge = this.edges.find(
      (edge) =>
        edge.pieceId === source.pieceId &&
        edge.fromPointId === source.fromPointId &&
        edge.toPointId === source.toPointId
    );
    if (!sourceEdge || sourceEdge === hovered) return null;
    const hoverRef = this.refForHit({
      pieceId: hovered.pieceId,
      fromPointId: hovered.fromPointId,
      toPointId: hovered.toPointId,
      t: this.hoverT,
    });
    if (this.pairAlreadySewn(source, hoverRef)) return null;

    const positions = this.options.getCloth()?.getPositionsSnapshot?.() ?? null;
    if (!positions || positions.length < 3) return null;
    const camera = this.options.getCamera();
    camera.update();

    const pairs = buildStitchPreviewPairs(sourceEdge, source, hovered, hoverRef);
    const out: Array<[ClothEdgePoint, ClothEdgePoint]> = [];
    for (const [ia, ib] of pairs) {
      const a = this.projectVertex(ia, positions, camera);
      const b = this.projectVertex(ib, positions, camera);
      if (a && b) out.push([a, b]);
    }
    return out.length ? out : null;
  }

  /** One mesh vertex projected to layout space, or null when off-screen. */
  private projectVertex(
    index: number,
    positions: ArrayLike<number>,
    camera: SewableCamera
  ): ClothEdgePoint | null {
    if (index < 0 || index * 3 + 2 >= positions.length) return null;
    const px = worldToCanvasPx(
      vec3.fromValues(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]),
      camera,
      this.options.canvas
    );
    if (!px || px.behind) return null;
    return { x: px.x, y: px.y };
  }

  destroy(): void {
    this.closeSeamMenu();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    window.removeEventListener('keydown', this.onWindowKeyDown);
    window.removeEventListener('resize', this.onWindowResize);
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

  /**
   * The seam reference a pick means. Which *half* of the edge the pointer was on
   * decides the sewing direction (Marvelous Designer-style): the half you pick
   * is where the edge is read from, so the stitch order can be aimed without a
   * separate reverse step.
   */
  private refForHit(hit: EdgeParamHit): SeamEdgeRef {
    return seamRefFromHalf(hit.pieceId, hit.fromPointId, hit.toPointId, hit.t);
  }

  /** A click: pick, pair, or take the first pick back. */
  private commitPick(hit: EdgeParamHit): void {
    const ref = this.refForHit(hit);
    if (!this.source) {
      if (this.edgeHasSeam(hit)) return;
      this.source = ref;
      this.sync();
      return;
    }
    if (sameSeamEdgeTopology(this.source, ref)) {
      // Same edge: clicking the same half takes the pick back, the other half
      // flips the direction the seam will be sewn in.
      const sameDirection =
        seamReadsFromSecondHalf(this.source) === seamReadsFromSecondHalf(ref);
      this.source = sameDirection ? null : ref;
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
   * Right-click: on a sewn edge, open the seam popover (reverse / delete); on
   * the half-made first pick, flip it end for end.
   *
   * Which end of an edge meets which is decided by direction, and on a mirrored
   * piece "the same way" is not the way it looks — reversing is the correction,
   * the same escape hatch the pattern editor's seam menu offers. Returns true
   * when it acted, so the view does not also treat the click as something else.
   */
  private reverseAt(hit: EdgeParamHit, clientX: number, clientY: number): boolean {
    // Only a seam the pointer is actually on: a click in the free half of a
    // half-sewn edge must not touch the neighbour it happens to share the edge
    // with, and one many-to-many run leaves several seams along a single edge.
    const seam = this.seamThroughEdge(hit);
    if (seam && this.seamCovers(hit)) {
      this.openSeamMenu(seam, clientX, clientY);
      return true;
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
      return true;
    }
    return false;
  }

  /** Popover for a sewn edge: reverse the seam, or delete it outright. */
  private openSeamMenu(seamId: string, clientX: number, clientY: number): void {
    this.closeSeamMenu();
    const menu = document.createElement('div');
    menu.className = 'seam-context-menu';
    menu.setAttribute('role', 'menu');

    const title = document.createElement('p');
    title.className = 'node-context-title';
    title.textContent = this.seamLabel(seamId);
    menu.appendChild(title);

    menu.appendChild(
      this.menuButton('Reverse seam', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeSeamMenu();
        this.options.onReverseSeam?.(seamId);
      })
    );
    menu.appendChild(
      this.menuButton(
        'Delete seam',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.closeSeamMenu();
          this.options.onDeleteSeam?.(seamId);
        },
        'is-danger'
      )
    );

    // Keep presses inside the popover from reaching the dismiss listener.
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());

    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    document.body.appendChild(menu);
    this.seamMenu = menu;

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
  }

  private menuButton(
    label: string,
    onClick: (e: MouseEvent) => void,
    extraClass = ''
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    if (extraClass) button.classList.add(extraClass);
    button.addEventListener('click', onClick);
    return button;
  }

  private closeSeamMenu(): void {
    this.seamMenu?.remove();
    this.seamMenu = null;
  }

  private seamLabel(seamId: string): string {
    const pattern = this.options.getPattern();
    const seam = pattern?.seams.find((s) => s.id === seamId);
    const piece = seam ? pattern?.pieces?.find((p) => p.id === seam.a.pieceId) : undefined;
    const name = piece?.name?.trim();
    return name ? `Seam · ${name}` : 'Seam';
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

  private projectEdge(vertices: readonly number[] | null): ClothEdgePoint[] | null {
    if (!vertices || vertices.length < 2) return null;
    const positions = this.options.getCloth()?.getPositionsSnapshot?.() ?? null;
    if (!positions) return null;
    const camera = this.options.getCamera();
    const points: ClothEdgePoint[] = [];
    for (const vi of vertices) {
      const point = this.projectVertex(vi, positions, camera);
      if (!point) return null;
      points.push(point);
    }
    return points.length >= 2 ? points : null;
  }
}
