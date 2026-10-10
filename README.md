# patternCanvas

Browser-first open-canvas studio for **drafting garment patterns in real units** and **draping them with WebGPU cloth simulation**.

Pattern frames, remesh previews, Transform 3D layouts, and sim viewports live on one pannable board—wired together like a node graph. Designed for indie makers, students, hobbyists, and researchers who want inspectable physics and remixable studies—not a Marvelous Designer / CLO clone.

Product direction and architecture: **[docs/PRD.md](docs/PRD.md)**.

---

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

| Entry | What it is |
| --- | --- |
| `/` (`index.html`) | **patternCanvas studio** |
| [`demo.html`](demo.html) | Legacy cloth drop / wind playground |

### Requirements

- A WebGPU browser: **Chrome / Edge 113+**, Safari 18+ (WebGPU on), or a recent Firefox Nightly / supported build
- Desktop recommended for editing; WebGPU also works on many phones

If you see “WebGPU is not supported,” update the browser and confirm WebGPU is enabled.

---

## What you can do

### Canvas project
- Pan the board (Alt-drag empty space) · zoom with ⌘/Ctrl-wheel
- Add **Pattern**, **Mesh**, **Transform 3D**, **Sim**, notes, and image refs
- Wire **pattern → remesh → transform → drape**; wires show assignments
- Save / load / import projects from the **Projects** modal · undo / redo (⌘Z / ⌘⇧Z)
- Image refs (`+ Image`, paste, or drop) are stored with the project, so they come back on reload. An image whose stored bytes are gone shows a **Re-link image…** button on the node
- Duplicate a node with **⌘D** or **⌥-drag**
- Fullscreen a node (**⛶**); when wired, header **tabs** jump between Pattern / Remesh / Transform / Drape

### Pattern editor
- Move, and four rail menus: **Add** (pen, rectangle, circle, block library, SVG import), **Modify** (extrude, join, bridge), **Remove** (knife, dart) and **Sew** (segment, many-to-many), plus the Ruler · lengths in **cm or inches**
- Knife tools, under **Remove**: drag cutters (linear, circle), a **curve knife** that cuts along a chain you click down, and a **loop cut** that previews across the piece from any hovered outline, following the contours between it and the far side
- Join fuses two pieces along picked edges into one, moving/bending/scaling the first onto the second
- Bridge closes the gap between two pieces — or between two runs of one piece — with new straight edges, leaving the outlines exactly where they are
- Simplify a picked run of points: live reduce/fit preview, seam ends protected
- Soft snap, multi-select scale, avatar reference overlay, X-ray fill
- Seam bindings become sew constraints after remesh

### Mesh
- Remesh from the linked pattern (structured / Delaunay / centroidal settings in the inspector)

### Transform 3D
- Arrange pieces in space **before** simulating · pose feeds connected sims

### Sim (drape)
- **Play / Pause / Reset / Rebuild / Snapshot**
- Engines: **CPU mass-spring** or **GPU XPBD**
- Avatar body collision (load OBJ · optional SDF bake/cache under `refPpl/`)
- **Strain** map toggle (blue compress · green rest · red stretch)
- **Freeze a piece** — right-click it and choose *Freeze piece*; it holds its current pose while the rest drapes and across rebuilds, with its seams still pulling. Right-click again to *Unfreeze piece*
- One active sim at a time; paused sims keep their pose

### Viewport shading (sim + transform)
- The **shading button** in the top-right of a 3D viewport (left of the rotation gnomon) cycles
  **Wireframe** (edges only, no fill, ground and floor hidden) → **Simple** (the plain lit fabric, no
  environment) →
  **PBR** (GGX + image-based lighting, tone mapped), and the caret beside it opens the panel.
- **HDRI background / light probe**: pick any file from `hdri/` (1024×512 `.exr`, decoded in the browser),
  or *None* for a built-in neutral studio gradient. Decoded values are clamped into the half-float range
  before upload — a night HDRI in `hdri/` peaks at 4.2e5, which is 6× what an `rgba16float` texture can
  hold, and storing it as Inf makes the hardware return NaN through every filtered lookup, which shows
  up as the model dissolving into black-and-white static. The chosen map lights the fabric and paints the
  background in PBR mode. The file is a latlong `texture_2d` to every reader: the background unwraps it
  around the camera as a sphere, and the light-probe cubemap is baked from the *same* unwrap once at
  load (`src/render/latlong.ts` holds the single copy of the mapping, and `latlong.test.ts` checks both
  readers against the hardware cube sampling so the probe can never end up lit from the opposite
  hemisphere to the sky you can see).
- In **PBR** the floor becomes a cylinder of the floor's own radius, 12 inches tall, coloured as the
  reference model 25 % darker, and the collision reference mesh (avatar body, or the demo's sphere
  collider) is lit with the same environment instead of the flat shader.
- **Background blur** 50 % by default, 0–100 %, picks a level from a mip chain built once when the
  HDRI loads and samples it through a trilinear filter, so the defocus is continuous rather than a
  handful of repeated ghost taps. One fetch per pixel and the light probe is untouched.
- **Exposure** 0.20×–4.00× scales the HDRI background *and* the PBR shading, keeping the scene and the
  environment on the same stop, plus a **Show background** toggle. Simple and Wireframe never draw the
  environment, so switching modes cannot change how the pattern tools read.
- **Materials** (collapsed section of the same panel): colour, roughness and metallic for the
  **reference model** and the **cloth**. The **pedestal** always takes the reference colour 25 %
  darker — its swatch is read-only — while its roughness/metallic are its own. Colours are stored
  linear (the colour picker converts), so what you pick is what the PBR shader uses.
- Materials live in a shared library that the renderer asks per surface (`forPiece(pieceId)`); every
  piece uses the cloth material today, which is the single seam a future materials node after Remesh
  will use to hand out per-piece materials and textures.
- **Tonemapping** (second collapsed section of the same panel): *Reinhard*, *Uncharted 2*, *ACES*
  (default) or *Lottes* — the four operators from `~/Documents/Dev/pbr-webgpu`, ported verbatim into
  `src/shaders/tonemapping.wgsl`. All four are compiled into the PBR and background shaders and picked
  by an index in the shading uniforms, so switching is a buffer write and a redraw — no pipeline
  rebuild, and the background and the fabric always agree. ACES is the fallback arm of the shader
  switch, so a stored value the shader does not know keeps the original look.
- The mode, HDRI, blur, exposure, tonemapping and materials persist per browser (`localStorage`) and
  apply to every 3D viewport; a new viewport opens in **PBR**, the app's default look, or in whatever
  mode you last chose.

### Split view (2D + 3D at once)
- Open any stage fullscreen and click the **split toggle** between the *Pattern* and *Remesh* chips: the pattern editor fills the left pane and a 3D stage the right.
- The **Remesh / Transform / Drape** chips pick which 3D stage the right pane shows (splitting from a 3D view keeps that view on the right); the pattern stays on the left.
- Editing the pattern tints the 3D viewport's border amber and raises a **“Pattern changed — the 3D build is out of date”** banner just above that viewport's action buttons, with a **Resync 3D** button that remeshes and rebuilds the transforms and sims.
- **Piece selection mirrors both ways**: pick a piece in either pane and it is picked in the other. Leaving split (toggle again, or clicking the *Pattern* chip) returns to the single-node fullscreen.

---

## Controls (studio)

| Action | Input |
| --- | --- |
| Pan board | Alt-drag empty canvas |
| Zoom board | ⌘/Ctrl + wheel |
| Undo / Redo | ⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z |
| Duplicate node | ⌘/Ctrl+D · or ⌥/Alt-drag |
| Orbit 3D (sim / transform) | Drag empty space in the viewport |
| Move fabric | Drag the cloth (Play or paused) |
| Move points on one axis | Shift-drag a point/piece in the pattern editor |
| Select several panels | Move tool: ⌘-click (Ctrl on Windows/Linux) a panel to add it (⌘-click it again to drop it), or ⌘-drag a rectangle — the ⌘ rectangle takes whole panels it touches and never single points, so a plain drag still picks points and a Shift-drag still adds points |
| Add tools | **Add** (+) in the tool rail: the menu opens beside the rail with **Pen**, **Rectangle**, **Circle**, **Block…** and **Import SVG…** — **Block…** swaps the same menu over to the block library, with **‹ Add** to come back; **Import SVG…** opens the file picker and leaves the tool in hand alone |
| Insert a point on an edge | Move tool: ⌘-click (Ctrl on Windows/Linux) the edge — the point lands under the pointer and can be dragged on from there. The same modifier on a panel, away from its edges, picks the panel instead |
| Add a point | Add (+) → Pen: click a piece's outline (or anywhere inside a closed panel) — the point lands on the piece you clicked |
| Draw a panel | Add (+) → Pen: click empty canvas to start, keep clicking to add points, click the first point to close |
| Extrude an edge | **Modify** → **Extrude edge…**: drag away from any edge — the outline grows a parallel copy of it, joined back by two edges (hold Shift to lock the drag to an axis) |
| Curve knife | **Remove** → **Knife…** → **Curve**: click points down along the cut, adjust **Fit** / **Sew split** in the bar at the bottom of the viewport, then **Done** (or Enter) · **Cancel** / Esc / right-click throws it away |
| Loop cut | **Remove** → **Knife…** → **Loop (follow)** or **Loop (straight)**: hover a piece's outline, the cut previews square to the edge under the pointer, click to cut |
| Simplify points | Pick a run of points (Shift-click, or right-click the piece for all of them) → right-click → **Simplify points (n)**; then Reduce / Fit in the bar at the bottom of the viewport, **Done** or **Cancel** |
| Join two pieces | **Modify** → **Join…**: click the edges to fuse — the first piece picked moves onto the second — then **Fuse pieces** (or Enter) in the bar at the bottom of the viewport · **Swap sides** makes the other piece the one that moves · **Cancel** / Esc throws the picks away, and **Cancel** only comes alive once something has been picked |
| Join settings (tool settings popover) | **Modify** → **Join…** puts the join's settings in the popover at the top left of the canvas: **1:1** or **Many : many** edges, and **Move & scale** (the default) or **Warp**. **Move & scale** moves, turns and rescales the whole piece and leaves its outline alone, so the picked edges match only as well as their shapes allow: if the worst of them sits within the **Tolerance** (cm), the fuse goes ahead and whatever the two chains leave between them is filled in, the way a bridge fills between two runs; if it does not, the bar says how far apart they would have sat. **Warp** bends, stretches and turns the moving piece until its edges lie exactly on the other's, and has nothing left to fill |
| Join a run of edges (many to many) | **Modify** → **Join…** → **Many : many** in the tool settings: pick as many edges as you like on the piece that moves, then **Confirm edges →** (or Enter) and pick the run they fuse onto · two edges onto three, one onto four, whatever the seams are · along a boundary the two pieces share, where a click cannot say which piece it means, a click counts for the side being worked on — the moving piece's before **Confirm edges →**, the second piece's after · the button turns round to **← First side** once the picking has crossed over, so more edges can be added to either side without starting again |
| Bridge two pieces | **Modify** → **Bridge…**: click an edge on each piece — neither piece moves — then **Bridge pieces** (or Enter) in the bar at the bottom of the viewport · **Cancel** / Esc throws the picks away |
| Bridge a bay within one piece | **Modify** → **Bridge…**: click an edge on one side of a bay or notch and the edge across it — both on the same piece — then **Bridge pieces** (or Enter): the bay is filled and closed off with one straight edge, and the walls and the far side of it go interior |
| Bridge a run of edges (many to many) | **Modify** → **Bridge…** → **Edge runs (many)**: pick as many edges as you like on the first piece, then **Confirm edges →** (or Enter) and pick the run they bridge to · the button turns round to **← First side** once the picking has crossed over · a click on a boundary the two pieces share counts for the side being worked on, exactly as it does for a join |
| Split 2D + 3D | Split toggle between the Pattern and Remesh chips (fullscreen) |
| Aim a seam's direction | **Sew** → **Segment sewing** / **Many-to-many**: hover/click the half of the edge to read from (2D + 3D) |
| Preview the stitches | With one edge picked, hover a partner (2D + 3D) — dashed lines show the pairing |
| Reverse / delete a seam | Right-click a sewn edge (Sew edges on) → popover |
| Freeze / unfreeze a piece | Right-click the piece in the Sim viewport |
| Change shading (wireframe / simple / PBR) | Shading button, top-right of any 3D viewport |
| Pick an HDRI / blur it / set exposure / pick a tonemapper | Shading panel (caret next to the shading button) |
| Set material colour / roughness / metallic | Shading panel → Materials |
| Exit fullscreen | Esc or ✕ |

Pattern viewport: ⌘/Ctrl-wheel zooms the pattern; Alt-drag pans inside the editor.

Curve knife, in detail: click points down the way the pen draws them, and the chain through them is the cut. The panel it cuts is the one the chain is *drawn through* — the one it spends most of itself inside — so a cut never takes a panel beyond the end of the chain, or before its beginning, however the ends are carried on. Each end is carried out to that panel's outline along the direction the chain was going, drawn faintly and stopping at the edge, so a cut started in the middle still runs edge to edge instead of refusing to leave the inside; clicks that land near a point or an edge snap onto it, so a cut can be started exactly on a corner. **Fit** decides how the clicks are joined: **Smooth** bends through them, each point carrying one tangent read from its neighbours, and **Straight** joins them with plain edges. The bar names the panel the cut will take and how it will leave it — "Cuts Front panel A in two", "The cut has to cross … twice" — and **Done** is only offered when the cut really does cross the outline twice with panel left on both sides. **Sew split** welds the two halves back together along the cut: the cut's own edges are sewn to each other, so a piece can be divided for drafting — grainlines, seam allowance, a panel that is really two — while the cloth stays whole on the stand. Done commits as one undo step; Cancel, Escape or a right-click throws the draft away. ⌘/Ctrl+Z puts a cut back.

Join, in detail: pick the edges to fuse — one edge each, or whole runs with **Many : many** in the tool settings — and the first piece picked is brought onto the second: **Move & scale**, the default, moves, turns and rescales the whole piece until its edges match the other's within the **Tolerance**, filling whatever is left between the two chains the way a bridge fills between two runs, and **Warp** bends, stretches and turns it until the edges lie exactly on the other's. Many mode is many-to-many: each side takes a run of whole edges, the runs need not have the same number of edges or the same lengths, and each run is read off the outline in the order it was picked; **Confirm edges →** (or Enter) hands the picking over to the second piece — the button then reads **← First side** and hands it back, so either run can still be added to — which decides where a click on a *shared* boundary — two pieces laid along the same edge, or the two halves a knife left behind — belongs: before the hand-over such a click is the moving piece's, so a run along the shared edge can be picked, and after it the click is the second piece's. Warp's deform is a ribbon map: every point of the moving piece keeps its distance *along* its picked edges (as a share of their length) and its perpendicular offset, so the picked edges land exactly on the other piece's, the piece stretches along them by the ratio of their lengths, and the rest follows and bends with them. Points and handles both move, so a curve drawn into the moving piece keeps its shape and picks up the other piece's contour. Which way round the two chains meet is not asked of you: there are only two ways two outlines can share one boundary, and the one whose fused outline holds both pieces' area and keeps the moved piece whole is the one taken. Edges of the moving piece that had been sewn keep their seams — they are read at the point they became after the fuse — and so do seams on the second piece; seams along the two fused chains belonged to edges that no longer exist and go with them. A run that turns a corner harder than the piece is deep cannot be brought round without folding, and a fold is not a fuse: the bar says so and refuses ("pick a shorter run, or one that turns the same way") rather than hand back an outline the two pieces have been mangled into. The bar says what the fuse would do — which piece moves onto which, and *why not* when it cannot ("Those edges are not next to each other", "That join would fold the pieces onto each other") — and the outline it would make is ghosted in the viewport before anything is committed. **Fuse pieces** commits it as one undo step: the two pieces become one, keeping the second piece's name, and ⌘/Ctrl+Z puts them back.

Bridge, in detail: both runs may be on one piece, which is how a bay or a notch is filled: the two runs leave two arcs of its outline between them, a single straight edge is drawn across one of them, and the other arc goes interior with the runs, so the piece grows to hold what lay between them. Which arc that is depends on which way the runs face each other, so both are tried and the one that leaves the piece *bigger* than it was is the fill — the other is always just a cut-off piece of the outline, never a fill — and runs with no bay between them (a panel's bottom edge and its top edge, say) are refused with the reason. A bridge is otherwise a fuse where nothing moves. Pick the edges to span — one edge each with **Bridge · One edge each**, or whole runs with **Bridge · Edge runs (many)**, picked side at a time with **Confirm edges →** just as a join is — and the two picked runs are closed by a straight edge at each end, so the area in between becomes part of one piece with them. Every anchor and handle of both outlines comes through unchanged, and at the four joints the handles that used to run along the picked edges are squared off, because a bridge is a straight line where those edges were; the picked edges themselves are interior now and drop out of the outline. Which of the two runs meets which end of the other is not asked of you: as with a fuse there are only two ways round, both are tried, and the one whose outline does not cross itself is taken, whichever way the second piece happens to be wound. Bridging the two halves a knife left gives the panel they were cut from, with the joints that landed on the same spot folded into single vertices — seams that named them are read at the point they became. A bridge between runs that face away from each other, or to a piece that is already on top of another, would have to double the outline back on itself, and is refused with the reason rather than handed over as a shape nothing can be cut from ("That bridge would cross itself — pick runs that face each other"). The outline it would make is ghosted in the viewport first, and **Bridge pieces** commits it as one undo step, keeping the second piece's name; ⌘/Ctrl+Z puts both pieces back.

Loop cut, in detail: the cut enters square to the edge under the pointer and crosses the piece. **Loop (follow)** — the default — holds the pointer's own share of the way between the piece's two contours as it steps across, so a panel with parallel sides cuts straight, one whose sides curve together bends with them, and a tapering panel gets an evenly spaced cut. The walls it measures that share against are the contours *the cut runs between* — the ones roughly parallel to it — read at each step around where the cut already is, so a cut cannot be dragged outwards along the edge it is about to end on, or around a corner to a wall it should never have seen. It ends where it meets the boundary, which is usually the far side of the piece but not always: across a panel that tapers away, the cut is still on the panel after the edge normal has left it, and the trace follows it out to the edge it actually reaches. Slides sideways are capped and the traced line is faired, which keeps corners and notches in the outline as turns rather than spikes. **Loop (straight)** takes the plain chord. Either way the result is an ordinary cut: the piece splits, its seams remap, and ⌘/Ctrl+Z puts it back.

Undo / Redo restores the document only — views never move: 3D camera, 2D pattern zoom/pan, and the board's own pan/zoom all stay put.

Simplify points, in detail: hand-drawn curves arrive with dozens of anchors where the shape needs five, and a piece you have to edit point by point is easier to work with after they are thinned. Pick a run of points and the reduction is previewed live in the viewport — the outline really is rewritten as **Reduce** moves, so you are looking at the piece, not a sketch of it — and the bar says how many points are left ("24 → 9 points"), counting runs when the picks were not all in one stretch. **Reduce** is a share of the picked points: 0% keeps them all, 100% keeps the two that end the run (fewer, if the shape is simple enough to collapse). **Fit** decides what happens between the survivors: **Corner** draws straight edges; **Smooth** keeps the tangent the outline was drawn with at each survivor, reaching a third of the way to the next one, so a curve drawn through the run stays a curve and a corner stays a corner instead of being rounded off — the default matches what the run already was. **Done** commits it as one undo step; **Cancel**, Escape, or any fresh gesture on the canvas puts the points back. Nothing outside the run moves — not the neighbouring anchors, and not their handles, which belong to the edge before the run. Seam and dart ends are held onto whatever the reduction is asked for: a seam is an *edge* between two points, so dropping one of its ends would leave the stitching pointing at an outline that no longer has that edge.

---

## Project layout

```
src/
  app/           Studio shell (canvas, inspector, projects, undo)
  pattern/       2D pattern editor + geometry
  mesh/          Triangulation, OBJ/avatar, SDF bake
  sim/           Cloth engines (CPU + GPU XPBD), gizmos, viewports
  project/       Document model, library, undo stack
  shaders/       Cloth + floor WGSL
  styles/        studio.css
docs/PRD.md      Product requirements
refPpl/          Default avatar / SDF cache assets
demo.html        Legacy cloth demo
```

---

## Scripts

```bash
npm run dev       # Vite dev server
npm run build     # tsc + production build
npm run preview   # preview the build
```

---

## Notes

- Canonical units are **centimeters**; the toolbar toggles display to inches.
- Rebuild the mesh (and sim) after pattern or sew changes so topology stays in sync.
- Avatar SDF baking can write into `refPpl/` via the Vite dev API so you don’t rebake every session.

Legacy WebGPU cloth demos and GIFs from the earlier drop/wind playground remain available via [`demo.html`](demo.html).
