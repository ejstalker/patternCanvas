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
- Duplicate a node with **⌘D** or **⌥-drag**
- Fullscreen a node (**⛶**); when wired, header **tabs** jump between Pattern / Remesh / Transform / Drape

### Pattern editor
- Move, Pen, Bend, Dart, Sew tools · lengths in **cm or inches**
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
| Aim a seam's direction | Sew tool: hover/click the half of the edge to read from (2D + 3D) |
| Preview the stitches | With one edge picked, hover a partner (2D + 3D) — dashed lines show the pairing |
| Reverse / delete a seam | Right-click a sewn edge (Sew edges on) → popover |
| Freeze / unfreeze a piece | Right-click the piece in the Sim viewport |
| Exit fullscreen | Esc or ✕ |

Pattern viewport: ⌘/Ctrl-wheel zooms the pattern; Alt-drag pans inside the editor.

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
