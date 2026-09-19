# Cuttable3D

Browser-based 3D model cutting tool. Slice STL files with freehand gestures, inspect pieces with real physics, and verify they reassemble correctly with puzzle mode.

## Features

- Freehand slice with straight-line gestures
- Joint pegs at cut faces for snap-fit assembly
- Real rigid-body physics (pick up, throw, scatter)
- Puzzle mode: drag pieces onto ghost outlines to snap them back
- Scroll while dragging in puzzle mode to rotate pieces
- Undo / Redo (Ctrl+Z / Ctrl+Y)
- Isolation mode with transform gizmo

## Stack

- [Three.js](https://threejs.org) v0.179
- [Rapier](https://rapier.rs) 3D physics (WASM)
- [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg)
- [manifold-3d](https://github.com/elalish/manifold)
- [Vite](https://vitejs.dev)

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## License

MIT
