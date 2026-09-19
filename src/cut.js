/**
 * cut.js   plane generation + Manifold-based mesh splitting.
 *
 * Two responsibilities:
 *   1. straightLinePlane()   converts a screen drag into a THREE.Plane.
 *      Anchor is found by raycasting the drag against the actual piece geometry
 *      so the cut lands exactly where the user's cursor crosses the model.
 *   2. clipMeshByPlane()   splits a mesh using Manifold's trimByPlane().
 *      Output is guaranteed watertight / manifold   valid for 3-D printing.
 *
 * Call initCutter() (async) once before using clipMeshByPlane.
 */

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import ManifoldModule from 'manifold-3d';

const EPS = 1e-6;
let wasm = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initCutter() {
  wasm = await ManifoldModule({
    locateFile: (path) => path.endsWith('.wasm') ? import.meta.env.BASE_URL + 'manifold.wasm' : path,
  });
  wasm.setup();
}

// ── Plane from screen drag ────────────────────────────────────────────────────

/**
 * Build a cut plane from a screen-drag gesture.
 *
 * Normal    screen-perpendicular of the drag mapped through camera right/up,
 *           so a horizontal drag → vertical cut, vertical drag → horizontal cut.
 * Anchor    raycast the drag midpoint directly onto the piece geometry.
 *           Falls back to start/end midpoint, then camera-depth through model
 *           centre, so the plane always has a sensible position even if the
 *           cursor never touched any mesh.
 *
 * @param {object}        screenStart  {x, y} client coords
 * @param {object}        screenEnd    {x, y} client coords
 * @param {THREE.Camera}  camera
 * @param {HTMLElement}   canvasEl     renderer.domElement
 * @param {THREE.Mesh[]}  pieces       live piece array for raycasting
 */
export function straightLinePlane(screenStart, screenEnd, camera, canvasEl, pieces) {
  const rect = canvasEl.getBoundingClientRect();

  // ── Normal from drag direction ─────────────────────────────────────────────
  const sdx  = screenEnd.x - screenStart.x;
  const sdy  = screenEnd.y - screenStart.y;
  const slen = Math.sqrt(sdx * sdx + sdy * sdy);
  if (slen < 1) return null;

  const spx = -sdy / slen; // screen-perpendicular (90° CCW)
  const spy =  sdx / slen;

  const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const camUp    = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const normal   = camRight.clone()
    .multiplyScalar(spx)
    .addScaledVector(camUp, -spy)
    .normalize();

  // ── Anchor via raycast ─────────────────────────────────────────────────────
  function toNDC(sx, sy) {
    return new THREE.Vector2(
      (sx - rect.left) / rect.width  *  2 - 1,
      -((sy - rect.top) / rect.height) *  2 + 1,
    );
  }

  const ray = new THREE.Raycaster();
  let anchor = null;

  // 1. Midpoint of drag
  const midSx = (screenStart.x + screenEnd.x) / 2;
  const midSy = (screenStart.y + screenEnd.y) / 2;
  ray.setFromCamera(toNDC(midSx, midSy), camera);
  const midHits = pieces.length ? ray.intersectObjects(pieces, false) : [];
  if (midHits.length) {
    anchor = midHits[0].point.clone();
  }

  // 2. Average of start-hit and end-hit
  if (!anchor && pieces.length) {
    const r1 = new THREE.Raycaster(), r2 = new THREE.Raycaster();
    r1.setFromCamera(toNDC(screenStart.x, screenStart.y), camera);
    r2.setFromCamera(toNDC(screenEnd.x,   screenEnd.y),   camera);
    const h1 = r1.intersectObjects(pieces, false);
    const h2 = r2.intersectObjects(pieces, false);

    if (h1.length && h2.length) {
      anchor = h1[0].point.clone().add(h2[0].point).multiplyScalar(0.5);
    } else if (h1.length) {
      anchor = h1[0].point.clone();
    } else if (h2.length) {
      anchor = h2[0].point.clone();
    }
  }

  // 3. Last resort: camera-facing depth plane through model AABB centre
  if (!anchor) {
    const box = new THREE.Box3();
    for (const m of pieces) box.expandByObject(m);
    const modelCenter = box.isEmpty()
      ? new THREE.Vector3()
      : box.getCenter(new THREE.Vector3());
    const camFwd  = camera.getWorldDirection(new THREE.Vector3());
    const depthPl = new THREE.Plane().setFromNormalAndCoplanarPoint(camFwd, modelCenter);
    anchor        = new THREE.Vector3();
    ray.setFromCamera(toNDC(midSx, midSy), camera);
    if (!ray.ray.intersectPlane(depthPl, anchor)) anchor.copy(modelCenter);
  }

  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
}

// ── Quick plane-mesh intersection test ───────────────────────────────────────

/** Returns true if the plane has vertices on both sides of mesh (world space). */
export function planeSplitsMesh(mesh, plane) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position;
  const mat = mesh.matrixWorld;
  const tmp = new THREE.Vector3();
  let above = false, below = false;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(mat);
    const d = plane.distanceToPoint(tmp);
    if (d >  EPS) above = true;
    if (d < -EPS) below = true;
    if (above && below) return true;
  }
  return false;
}

// ── Mesh split ────────────────────────────────────────────────────────────────

/**
 * Split a mesh by plane. Tries Manifold first (watertight output); falls back
 * to robust triangle clipping + cap if Manifold cannot process the geometry.
 * Returns { above, below } as BufferGeometry in world space, or null for each
 * half if it has no triangles.
 */
export function clipMeshByPlane(mesh, plane) {
  mesh.updateMatrixWorld(true);

  // Try Manifold path first if wasm is ready
  if (wasm) {
    const result = _manifoldCut(mesh, plane);
    if (result) return result;
  }

  // Fallback: reliable triangle-clip + convex cap
  return _triangleClip(mesh, plane);
}

// ── Manifold path ─────────────────────────────────────────────────────────────

function _manifoldCut(mesh, plane) {
  const mat     = mesh.matrixWorld;
  const posAttr = mesh.geometry.attributes.position;
  const numVerts = posAttr.count;

  const tmp    = new THREE.Vector3();
  const rawXYZ = new Float32Array(numVerts * 3);
  for (let i = 0; i < numVerts; i++) {
    tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
    rawXYZ[i * 3]     = tmp.x;
    rawXYZ[i * 3 + 1] = tmp.y;
    rawXYZ[i * 3 + 2] = tmp.z;
  }

  // Weld coincident vertices so Manifold gets shared edges
  const tmpGeo = new THREE.BufferGeometry();
  tmpGeo.setAttribute('position', new THREE.BufferAttribute(rawXYZ, 3));
  if (mesh.geometry.index) {
    tmpGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.geometry.index.array), 1));
  }
  const mergedGeo = mergeVertices(tmpGeo, 1e-3);
  const worldXYZ  = new Float32Array(mergedGeo.attributes.position.array);
  const triVerts   = new Uint32Array(mergedGeo.index.array);

  let inputManifold;
  try {
    const m3d = new wasm.Mesh({ numProp: 3, vertProperties: worldXYZ, triVerts });
    inputManifold = new wasm.Manifold(m3d);
  } catch {
    return null; // not manifold   fall back to triangle clipping
  }

  const n = plane.normal;
  const d = plane.constant;

  let aboveM, belowM;
  try {
    aboveM = inputManifold.trimByPlane([n.x, n.y, n.z],    -d);
    belowM = inputManifold.trimByPlane([-n.x, -n.y, -n.z],  d);
  } catch {
    inputManifold.delete();
    return null;
  }

  const above = _manifoldToGeometry(aboveM);
  const below = _manifoldToGeometry(belowM);
  inputManifold.delete();
  aboveM.delete();
  belowM.delete();

  return { above, below };
}

function _manifoldToGeometry(manifold) {
  if (manifold.numTri() === 0) return null;
  const mesh    = manifold.getMesh();
  const np      = mesh.numProp;
  const nv      = mesh.vertProperties.length / np;
  let posArray;
  if (np === 3) {
    posArray = new Float32Array(mesh.vertProperties);
  } else {
    posArray = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      posArray[i * 3]     = mesh.vertProperties[i * np];
      posArray[i * 3 + 1] = mesh.vertProperties[i * np + 1];
      posArray[i * 3 + 2] = mesh.vertProperties[i * np + 2];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  geo.computeVertexNormals();
  return geo;
}

// ── Triangle-clip fallback ────────────────────────────────────────────────────
// Clips each triangle against the plane, then adds a convex polygon cap.

function _triangleClip(mesh, plane) {
  const mat     = mesh.matrixWorld;
  const posAttr = mesh.geometry.attributes.position;
  const index   = mesh.geometry.index;
  const numTris = index ? index.count / 3 : posAttr.count / 3;

  const aboveVerts = [];
  const belowVerts = [];
  const capPts     = []; // intersection points for the cap

  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  for (let t = 0; t < numTris; t++) {
    for (let c = 0; c < 3; c++) {
      const idx = index ? index.getX(t * 3 + c) : t * 3 + c;
      v[c].fromBufferAttribute(posAttr, idx).applyMatrix4(mat);
    }

    const d = [
      plane.distanceToPoint(v[0]),
      plane.distanceToPoint(v[1]),
      plane.distanceToPoint(v[2]),
    ];

    const above = d.map(x => x >= -EPS);

    if (above[0] && above[1] && above[2]) {
      pushTri(aboveVerts, v);
      continue;
    }
    if (!above[0] && !above[1] && !above[2]) {
      pushTri(belowVerts, v);
      continue;
    }

    // Mixed triangle   clip
    const inter = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (above[i] !== above[j]) {
        const t2 = d[i] / (d[i] - d[j]);
        const p = v[i].clone().lerp(v[j], t2);
        inter.push(p);
        capPts.push(p);
      }
    }

    // Determine which vertices go above / below and add sub-triangles
    const abV = v.filter((_, i) => above[i]);
    const blV = v.filter((_, i) => !above[i]);

    if (abV.length === 2) {
      // 2 above, 1 below
      pushTri(aboveVerts, [abV[0], abV[1], inter[0]]);
      pushTri(aboveVerts, [abV[1], inter[1], inter[0]]);
      pushTri(belowVerts, [blV[0], inter[0], inter[1]]);
    } else {
      // 1 above, 2 below
      pushTri(aboveVerts, [abV[0], inter[0], inter[1]]);
      pushTri(belowVerts, [blV[0], blV[1], inter[0]]);
      pushTri(belowVerts, [blV[1], inter[1], inter[0]]);
    }
  }

  // Add convex cap to both sides
  if (capPts.length >= 3) {
    const capFlat = _convexCap(capPts, plane.normal);
    if (capFlat) {
      // Above cap: triangles as-is
      for (const v of capFlat) aboveVerts.push(v);
      // Below cap: reversed winding (each triangle's 3 verts swapped)
      for (let i = 0; i < capFlat.length; i += 9) {
        belowVerts.push(
          capFlat[i+6], capFlat[i+7], capFlat[i+8],
          capFlat[i+3], capFlat[i+4], capFlat[i+5],
          capFlat[i+0], capFlat[i+1], capFlat[i+2],
        );
      }
    }
  }

  return {
    above: aboveVerts.length ? _arrToGeo(aboveVerts) : null,
    below: belowVerts.length ? _arrToGeo(belowVerts) : null,
  };
}

function pushTri(arr, pts) {
  for (const p of pts) { arr.push(p.x, p.y, p.z); }
}

function _arrToGeo(arr) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
  geo.computeVertexNormals();
  return geo;
}

// ── Joint peg/socket generation ───────────────────────────────────────────────

/**
 * Add a male peg to aboveGeo and cut a female socket from belowGeo.
 * Both geometries must be in world space (as returned by clipMeshByPlane).
 * Returns { above, below } as new BufferGeometries.
 */
export function applyJoint(aboveGeo, belowGeo, plane, worldPos,
                           pegRadius = 1.8, pegHeight = 5.0) {
  if (!wasm) return { above: aboveGeo, below: belowGeo };
  let aboveM = null, belowM = null, pegCyl = null, sockCyl = null;
  let aboveResult = null, belowResult = null;
  try {
    aboveM = _geoToManifold(aboveGeo);
    belowM = _geoToManifold(belowGeo);
    if (!aboveM || !belowM) return { above: aboveGeo, below: belowGeo };

    pegCyl  = _cylinderAtPlane(plane.normal, worldPos, pegRadius,        pegHeight);
    sockCyl = _cylinderAtPlane(plane.normal, worldPos, pegRadius + 0.10, pegHeight);

    aboveResult = aboveM.add(pegCyl);
    belowResult = belowM.subtract(sockCyl);

    const above = _manifoldToGeometry(aboveResult) ?? aboveGeo;
    const below = _manifoldToGeometry(belowResult) ?? belowGeo;
    return { above, below };
  } catch (e) {
    console.warn('applyJoint:', e);
    return { above: aboveGeo, below: belowGeo };
  } finally {
    for (const m of [aboveM, belowM, pegCyl, sockCyl, aboveResult, belowResult]) {
      if (m) try { m.delete(); } catch {}
    }
  }
}

function _geoToManifold(geo) {
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', geo.attributes.position.clone());
  if (geo.index) tmp.setIndex(geo.index.clone());
  const merged = mergeVertices(tmp, 1e-3);
  if (!merged.index || !merged.index.count) return null;
  try {
    const m3d = new wasm.Mesh({
      numProp:        3,
      vertProperties: new Float32Array(merged.attributes.position.array),
      triVerts:       new Uint32Array(merged.index.array),
    });
    return new wasm.Manifold(m3d);
  } catch { return null; }
}

function _cylinderAtPlane(normal, worldPos, radius, height) {
  // Cylinder defaults: axis=Z, from Z=0 to Z=height
  // Rotate Z→normal, translate so the cylinder is centred on the cut plane at worldPos
  const cyl = wasm.Manifold.cylinder(height, radius, radius, 24);
  const n = normal.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  // Place base at worldPos - n*(height/2) so the midpoint is at worldPos
  m.elements[12] = worldPos.x - n.x * height * 0.5;
  m.elements[13] = worldPos.y - n.y * height * 0.5;
  m.elements[14] = worldPos.z - n.z * height * 0.5;
  return cyl.transform(Array.from(m.elements));
}

/** Project cap points onto the plane, compute convex hull order, fan-triangulate. */
function _convexCap(points, planeNormal) {
  // Build a local 2D frame on the cut plane
  const n   = planeNormal.clone().normalize();
  const up  = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u   = new THREE.Vector3().crossVectors(up, n).normalize();
  const v2  = new THREE.Vector3().crossVectors(n, u).normalize();

  // Project to 2D
  const centroid3 = new THREE.Vector3();
  points.forEach(p => centroid3.add(p));
  centroid3.divideScalar(points.length);

  const pts2d = points.map(p => {
    const r = p.clone().sub(centroid3);
    return { x: r.dot(u), y: r.dot(v2), p3: p };
  });

  // Sort by angle (convex hull order for reasonably convex cuts)
  pts2d.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));

  // Fan triangulate from centroid
  const tris = [];
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i];
    const b = pts2d[(i + 1) % pts2d.length];
    tris.push(centroid3.x, centroid3.y, centroid3.z);
    tris.push(a.p3.x, a.p3.y, a.p3.z);
    tris.push(b.p3.x, b.p3.y, b.p3.z);
  }
  return tris;
}
