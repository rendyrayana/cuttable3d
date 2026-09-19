# Cuttable — Day-One Prototype Build Spec

## One-liner
A physics-based "cutting mat" game for splitting oversized 3D-print STLs into
printable, joinable pieces — Fruit Ninja meets a slicer's cut tool.

## Goal for today
Prove the core loop feels good and the pipeline holds together end to end:
**load → cut → fall → tidy → export.** Not a full game. Not multi-tool. One
straight cut, one joint type, one export button.

## Tech stack
- **Vite** — dev server / bundler
- **three.js** — rendering, scene graph
- **three-bvh-csg** — boolean mesh cutting (subtract/intersect on the loaded mesh)
- **STLLoader / STLExporter** (three.js examples) — import/export
- **Simple custom physics** for day one — gravity + AABB/ground-plane collision
  is enough to make pieces "fall" convincingly. Do NOT reach for rapier3d or
  cannon-es today; that's a stretch-goal swap-in, not a blocker.

## Scope — build exactly this, nothing more
1. **Cutting mat**: a flat plane/grid in the scene, camera looking down at an angle.
2. **Load one STL**: hardcode a sample model path for now (a simple printable
   object — e.g. a vase or bracket, not something already fragmented). Center
   and scale it to sit on the mat.
3. **Straight-line cut tool**:
   - Capture a 2D drag (mousedown → mousemove → mouseup, or touch equivalent).
   - Unproject drag start/end into 3D space using the camera.
   - Build a cutting plane from the drag line + camera view direction.
   - Run the boolean cut via three-bvh-csg, producing two separate mesh pieces.
4. **Physics (minimal)**: on cut, the two pieces separate slightly and fall
   under gravity until they hit the mat plane, then stop (no need for full
   rigid-body rotation/collision between pieces — settling flat is fine).
5. **Tidy-up**: pieces are draggable on the mat plane (simple pointer-drag,
   constrained to the mat's XZ plane) so the user can reposition them after
   they fall.
6. **One joint type — peg + socket**:
   - At the cut cross-section, generate a cylinder peg on one piece and a
     matching cylinder socket (boolean-subtracted hole) on the other.
   - Boolean-union the peg into its piece, boolean-subtract the socket from
     the other. Keep peg diameter/length as constants for now — no UI for it.
7. **Export**: a "Download STL" button per piece (or one button that zips/exports
   both) using STLExporter, triggering a browser download.

## Explicitly out of scope for today
- Multiple tools (knife/scissors/curved cuts) — architect the cut function so
  a "tool" is just a plane-generation strategy, but only implement one today.
- Dovetail or other non-cylindrical joints.
- Bin-packing / auto-arrange pieces to fit a print bed.
- Manifold repair / mesh cleanup for messy scanned input — assume a clean,
  watertight input STL for now.
- Joint-type picker UI, undo, multi-object scenes, mobile touch polish.

## Suggested file structure
```
/src
  main.js              # scene setup, render loop
  mat.js               # cutting mat plane + grid
  loadModel.js          # STL import, centering/scaling
  cut.js               # drag capture, plane math, CSG cut call
  joint.js             # peg/socket generation + boolean apply
  physics.js           # minimal gravity/fall/settle logic
  dragPiece.js          # post-fall tidy-up dragging
  exportStl.js          # STLExporter + download trigger
/public
  sample-model.stl
index.html
```

## Definition of done (today)
- [ ] STL loads and renders on the mat
- [ ] A single drag gesture produces a clean 2-piece cut via CSG
- [ ] Both pieces have a working peg/socket pair that visibly fits
- [ ] Pieces fall and settle on the mat after cutting
- [ ] Pieces can be dragged to reposition after falling
- [ ] Both pieces can be downloaded as valid, openable STL files (sanity-check
      by re-importing them into any slicer or STL viewer)

## Stretch goals (not today, but keep the architecture open for these)
- Additional tools: curved/scissor cuts, multi-segment knife cuts
- Joint picker (peg/socket, dovetail, snap-fit) with size controls
- Auto-arrange/tidy to fit a defined print-bed footprint
- Real physics engine (rapier3d) for tumbling/collision between pieces
- Mesh repair pass for non-manifold input (useful for 3D-scanned models)
