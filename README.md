# Cuttable3D

**Browser-based 3D model cutting tool.** Slice STL files with freehand gestures, inspect the cut pieces with real physics, and verify they reassemble correctly with an interactive puzzle mode.

Built for 3D printing prep: cut a model into printable pieces, check that they'll fit together, then export.

## Features

### Cutting
- **Freehand slice**: draw a straight line across the model to cut it; the cut plane is computed from your gesture
- **Joint pegs**: optionally add a snap peg at the cut face so pieces lock together when printed
- **Undo / Redo**: step back through any number of cuts (Ctrl+Z / Ctrl+Y)

### Physics
- Cut pieces fall and scatter with real rigid-body simulation (Rapier)
- **Pick up & throw**: drag a piece to reposition it; flick to toss
- Scroll to zoom, right-drag to orbit

### Puzzle mode
- Click **Puzzle** to enter reassembly mode
- Ghost outlines show where each piece belongs in the original assembled shape
- Drag pieces onto their ghosts and they snap into place when close enough
- Scroll while dragging to rotate piece around Y axis
- Cmd + scroll while dragging to rotate piece around X axis
- Timer + snapped-piece counter track your progress

### Isolation & transform
- Double-click a piece to isolate it; use the transform gizmo to reposition
- Exit isolation to return all pieces to the scene

## Tech Stack

| Library | Role |
|---|---|
| [Three.js](https://threejs.org) v0.179 | 3D rendering, post-processing (bloom, outline) |
| [Rapier](https://rapier.rs) 3D (WASM) | Rigid-body physics simulation |
| [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | Boolean mesh operations for cuts |
| [manifold-3d](https://github.com/elalish/manifold) | Robust manifold geometry for cap faces |
| [Vite](https://vitejs.dev) | Dev server & build tooling |

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

To build for production:

```bash
npm run build
# output: dist/
```

## Usage

1. The sample model loads automatically on launch.
2. **Cut**: left-drag across the model in a straight line.
3. **Move pieces**: left-drag on a piece to pick it up; release to drop.
4. **Add a joint peg**: while in *Pointer* mode, click the **Joint** tool, then click a cut face to place a peg.
5. **Puzzle**: click the puzzle-piece button to enter reassembly mode. Drag pieces onto their ghost outlines to snap them back.
6. **Undo**: Ctrl+Z to reverse any cut.

## Project Structure

```
src/
  main.js       scene setup, render loop, all input handling
  cut.js        plane calculation, CSG boolean, cap generation, peg joints
  physics.js    Rapier world init, body creation/removal, step+sync
  mat.js        ground mat mesh
  loadModel.js  STL loader, scaling and centering
public/
  sample-model.stl
```

## License

MIT
