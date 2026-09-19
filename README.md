# Cuttable3D

A browser-based tool for slicing 3D models into printable parts. Draw a line to cut, inspect pieces with real physics, then verify fit with an interactive puzzle mode.

## Features

**Cutting**
- Freehand straight-line cuts with automatic plane detection
- Optional snap-fit peg joints at cut faces
- Unlimited undo / redo (Ctrl+Z / Ctrl+Y)

**Physics**
- Rigid-body simulation — pieces fall, bounce, and can be picked up and thrown
- Orbit (right-drag) and zoom (scroll)

**Puzzle Mode**
- Ghost outlines mark where each piece belongs
- Drag pieces to snap them back into place
- Scroll to rotate on Y, Cmd+Scroll to rotate on X while dragging

**Extras**
- Isolation mode with transform gizmo for precise repositioning

## Tech Stack

| | |
|---|---|
| [Three.js](https://threejs.org) v0.179 | Rendering and post-processing |
| [Rapier](https://rapier.rs) 3D | WASM rigid-body physics |
| [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | Mesh boolean operations |
| [manifold-3d](https://github.com/elalish/manifold) | Manifold cap geometry |
| [Vite](https://vitejs.dev) | Build tooling |

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. A sample model loads automatically.

## License

MIT
