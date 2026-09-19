/**
 * main.js   scene setup, render loop, unified input handling.
 *
 * Input scheme:
 *   Left-drag on empty space / mat → cut gesture
 *   Left-drag on a piece           → lift + reposition (release to throw)
 *   Right-drag                     → orbit camera
 *   Scroll                         → zoom
 */

import * as THREE from 'three';
import { OrbitControls }      from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls }  from 'three/examples/jsm/controls/TransformControls.js';
import { STLLoader }        from 'three/examples/jsm/loaders/STLLoader.js';
import { EffectComposer }   from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass }      from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass }       from 'three/examples/jsm/postprocessing/OutputPass.js';

import { createMat }                              from './mat.js';
import { loadModel }                              from './loadModel.js';
import { initCutter, straightLinePlane, planeSplitsMesh, clipMeshByPlane, applyJoint } from './cut.js';
import {
  initPhysics,
  createPhysicsBody,
  removePhysicsBody,
  startCarrying,
  stopCarrying,
  setCarryPosition,
  setLinearVelocity,
  setAngularVelocity,
  getLinearVelocity,
  stepAndSync,
  freezeBody,
  unfreezeBody,
} from './physics.js';

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d18);
scene.fog = new THREE.FogExp2(0x0d0d18, 0.004);

// ── Camera ────────────────────────────────────────────────────────────────────
const perspCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
perspCamera.position.set(0, 70, 90);
perspCamera.lookAt(0, 0, 0);

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);

let camera     = perspCamera;
let isOrthoView = false;

// ── Lights ────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.60));

const sun = new THREE.DirectionalLight(0xffeedd, 0.9);
sun.position.set(60, 110, 60);
sun.castShadow = true;
sun.shadow.intensity  = 0.55;   // softer shadow darkness
sun.shadow.bias       = -0.0004;
sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.mapSize, { width: 2048, height: 2048 });
Object.assign(sun.shadow.camera, { near: 1, far: 400, left: -120, right: 120, top: 120, bottom: -120 });
scene.add(sun);

const fill = new THREE.DirectionalLight(0xaaccff, 0.3);
fill.position.set(-40, 30, -40);
scene.add(fill);

// ── Post-processing ───────────────────────────────────────────────────────────
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.38,   // strength
  0.55,   // radius
  0.72,   // threshold   only bright highlights bloom
);
composer.addPass(bloomPass);

const outlinePass = new OutlinePass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  scene,
  camera,
);
outlinePass.edgeStrength  = 1.8;
outlinePass.edgeGlow      = 0.15;
outlinePass.edgeThickness = 0.7;
outlinePass.pulsePeriod   = 0;
outlinePass.visibleEdgeColor.set('#00eeff');
outlinePass.hiddenEdgeColor.set('#003344');
composer.addPass(outlinePass);

composer.addPass(new OutputPass());

// ── Orbit controls (right-click + scroll, middle-click pan) ──────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.enableDamping  = true;
controls.dampingFactor  = 0.06;
controls.minDistance    = 20;
controls.maxDistance    = 300;
controls.maxPolarAngle  = Math.PI / 2.05;

const PAN_LIMIT = 80;

// ── Transform gizmo ───────────────────────────────────────────────────────────
const transformCtrl = new TransformControls(camera, renderer.domElement);
transformCtrl.setSize(0.8);
const transformHelper = transformCtrl.getHelper();
transformHelper.visible = false;
scene.add(transformHelper);
// While dragging the gizmo, disable orbit
transformCtrl.addEventListener('dragging-changed', e => {
  controls.enabled = !e.value;
});
let transformTarget = null; // the piece currently attached to the gizmo

function _attachTransform(mesh) {
  if (transformTarget === mesh) return;
  if (transformTarget) _detachTransform();
  transformTarget = mesh;
  const pbody = bodiesMap.get(mesh);
  if (pbody) startCarrying(pbody); // makes body kinematic so physics doesn't fight
  transformCtrl.attach(mesh);
  transformHelper.visible = true;
}
function _detachTransform() {
  if (transformTarget) {
    const pbody = bodiesMap.get(transformTarget);
    if (pbody) {
      const p = transformTarget.position;
      const q = transformTarget.quaternion;
      stopCarrying(pbody, null, null);
      pbody.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      pbody.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    }
  }
  transformTarget = null;
  transformCtrl.detach();
  transformHelper.visible = false;
}
// Sync kinematic body every frame while transform tool is active
function _syncTransformBody() {
  if (!transformTarget) return;
  const pbody = bodiesMap.get(transformTarget);
  if (!pbody?.body) return;
  const p = transformTarget.position;
  const q = transformTarget.quaternion;
  pbody.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
  pbody.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
}

// ── Projection toggle ─────────────────────────────────────────────────────────
function _updateOrthoFrustum() {
  const dist   = camera.position.distanceTo(controls.target);
  const fovRad = THREE.MathUtils.degToRad(perspCamera.fov);
  const h      = 2 * Math.tan(fovRad / 2) * dist;
  const aspect = window.innerWidth / window.innerHeight;
  orthoCamera.left   = -h * aspect / 2;
  orthoCamera.right  =  h * aspect / 2;
  orthoCamera.top    =  h / 2;
  orthoCamera.bottom = -h / 2;
  orthoCamera.updateProjectionMatrix();
}

function toggleProjection() {
  const target = controls.target.clone();

  if (!isOrthoView) {
    orthoCamera.position.copy(perspCamera.position);
    orthoCamera.quaternion.copy(perspCamera.quaternion);
    _updateOrthoFrustum();
    camera = orthoCamera;
    isOrthoView = true;
  } else {
    perspCamera.position.copy(orthoCamera.position);
    perspCamera.quaternion.copy(orthoCamera.quaternion);
    perspCamera.updateProjectionMatrix();
    camera = perspCamera;
    isOrthoView = false;
  }

  controls.object = camera;
  controls.target.copy(target);
  controls.update();
  composer.passes[0].camera = camera;
  outlinePass.renderCamera  = camera;

  document.getElementById('proj-btn').textContent = isOrthoView ? 'ORTHO' : 'PERSP';
}

document.getElementById('proj-btn').addEventListener('click', toggleProjection);

// ── Mat ───────────────────────────────────────────────────────────────────────
createMat(scene);

// ── UI refs ───────────────────────────────────────────────────────────────────
const statusEl       = document.getElementById('status');
const hintsEl        = document.getElementById('hints');
const HINTS_DEFAULT  = hintsEl.textContent;
const noticeEl       = document.getElementById('notice');
const cutCountEl     = document.getElementById('cut-count');
const pieceCountEl   = document.getElementById('piece-count');

let _noticeTimer = null;
function showNotice(msg, duration = 3500) {
  noticeEl.textContent = msg;
  noticeEl.classList.add('show');
  clearTimeout(_noticeTimer);
  _noticeTimer = setTimeout(() => noticeEl.classList.remove('show'), duration);
}
const feedbackEl     = document.getElementById('feedback');
const feedbackTextEl = document.getElementById('feedback-text');
const feedbackSubEl  = document.getElementById('feedback-sub');
const overlayCanvas  = document.getElementById('cut-overlay');
const ctx            = overlayCanvas.getContext('2d');
overlayCanvas.width  = window.innerWidth;
overlayCanvas.height = window.innerHeight;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

// ── App state ─────────────────────────────────────────────────────────────────
const pieces    = [];        // all current THREE.Mesh objects
const bodiesMap = new Map(); // Mesh → PhysicsBody

const PIECE_COLORS = [0x5588cc, 0xcc8844, 0x44bb88, 0xbb4477, 0x8888cc, 0xddaa55, 0x55ccbb, 0xee7733];
let colorCursor = 0;

function nextMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color:       PIECE_COLORS[colorCursor % PIECE_COLORS.length],
    roughness:   0.92,
    metalness:   0.0,
    flatShading: true,
    side:        THREE.DoubleSide,
  });
  colorCursor++;
  return mat;
}

function addPiece(mesh, body) {
  // Only set assembly position if the cut code hasn't already corrected it for drift
  if (!mesh.userData.assemblyPos)  mesh.userData.assemblyPos  = mesh.position.clone();
  if (!mesh.userData.assemblyQuat) mesh.userData.assemblyQuat = mesh.quaternion.clone();
  pieces.push(mesh);
  bodiesMap.set(mesh, body);
  scene.add(mesh);
}

function removePiece(mesh) {
  const idx = pieces.indexOf(mesh);
  if (idx !== -1) pieces.splice(idx, 1);
  const body = bodiesMap.get(mesh);
  removePhysicsBody(body);
  bodiesMap.delete(mesh);
  scene.remove(mesh);
}

function allPiecesCenter() {
  if (!pieces.length) return new THREE.Vector3();
  const box = new THREE.Box3();
  for (const m of pieces) box.expandByObject(m);
  return box.getCenter(new THREE.Vector3());
}

// ── Cut mode & joint placement ────────────────────────────────────────────────
let cutMode   = 'flat'; // 'flat' | 'joint'
let jointState = null;  // active placement session

const PEG_RADIUS = 1.8;
const PEG_HEIGHT = 5.0;

document.getElementById('mode-flat').addEventListener('click', () => {
  cutMode = 'flat';
  document.getElementById('mode-flat').classList.add('active');
  document.getElementById('mode-joint').classList.remove('active');
});
document.getElementById('mode-joint').addEventListener('click', () => {
  cutMode = 'joint';
  document.getElementById('mode-joint').classList.add('active');
  document.getElementById('mode-flat').classList.remove('active');
});

function _capBoundary(worldGeo, plane) {
  const EPS = 1.2;
  const pos = worldGeo.attributes.position;
  const pts = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    if (Math.abs(plane.distanceToPoint(tmp)) < EPS) pts.push(tmp.clone());
  }
  if (pts.length < 3) return null;

  const centroid = new THREE.Vector3();
  pts.forEach(p => centroid.add(p));
  centroid.divideScalar(pts.length);

  // Build 2D frame on the plane
  const n    = plane.normal.clone().normalize();
  const uRef = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
  const uAxis = new THREE.Vector3().crossVectors(uRef, n).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  const pts2D = pts.map(p => {
    const r = p.clone().sub(centroid);
    return [r.dot(uAxis), r.dot(vAxis)];
  });

  // Convex hull via gift wrapping (Jarvis march) so interior CSG vertices don't shrink the boundary
  function cross2D(o, a, b) { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
  let start = 0;
  for (let i = 1; i < pts2D.length; i++) if (pts2D[i][0] < pts2D[start][0]) start = i;
  const hull = [];
  let current = start;
  do {
    hull.push(pts2D[current]);
    let next = 0;
    for (let i = 1; i < pts2D.length; i++) {
      if (next === current || cross2D(pts2D[current], pts2D[next], pts2D[i]) < 0) next = i;
    }
    current = next;
  } while (current !== start && hull.length <= pts2D.length);

  // Inscribed circle: min distance from centroid to any hull edge
  let minEdgeDist = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 0.01) continue;
    const dist = Math.abs(a[0]*dy - a[1]*dx) / len;
    minEdgeDist = Math.min(minEdgeDist, dist);
  }

  return { centroid, inscribedRadius: minEdgeDist === Infinity ? 6 : minEdgeDist, uAxis, vAxis };
}

function _startJoint(pair) {
  const { meshA, bodyA, meshB, bodyB, aboveGeoWorld, belowGeoWorld, plane } = pair;
  const cap = _capBoundary(aboveGeoWorld, plane);
  const pos = (cap ? cap.centroid : meshA.position).clone();
  const pegH = PEG_HEIGHT;

  // Make both pieces see-through during placement
  for (const m of [meshA, meshB]) {
    m.material.transparent = true;
    m.material.opacity = 0.22;
    m.material.depthWrite = false;
  }

  const previewMat = new THREE.MeshStandardMaterial({
    color: 0xffdd00, transparent: true, opacity: 0.65,
    emissive: 0xffaa00, emissiveIntensity: 0.4,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const pegRadius = PEG_RADIUS;
  const previewMesh = new THREE.Mesh(new THREE.CylinderGeometry(pegRadius, pegRadius, pegH, 24), previewMat);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), plane.normal.clone().normalize());
  previewMesh.quaternion.copy(q);
  previewMesh.position.copy(pos);
  scene.add(previewMesh);

  jointState = { plane, meshA, bodyA, meshB, bodyB,
                 aboveGeoWorld, belowGeoWorld, pos, cap, previewMesh, pegH, pegRadius };
  controls.enableZoom = true;
  renderer.domElement.addEventListener('wheel', _onJointWheel, { passive: false, capture: true });
  hintsEl.textContent = 'move = position  ·  shift = center  ·  scroll = zoom  ·  cmd+scroll = length  ·  cmd+shift+scroll = width  ·  click = confirm  ·  Esc = skip';
  setStatus('JOINT PLACEMENT');
}

function _onJointWheel(e) {
  if (!jointState || !e.metaKey) return; // plain scroll: let it fall through to OrbitControls
  e.preventDefault();
  e.stopPropagation(); // block OrbitControls from zooming on cmd+scroll
  const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX; // Shift+scroll on Mac flips axis
  const dir = raw > 0 ? -1 : 1;
  if (e.shiftKey) {
    _adjustJointRadius(dir * 0.3);
  } else {
    _adjustJointLength(dir * 1.5);
  }
}

function _restoreOpacity() {
  if (!jointState) return;
  for (const m of [jointState.meshA, jointState.meshB]) {
    m.material.transparent = false;
    m.material.opacity = 1;
    m.material.depthWrite = true;
  }
}

function _updateJointPos(sx, sy, snapToCenter) {
  if (!jointState) return;

  if (snapToCenter && jointState.cap) {
    jointState.pos = jointState.cap.centroid.clone();
    jointState.previewMesh.position.copy(jointState.pos);
    return;
  }

  raycaster.setFromCamera(getNDC(sx, sy), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(jointState.plane, hit)) return;

  const { cap, pegRadius } = jointState;
  if (cap) {
    const offset = hit.clone().sub(cap.centroid);
    const maxR = Math.max(0, cap.inscribedRadius - pegRadius - 0.4);
    if (offset.length() > maxR) offset.setLength(maxR);
    hit.copy(cap.centroid).add(offset);
  }
  jointState.pos = hit;
  jointState.previewMesh.position.copy(hit);
}

function _rebuildPreviewGeo() {
  const { previewMesh, pegRadius, pegH } = jointState;
  previewMesh.geometry.dispose();
  previewMesh.geometry = new THREE.CylinderGeometry(pegRadius, pegRadius, pegH, 24);
}

function _adjustJointLength(delta) {
  if (!jointState) return;
  jointState.pegH = Math.max(2, Math.min(40, jointState.pegH + delta));
  _rebuildPreviewGeo();
}

function _adjustJointRadius(delta) {
  if (!jointState) return;
  jointState.pegRadius = Math.max(0.5, Math.min(10, jointState.pegRadius + delta));
  // Clamp position to new radius constraint
  if (jointState.cap) {
    const offset = jointState.pos.clone().sub(jointState.cap.centroid);
    const maxR = Math.max(0, jointState.cap.inscribedRadius - jointState.pegRadius - 0.4);
    if (offset.length() > maxR) offset.setLength(maxR);
    jointState.pos = jointState.cap.centroid.clone().add(offset);
    jointState.previewMesh.position.copy(jointState.pos);
  }
  _rebuildPreviewGeo();
}

function _confirmJoint() {
  if (!jointState) return;
  _restoreOpacity();
  const { plane, meshA, bodyA, meshB, bodyB, aboveGeoWorld, belowGeoWorld, pos, pegH, pegRadius, previewMesh } = jointState;
  jointState = null;

  scene.remove(previewMesh);
  previewMesh.geometry.dispose();
  previewMesh.material.dispose();

  setStatus('Building joint…');

  const { above: newAbove, below: newBelow } = applyJoint(aboveGeoWorld, belowGeoWorld, plane, pos, pegRadius, pegH);

  // Grab saved positions before removing
  const posA = meshA.position.clone(), quatA = meshA.quaternion.clone();
  const posB = meshB.position.clone(), quatB = meshB.quaternion.clone();
  const matA = meshA.material, matB = meshB.material;

  removePiece(meshA);
  removePiece(meshB);
  aboveGeoWorld.dispose();
  belowGeoWorld.dispose();

  // Rebuild above piece
  const newMeshA = new THREE.Mesh(newAbove, matA);
  newMeshA.castShadow = true;
  const newBodyA = createPhysicsBody(newMeshA);
  const nA = plane.normal;
  newBodyA.body.setTranslation({ x: posA.x, y: posA.y, z: posA.z }, true);
  newBodyA.body.setRotation({ x: quatA.x, y: quatA.y, z: quatA.z, w: quatA.w }, true);
  newBodyA.body.setLinvel({ x: nA.x*5, y: 4, z: nA.z*5 }, true);
  newBodyA.body.setAngvel({ x: (Math.random()-0.5)*6, y: (Math.random()-0.5)*3, z: (Math.random()-0.5)*6 }, true);
  addPiece(newMeshA, newBodyA);

  // Rebuild below piece
  const newMeshB = new THREE.Mesh(newBelow, matB);
  newMeshB.castShadow = true;
  const newBodyB = createPhysicsBody(newMeshB);
  newBodyB.body.setTranslation({ x: posB.x, y: posB.y, z: posB.z }, true);
  newBodyB.body.setRotation({ x: quatB.x, y: quatB.y, z: quatB.z, w: quatB.w }, true);
  newBodyB.body.setLinvel({ x: -nA.x*5, y: 4, z: -nA.z*5 }, true);
  newBodyB.body.setAngvel({ x: (Math.random()-0.5)*6, y: (Math.random()-0.5)*3, z: (Math.random()-0.5)*6 }, true);
  addPiece(newMeshB, newBodyB);

  controls.enabled = true;
  controls.enableZoom = true;
  renderer.domElement.removeEventListener('wheel', _onJointWheel, { capture: true });
  hintsEl.textContent = TOOL_HINTS[currentTool] ?? HINTS_DEFAULT;
  setStatus(`${pieces.length} pieces · joint applied`);
}

function _cancelJoint() {
  if (!jointState) return;
  _restoreOpacity();
  const { plane, bodyA, bodyB, previewMesh, aboveGeoWorld, belowGeoWorld } = jointState;
  jointState = null;

  scene.remove(previewMesh);
  previewMesh.geometry.dispose();
  previewMesh.material.dispose();
  aboveGeoWorld.dispose();
  belowGeoWorld.dispose();

  const n = plane.normal;
  unfreezeBody(bodyA, new THREE.Vector3(n.x*5, 4, n.z*5),
               new THREE.Vector3((Math.random()-0.5)*8, 0, (Math.random()-0.5)*8));
  unfreezeBody(bodyB, new THREE.Vector3(-n.x*5, 4, -n.z*5),
               new THREE.Vector3((Math.random()-0.5)*8, 0, (Math.random()-0.5)*8));

  controls.enabled = true;
  controls.enableZoom = true;
  renderer.domElement.removeEventListener('wheel', _onJointWheel, { capture: true });
  hintsEl.textContent = TOOL_HINTS[currentTool] ?? HINTS_DEFAULT;
}

// ── Reconstruction (Puzzle) Mode ─────────────────────────────────────────────

const SNAP_POS = 14;  // world units — generous so proximity snap feels natural
const SNAP_ROT = 1.2; // radians (~69°) — enough to ignore minor carry rotation

const recon = {
  active: false,
  armed: false,   // true after first click — assembly positions locked, waiting for second click
  targets: [],   // {mesh, pos, quat, origColor, snapped, ghost, labelPiece, labelGhost}
  startTime: null,
  elapsed: 0,
  helpCount: 0,
  helpVisible: false,
  allSnapped: false,
};

function _reconDifficulty(n) {
  if (n <= 3)  return { label: 'EASY',   color: '#55dd88' };
  if (n <= 6)  return { label: 'MEDIUM', color: '#ddcc44' };
  if (n <= 10) return { label: 'HARD',   color: '#ee8844' };
  return              { label: 'CHAOS',  color: '#ff5555' };
}

function _quatAngle(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
}

function enterReconMode() {
  if (recon.active || pieces.length < 2) return;

  if (isolatedMesh) exitIsolate(false);
  setTool('pointer');

  // Teleport every piece to its stored assembly position so we capture a
  // guaranteed-correct assembled snapshot — this also lets the user see the
  // goal shape briefly before scatter.
  pieces.forEach(mesh => {
    const aPos  = mesh.userData.assemblyPos  ?? mesh.position;
    const aQuat = mesh.userData.assemblyQuat ?? mesh.quaternion;
    mesh.position.copy(aPos);
    mesh.quaternion.copy(aQuat);
    const pbody = bodiesMap.get(mesh);
    if (pbody) {
      freezeBody(pbody);
      pbody.body.setTranslation({ x: aPos.x, y: aPos.y, z: aPos.z }, true);
      pbody.body.setRotation({ x: aQuat.x, y: aQuat.y, z: aQuat.z, w: aQuat.w }, true);
    }
  });

  recon.targets = pieces.map(mesh => ({
    mesh,
    pos:  mesh.position.clone(),   // pieces are now at assembly positions
    quat: mesh.quaternion.clone(),
    origColor: mesh.material.color.clone(),
    snapped: false,
    ghost: null,
    labelPiece: null,
    labelGhost: null,
  }));

  // Ghost meshes at target positions
  recon.targets.forEach(t => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6688ff, transparent: true, opacity: 0.13,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const ghost = new THREE.Mesh(t.mesh.geometry, mat);
    ghost.position.copy(t.pos);
    ghost.quaternion.copy(t.quat);
    ghost.scale.copy(t.mesh.scale);
    scene.add(ghost);
    t.ghost = ghost;
  });

  // Floating number labels
  recon.targets.forEach((t, i) => {
    const lp = document.createElement('div');
    lp.className = 'recon-label recon-label-piece';
    lp.textContent = i + 1;
    document.body.appendChild(lp);
    t.labelPiece = lp;

    const lg = document.createElement('div');
    lg.className = 'recon-label recon-label-ghost';
    lg.textContent = i + 1;
    document.body.appendChild(lg);
    t.labelGhost = lg;
  });

  recon.active     = true;
  recon.startTime  = null;
  recon.elapsed    = 0;
  recon.helpCount  = 0;
  recon.helpVisible = false;
  recon.allSnapped  = false;

  const diff = _reconDifficulty(pieces.length);
  document.getElementById('recon-difficulty').textContent  = diff.label;
  document.getElementById('recon-difficulty').style.color  = diff.color;
  document.getElementById('recon-progress').textContent    = `0 / ${pieces.length}`;
  document.getElementById('recon-timer').textContent       = '0.0s';
  document.getElementById('recon-help-btn').classList.remove('active');
  document.getElementById('recon-hud').classList.add('show');
  document.getElementById('recon-complete').classList.remove('show');

  // Disable tool switching and cut tools while in recon
  document.getElementById('right-toolbar').style.pointerEvents = 'none';
  document.getElementById('right-toolbar').style.opacity = '0.3';

  hintsEl.textContent = 'drag = move piece  ·  scroll while dragging = rotate Y  ·  cmd+scroll = rotate X  ·  right-drag = orbit';

  setTimeout(_scatterPieces, 700);

  renderer.domElement.addEventListener('wheel', _onReconWheel, { passive: false, capture: true });
}

function _onReconWheel(e) {
  if (!recon.active || inputMode !== 'drag-piece' || !dragBody) return;
  e.preventDefault();
  e.stopPropagation();
  const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
  const angle = raw > 0 ? -0.18 : 0.18;
  const axis = e.metaKey ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  dragBody.mesh.quaternion.premultiply(spin);
  dragBody.body.setNextKinematicRotation(dragBody.mesh.quaternion);
}

function _scatterPieces() {
  const center = new THREE.Vector3();
  recon.targets.forEach(t => center.add(t.mesh.position));
  center.divideScalar(recon.targets.length);

  recon.targets.forEach(t => {
    t.snapped = false;
    t.mesh.material.color.copy(t.origColor);
    const pbody = bodiesMap.get(t.mesh);
    if (!pbody?.body) return;
    unfreezeBody(pbody, null, null);
    pbody.carrying = false;
    const dir = t.mesh.position.clone().sub(center).normalize();
    if (dir.length() < 0.1) { dir.x = Math.random() - 0.5; dir.z = Math.random() - 0.5; dir.normalize(); }
    const sp = 28 + Math.random() * 18;
    pbody.body.setLinvel({ x: dir.x*sp + (Math.random()-0.5)*8, y: 18 + Math.random()*12, z: dir.z*sp + (Math.random()-0.5)*8 }, true);
    pbody.body.setAngvel({ x: (Math.random()-0.5)*7, y: (Math.random()-0.5)*7, z: (Math.random()-0.5)*7 }, true);
  });
}

function _reconStartTimer() {
  if (recon.startTime) return;
  recon.startTime = performance.now();
}

function _checkSnap(mesh) {
  if (!recon.active) return false;
  const t = recon.targets.find(r => r.mesh === mesh && !r.snapped);
  if (!t) return false;
  if (mesh.position.distanceTo(t.pos) > SNAP_POS) return false;
  if (_quatAngle(mesh.quaternion, t.quat) > SNAP_ROT) return false;
  _snapPiece(t);
  return true;
}

function _snapPiece(t) {
  t.snapped = true;
  t.mesh.position.copy(t.pos);
  t.mesh.quaternion.copy(t.quat);

  const pbody = bodiesMap.get(t.mesh);
  if (pbody) {
    pbody.carrying = false; // clear carry flag without going through stopCarrying
    freezeBody(pbody);      // lock as Fixed body at target
    pbody.body.setTranslation({ x: t.pos.x, y: t.pos.y, z: t.pos.z }, true);
    pbody.body.setRotation({ x: t.quat.x, y: t.quat.y, z: t.quat.z, w: t.quat.w }, true);
  }

  // Green flash
  t.mesh.material.color.set(0x55ee88);
  setTimeout(() => { if (t.mesh) t.mesh.material.color.copy(t.origColor); }, 500);

  // Fade ghost out
  if (t.ghost) {
    const g = t.ghost; const mat = g.material; const t0 = performance.now();
    (function fade() {
      const p = Math.min(1, (performance.now() - t0) / 450);
      mat.opacity = 0.13 * (1 - p);
      if (p < 1) requestAnimationFrame(fade);
      else { scene.remove(g); mat.dispose(); t.ghost = null; }
    })();
  }

  if (t.labelPiece) t.labelPiece.style.opacity = '0';
  if (t.labelGhost) t.labelGhost.style.opacity = '0';

  const done = recon.targets.filter(r => r.snapped).length;
  document.getElementById('recon-progress').textContent = `${done} / ${recon.targets.length}`;

  if (done === recon.targets.length) setTimeout(_reconComplete, 400);
}

function _reconComplete() {
  recon.allSnapped = true;
  const n    = recon.targets.length;
  const base = n * 1000;
  const tp   = Math.round(recon.elapsed * 20);
  const hp   = recon.helpCount * 400;
  const score = Math.max(0, base - tp - hp);
  const diff  = _reconDifficulty(n);

  document.getElementById('recon-complete-diff').textContent  = diff.label;
  document.getElementById('recon-complete-diff').style.color  = diff.color;
  document.getElementById('recon-complete-time').textContent  = `${recon.elapsed.toFixed(1)}s`;
  document.getElementById('recon-complete-score').innerHTML   = `${score.toLocaleString()}<span> pts</span>`;
  document.getElementById('recon-complete').classList.add('show');
}

function _toggleReconHelp() {
  recon.helpVisible = !recon.helpVisible;
  if (recon.helpVisible) recon.helpCount++;
  document.getElementById('recon-help-btn').classList.toggle('active', recon.helpVisible);
}

function _updateReconLabels() {
  if (!recon.active) return;
  recon.targets.forEach(t => {
    const show = recon.helpVisible && !t.snapped;

    if (t.labelPiece) {
      if (show) {
        const sp = t.mesh.position.clone().project(camera);
        t.labelPiece.style.transform = `translate(-50%,-50%) translate(${(sp.x*.5+.5)*window.innerWidth}px,${(-sp.y*.5+.5)*window.innerHeight}px)`;
        t.labelPiece.style.opacity = '1';
      } else { t.labelPiece.style.opacity = '0'; }
    }
    if (t.labelGhost && t.ghost) {
      if (show) {
        const sg = t.pos.clone().project(camera);
        t.labelGhost.style.transform = `translate(-50%,-50%) translate(${(sg.x*.5+.5)*window.innerWidth}px,${(-sg.y*.5+.5)*window.innerHeight}px)`;
        t.labelGhost.style.opacity = '0.85';
      } else { t.labelGhost.style.opacity = '0'; }
    }

    // Proximity glow: brighten ghost when dragging piece near target
    if (t.ghost && !t.snapped && inputMode === 'drag-piece' && dragBody?.mesh === t.mesh) {
      const d = t.mesh.position.distanceTo(t.pos);
      t.ghost.material.opacity = d < SNAP_POS * 2 ? 0.38 - (d / (SNAP_POS * 2)) * 0.25 : 0.13;
    } else if (t.ghost && !t.snapped) {
      t.ghost.material.opacity = 0.13;
    }
  });
}

function _retryRecon() {
  document.getElementById('recon-complete').classList.remove('show');
  recon.allSnapped = false;
  recon.startTime  = null;
  recon.elapsed    = 0;
  recon.helpCount  = 0;
  recon.helpVisible = false;
  document.getElementById('recon-help-btn').classList.remove('active');
  document.getElementById('recon-timer').textContent    = '0.0s';
  document.getElementById('recon-progress').textContent = `0 / ${recon.targets.length}`;

  recon.targets.forEach(t => {
    t.snapped = false;
    t.mesh.material.color.copy(t.origColor);
    if (t.labelPiece) t.labelPiece.style.opacity = '0';
    if (t.labelGhost) t.labelGhost.style.opacity = '0';
    // Restore ghost if it was faded out
    if (!t.ghost) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x6688ff, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide });
      const ghost = new THREE.Mesh(t.mesh.geometry, mat);
      ghost.position.copy(t.pos); ghost.quaternion.copy(t.quat); ghost.scale.copy(t.mesh.scale);
      scene.add(ghost); t.ghost = ghost;
    } else { t.ghost.material.opacity = 0.13; }
  });
  setTimeout(_scatterPieces, 400);
}

function exitReconMode() {
  if (!recon.active) return;
  recon.active = false;
  renderer.domElement.removeEventListener('wheel', _onReconWheel, { capture: true });

  recon.targets.forEach(t => {
    if (t.ghost) { scene.remove(t.ghost); t.ghost.material.dispose(); t.ghost = null; }
    if (t.labelPiece) { t.labelPiece.remove(); t.labelPiece = null; }
    if (t.labelGhost) { t.labelGhost.remove(); t.labelGhost = null; }

    // Reset rotation to assembly orientation so subsequent cuts don't bake
    // in random tumble rotation into the new sub-pieces' geometry.
    const aQuat = t.mesh.userData.assemblyQuat ?? new THREE.Quaternion();
    t.mesh.quaternion.copy(aQuat);
    const pbody = bodiesMap.get(t.mesh);
    if (pbody?.body) {
      pbody.body.setRotation({ x: aQuat.x, y: aQuat.y, z: aQuat.z, w: aQuat.w }, true);
      pbody.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    // Return frozen pieces to dynamic so they can fall/interact again
    if (t.snapped) {
      if (pbody) unfreezeBody(pbody, null, null);
    }
  });
  recon.targets = [];

  document.getElementById('recon-hud').classList.remove('show');
  document.getElementById('recon-complete').classList.remove('show');
  document.getElementById('right-toolbar').style.pointerEvents = '';
  document.getElementById('right-toolbar').style.opacity = '';
  hintsEl.textContent = TOOL_HINTS[currentTool] ?? HINTS_DEFAULT;
}

// ── Out-of-bounds respawn ─────────────────────────────────────────────────────
const fadingPieces = new Map(); // mesh → fadeStartTime (ms)
const FADE_DURATION = 1200;    // ms to fade out before respawn
const OOB_Y   = -40;           // below this y → out of bounds
const OOB_XZ  = 165;           // beyond ±this in X or Z → out of bounds

function _respawnPiece(mesh) {
  fadingPieces.delete(mesh);

  const oldBody = bodiesMap.get(mesh);
  if (oldBody) { removePhysicsBody(oldBody); bodiesMap.delete(mesh); }

  mesh.material.opacity = 1;
  mesh.material.transparent = false;
  mesh.material.depthWrite = true;

  // createPhysicsBody recenters geometry and sets mesh.position to centroid,
  // so we override the body translation after creation to spawn from above.
  const newBody = createPhysicsBody(mesh);

  const ox = (Math.random() - 0.5) * 12;
  const oz = (Math.random() - 0.5) * 12;
  const spawnY = 65;
  newBody.body.setTranslation({ x: ox, y: spawnY, z: oz }, true);
  newBody.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  newBody.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  newBody.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  bodiesMap.set(mesh, newBody);
}

function tickOutOfBounds() {
  const now = performance.now();

  for (const mesh of pieces) {
    if (fadingPieces.has(mesh)) continue;
    const p = mesh.position;
    if (p.y < OOB_Y || Math.abs(p.x) > OOB_XZ || Math.abs(p.z) > OOB_XZ) {
      fadingPieces.set(mesh, now);
      // Kill velocity so it doesn't rocket further while fading
      const body = bodiesMap.get(mesh);
      if (body) { setLinearVelocity(body, 0, 0, 0); setAngularVelocity(body, 0, 0, 0); }
    }
  }

  for (const [mesh, startTime] of fadingPieces) {
    const t = Math.min(1, (now - startTime) / FADE_DURATION);
    mesh.material.opacity = 1 - t;
    mesh.material.transparent = true;
    if (t >= 1) _respawnPiece(mesh);
  }
}

// ── Raycasting ────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const matXZ     = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function getNDC(sx, sy) {
  return new THREE.Vector2(
    (sx / window.innerWidth)  *  2 - 1,
    -(sy / window.innerHeight) *  2 + 1,
  );
}

function hitsAnyPiece(sx, sy) {
  if (!pieces.length) return null;
  raycaster.setFromCamera(getNDC(sx, sy), camera);
  const hits = raycaster.intersectObjects(pieces);
  return hits.length ? hits[0].object : null;
}

function worldOnMat(sx, sy) {
  raycaster.setFromCamera(getNDC(sx, sy), camera);
  const tgt = new THREE.Vector3();
  return raycaster.ray.intersectPlane(matXZ, tgt) ? tgt.clone() : null;
}

// ── Scoring / combo ───────────────────────────────────────────────────────────
let totalCuts    = 0;
let comboCount   = 0;
let lastCutTime  = 0;
const COMBO_WINDOW = 3500;

function updateHUD() {
  cutCountEl.textContent   = totalCuts;
  pieceCountEl.textContent = pieces.length;
  const reconBtn = document.getElementById('recon-btn');
  if (reconBtn) reconBtn.disabled = pieces.length < 2;
}

// ── Feedback pop ──────────────────────────────────────────────────────────────
let feedbackTimer = null;

function showFeedback(text, sub = '') {
  feedbackTextEl.textContent = text;
  feedbackSubEl.textContent  = sub;
  feedbackEl.style.transition  = 'none';
  feedbackEl.style.opacity     = '1';
  feedbackEl.style.transform   = 'translate(-50%, -60%) scale(1.08)';
  requestAnimationFrame(() => {
    feedbackEl.style.transition = 'transform 0.15s ease-out';
    feedbackEl.style.transform  = 'translate(-50%, -60%) scale(1)';
  });
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedbackEl.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    feedbackEl.style.opacity    = '0';
    feedbackEl.style.transform  = 'translate(-50%, -70%) scale(0.88)';
  }, 900);
}

// ── Screen flash ──────────────────────────────────────────────────────────────
function flashScreen(color = 'rgba(0,220,255,0.18)') {
  const div = document.createElement('div');
  div.style.cssText = `position:fixed;inset:0;background:${color};pointer-events:none;z-index:50;`;
  document.body.appendChild(div);
  div.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-out' }).onfinish = () => div.remove();
}

// ── 2-D particle system ───────────────────────────────────────────────────────
const particles = [];

function spawnCutParticles(screenStart, screenEnd) {
  const dx  = screenEnd.x - screenStart.x;
  const dy  = screenEnd.y - screenStart.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  const mx  = (screenStart.x + screenEnd.x) / 2;
  const my  = (screenStart.y + screenEnd.y) / 2;
  // Spawn along the cut line (drag direction), fly perpendicular
  const lx  =  dx / len;
  const ly  =  dy / len;
  const px  = -dy / len;
  const py  =  dx / len;
  const spread = Math.min(overlayCanvas.width, overlayCanvas.height) * 0.35;

  for (let i = 0; i < 50; i++) {
    const t    = (Math.random() * 2 - 1) * spread;
    const side = Math.random() < 0.5 ? 1 : -1;
    const spd  = 120 + Math.random() * 220;
    particles.push({
      x: mx + lx * t, y: my + ly * t,
      vx: px * side * spd + (Math.random() - 0.5) * 100,
      vy: py * side * spd + (Math.random() - 0.5) * 100,
      life: 1.0, decay: 1.2 + Math.random() * 1.2,
      size: 2.5 + Math.random() * 4,
      cyan: Math.random() < 0.65,
    });
  }
}

function updateAndDrawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.90; p.vy *= 0.90;
    p.life -= p.decay * dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const a = Math.max(0, p.life);
    const col = p.cyan ? '#00ddff' : '#ffdd00';
    ctx.save();
    ctx.globalAlpha = a; ctx.fillStyle = col;
    ctx.shadowColor = col; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ── Laser line ────────────────────────────────────────────────────────────────
function drawLaserLine(a, b) {
  if (!a || !b) return;
  const W = overlayCanvas.width, H = overlayCanvas.height;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  // Laser runs along the drag direction   that's the visible cut seam
  const lx = dx / len, ly = dy / len;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const big = Math.max(W, H) * 2;
  const x1 = mx - lx * big, y1 = my - ly * big;
  const x2 = mx + lx * big, y2 = my + ly * big;

  ctx.save();
  ctx.lineWidth = 18; ctx.strokeStyle = 'rgba(0,220,255,0.04)';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,220,255,0.35)';
  ctx.shadowColor = '#00ddff'; ctx.shadowBlur = 22;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#00ddff'; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ── Isolate / Lay-flat mode ───────────────────────────────────────────────────
let isolatedMesh  = null;
let layFlatFaces  = [];  // [{normal:Vector3, area:number}] in local space, largest first
let layFlatIdx    = -1;  // -1 = no face applied yet
let isoOrigQuat   = new THREE.Quaternion();
let isoOrigPos    = new THREE.Vector3();

function _flatFaces(mesh) {
  const pos  = mesh.geometry.attributes.position;
  const idx  = mesh.geometry.index;
  const n    = idx ? idx.count / 3 : pos.count / 3;
  // 12° tolerance   catches spread flat regions in dense STL tessellations
  const COS  = Math.cos(12 * Math.PI / 180);
  const groups = [];
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(t*3)   : t*3;
    const i1 = idx ? idx.getX(t*3+1) : t*3+1;
    const i2 = idx ? idx.getX(t*3+2) : t*3+2;
    va.fromBufferAttribute(pos, i0);
    vb.fromBufferAttribute(pos, i1);
    vc.fromBufferAttribute(pos, i2);
    e1.subVectors(vb, va); e2.subVectors(vc, va); e1.cross(e2);
    const area = e1.length() * 0.5;
    if (area < 1e-6) continue;
    const nrm = e1.clone().normalize();
    let merged = false;
    for (const g of groups) {
      if (Math.abs(nrm.dot(g.normal)) >= COS) {
        // Area-weighted normal update so the group normal converges toward
        // the true flat orientation rather than locking to the first triangle
        g.normal.multiplyScalar(g.area).addScaledVector(nrm, area).normalize();
        g.area += area;
        merged = true;
        break;
      }
    }
    if (!merged) groups.push({ normal: nrm, area });
  }
  // Only keep groups that represent at least 0.5% of total surface   filters
  // tiny seam triangles that would clutter the face list
  const totalArea = groups.reduce((s, g) => s + g.area, 0);
  return groups
    .filter(g => g.area / totalArea >= 0.005)
    .sort((a, b) => b.area - a.area);
}

function _setIsoMaterials(focused) {
  for (const m of pieces) {
    const mat = m.material;
    if (m === focused) {
      mat.emissive.set(0x002244);
      mat.emissiveIntensity = 0.9;
      mat.opacity = 1; mat.transparent = false; mat.depthWrite = true;
    } else {
      mat.emissive.set(0x000000); mat.emissiveIntensity = 0;
      mat.opacity = 0.15; mat.transparent = true; mat.depthWrite = false;
    }
  }
}

function _clearIsoMaterials() {
  for (const m of pieces) {
    const mat = m.material;
    mat.emissive.set(0x000000); mat.emissiveIntensity = 0;
    mat.opacity = 1; mat.transparent = false; mat.depthWrite = true;
  }
}

function enterIsolate(mesh) {
  if (isolatedMesh === mesh) return;
  if (isolatedMesh) exitIsolate(false);
  isolatedMesh = mesh;
  isoOrigQuat.copy(mesh.quaternion);
  isoOrigPos.copy(mesh.position);
  layFlatFaces = _flatFaces(mesh);
  layFlatIdx   = -1;
  _setIsoMaterials(mesh);
  const n = layFlatFaces.length;
  setStatus(`ISOLATE  ·  ${n} flat face${n!==1?'s':''}   scroll to choose  ·  click piece to confirm  ·  Esc to cancel`);
}

function _applyLayFlat(mesh, idx) {
  if (!mesh || idx < 0 || idx >= layFlatFaces.length) return;
  const q = new THREE.Quaternion().setFromUnitVectors(
    layFlatFaces[idx].normal.clone().normalize(),
    new THREE.Vector3(0, -1, 0),
  );
  mesh.quaternion.copy(q);
  const body = bodiesMap.get(mesh)?.body;
  if (body) body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, false);
}

function exitIsolate(confirm) {
  if (!isolatedMesh) return;
  const mesh = isolatedMesh;

  if (!confirm) {
    mesh.quaternion.copy(isoOrigQuat);
    mesh.position.copy(isoOrigPos);
    const body = bodiesMap.get(mesh)?.body;
    if (body) {
      body.setTranslation({ x: isoOrigPos.x, y: isoOrigPos.y, z: isoOrigPos.z }, true);
      body.setRotation({ x: isoOrigQuat.x, y: isoOrigQuat.y, z: isoOrigQuat.z, w: isoOrigQuat.w }, true);
    }
  } else if (layFlatIdx >= 0) {
    // Settle piece so chosen face lays exactly on ground (y = 0)
    const pos = mesh.geometry.attributes.position;
    const q   = mesh.quaternion;
    const v   = new THREE.Vector3();
    let minY  = Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyQuaternion(q);
      if (v.y < minY) minY = v.y;
    }
    mesh.position.y = -minY + 0.05;
    const body = bodiesMap.get(mesh)?.body;
    if (body) {
      const p = mesh.position, r = mesh.quaternion;
      body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      body.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w }, true);
      body.setLinvel({ x:0, y:0, z:0 }, true);
      body.setAngvel({ x:0, y:0, z:0 }, true);
    }
  }

  _clearIsoMaterials();
  isolatedMesh = null; layFlatFaces = []; layFlatIdx = -1;
  controls.enableZoom = true;
  setStatus(`${pieces.length} pieces · drag to lift & throw · right-drag to orbit`);
}

// ── Tool system ───────────────────────────────────────────────────────────────
let currentTool = 'pointer'; // 'pointer' | 'cut-straight' | 'transform' | 'hand'

const TOOL_HINTS = {
  'pointer':      'click & drag = pick & throw  ·  scroll while dragging = lay flat  ·  double-click = isolate  ·  right-drag = orbit',
  'cut-straight': 'drag across = slice  ·  shift+drag = snap straight  ·  joint mode: after slice move to place peg  ·  cmd+scroll = peg length  ·  cmd+shift+scroll = peg width  ·  shift = center peg  ·  right-drag = orbit',
  'transform':    'click piece = select  ·  T = translate  ·  R = rotate  ·  S = scale  ·  drag handles = move  ·  Esc = deselect  ·  right-drag = orbit',
  'hand':         'click a face = stand on that face  ·  scroll while dragging = cycle face  ·  right-drag = orbit',
};

function setTool(tool) {
  if (currentTool === 'transform') _detachTransform();
  currentTool = tool;
  document.querySelectorAll('.tool-btn:not(.mode-btn)').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  hintsEl.textContent = TOOL_HINTS[tool] ?? HINTS_DEFAULT;
  if (inputMode === 'idle') {
    renderer.domElement.style.cursor = _toolCursor();
  }
}

function _toolCursor(onPiece = false) {
  if (currentTool === 'cut-straight') return 'crosshair';
  if (currentTool === 'hand') return onPiece ? 'cell' : 'default';
  if (currentTool === 'transform') return onPiece ? 'pointer' : 'default';
  return onPiece ? 'grab' : 'default';
}

document.querySelectorAll('.tool-btn:not(.mode-btn)').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// ── Undo / Redo ───────────────────────────────────────────────────────────────
const MAX_UNDO  = 15;
const undoStack = [];
const redoStack = [];

function snapshotPieces() {
  return {
    items: pieces.map(m => ({
      posArr:     new Float32Array(m.geometry.attributes.position.array),
      idxArr:     m.geometry.index ? new Uint32Array(m.geometry.index.array) : null,
      position:   m.position.clone(),
      quaternion: m.quaternion.clone(),
      colorHex:   m.material.color.getHex(),
    })),
    totalCuts,
    colorCursor,
  };
}

function applySnapshot(snap) {
  if (isolatedMesh) { _clearIsoMaterials(); isolatedMesh = null; layFlatFaces = []; layFlatIdx = -1; controls.enableZoom = true; }
  [...pieces].forEach(removePiece);
  totalCuts   = snap.totalCuts;
  colorCursor = snap.colorCursor;
  for (const s of snap.items) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(s.posArr.slice(), 3));
    if (s.idxArr) geo.setIndex(new THREE.BufferAttribute(s.idxArr.slice(), 1));
    geo.computeVertexNormals();
    const mat  = new THREE.MeshStandardMaterial({
      color: s.colorHex, roughness: 0.92, metalness: 0.0,
      flatShading: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    const body = createPhysicsBody(mesh);
    mesh.position.copy(s.position);
    mesh.quaternion.copy(s.quaternion);
    mesh.userData.assemblyPos  = s.position.clone();
    mesh.userData.assemblyQuat = s.quaternion.clone();
    body.body.setTranslation({ x: s.position.x, y: s.position.y, z: s.position.z }, true);
    body.body.setRotation({ x: s.quaternion.x, y: s.quaternion.y, z: s.quaternion.z, w: s.quaternion.w }, true);
    body.body.setLinvel({ x:0, y:0, z:0 }, true);
    body.body.setAngvel({ x:0, y:0, z:0 }, true);
    addPiece(mesh, body);
  }
  updateHUD();
  _updateUndoRedoBtns();
  setStatus(`${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'} · Ctrl+Z/Y to undo/redo`);
}

function pushUndo() {
  undoStack.push(snapshotPieces());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  _updateUndoRedoBtns();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotPieces());
  applySnapshot(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotPieces());
  applySnapshot(redoStack.pop());
}

function _updateUndoRedoBtns() {
  document.getElementById('undo-btn').disabled = undoStack.length === 0;
  document.getElementById('redo-btn').disabled = redoStack.length === 0;
}

document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);
document.getElementById('recon-btn').addEventListener('click', enterReconMode);
document.getElementById('recon-help-btn').addEventListener('click', _toggleReconHelp);
document.getElementById('recon-reset-btn').addEventListener('click', _retryRecon);
document.getElementById('recon-exit-btn').addEventListener('click', exitReconMode);
document.getElementById('recon-retry-btn').addEventListener('click', _retryRecon);
document.getElementById('recon-back-btn').addEventListener('click', exitReconMode);

// ── Input state machine ───────────────────────────────────────────────────────
let inputMode    = 'idle';
let cutStart     = null;
let cutCurrent   = null;
let mouseDownPos = null;
let hoveredMesh  = null;

let dragBody          = null;
let carryPlane        = new THREE.Plane();
let carryOffset3D     = new THREE.Vector3();
let prevDragPositions = [];

// (hand-grab state removed   tool is now face-click-to-stand)

function getEventXY(e) {
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX, y: src.clientY };
}

// ── Pointer down ──────────────────────────────────────────────────────────────
function _startDragPiece(hit, x, y) {
  const body = bodiesMap.get(hit);
  if (!body) return;
  hoveredMesh = null; outlinePass.selectedObjects = [];
  renderer.domElement.style.cursor = 'grabbing';
  inputMode = 'drag-piece';
  dragBody  = body;
  if (recon.active) _reconStartTimer(); // start timer on first piece move
  startCarrying(dragBody);
  prevDragPositions = [];
  if (!isolatedMesh) { layFlatFaces = _flatFaces(hit); layFlatIdx = -1; }
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  carryPlane.setFromNormalAndCoplanarPoint(camDir, hit.position);
  raycaster.setFromCamera(getNDC(x, y), camera);
  const pickPt = new THREE.Vector3();
  raycaster.ray.intersectPlane(carryPlane, pickPt);
  carryOffset3D.subVectors(hit.position, pickPt);
  controls.enabled = false;
}

// Returns the quaternion among the 24 cube orientations (multiples of 90°)
// closest to q   prevents curved faces from leaving the object at tipping angles.
function _snapTo90(q) {
  const S = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  let best = null, bestDot = -Infinity;
  for (const x of S) for (const y of S) for (const z of S) {
    const c = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
    const d = Math.abs(q.dot(c));
    if (d > bestDot) { bestDot = d; best = c; }
  }
  return best;
}

function _faceClickToStand(hit, x, y) {
  const body = bodiesMap.get(hit);
  if (!body) return;
  raycaster.setFromCamera(getNDC(x, y), camera);
  const hits3d = raycaster.intersectObjects([hit]);
  if (!hits3d.length || !hits3d[0].face) return;

  // Face normal in world space   if we hit the back face, negate so we always
  // treat the surface as facing toward the camera (prevents inner-surface flips)
  let n = hits3d[0].face.normal.clone().transformDirection(hit.matrixWorld).normalize();
  if (n.dot(raycaster.ray.direction) > 0) n.negate();

  // Rotation that brings this face normal to point straight down (−Y)
  const down = new THREE.Vector3(0, -1, 0);
  const dot = n.dot(down);
  let rotQ;
  if (Math.abs(dot) > 1 - 1e-6) {
    // Already parallel/anti-parallel   use X axis for 180° to avoid gimbal issues
    rotQ = dot > 0
      ? new THREE.Quaternion()
      : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  } else {
    rotQ = new THREE.Quaternion().setFromUnitVectors(n, down);
  }

  // Snap to nearest 90° cardinal orientation so curved/tilted faces never
  // leave the object at a physics-tipping angle
  const rawQuat = rotQ.multiply(hit.quaternion.clone());
  const newQuat = _snapTo90(rawQuat);

  // Find the lowest vertex Y after the new rotation (without moving the mesh)
  const pos = hit.geometry.attributes.position;
  const sc  = hit.scale;
  const tempV = new THREE.Vector3();
  let minY = Infinity;
  for (let i = 0; i < pos.count; i++) {
    tempV.fromBufferAttribute(pos, i);
    tempV.multiply(sc);
    tempV.applyQuaternion(newQuat);
    tempV.add(hit.position);
    if (tempV.y < minY) minY = tempV.y;
  }

  // Lift/drop the body so the lowest point rests exactly on y = 0
  const newPos = new THREE.Vector3(hit.position.x, hit.position.y - minY, hit.position.z);

  pushUndo();

  body.body.setTranslation({ x: newPos.x, y: newPos.y, z: newPos.z }, true);
  body.body.setRotation({ x: newQuat.x, y: newQuat.y, z: newQuat.z, w: newQuat.w }, true);
  body.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  setStatus('Stood on face · Ctrl+Z to undo');
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  const { x, y } = getEventXY(e);
  mouseDownPos = { x, y };

  if (recon.active && currentTool !== 'pointer') return; // lock to pointer in recon
  if (jointState) { _confirmJoint(); return; }

  const hit = hitsAnyPiece(x, y);

  if (currentTool === 'pointer') {
    if (hit) _startDragPiece(hit, x, y);
  } else if (currentTool === 'transform') {
    if (hit) {
      _attachTransform(hit);
    }
    // Never detach on pointerdown — TransformControls needs an uninterrupted drag;
    // use Escape to deselect.
  } else if (currentTool === 'hand') {
    if (hit) _faceClickToStand(hit, x, y);
  } else if (currentTool === 'cut-straight') {
    inputMode  = 'cut';
    cutStart   = { x, y };
    cutCurrent = { x, y };
    controls.enabled = false;
  }
}

// ── Pointer move ──────────────────────────────────────────────────────────────
function onPointerMove(e) {
  const { x, y } = getEventXY(e);

  if (jointState) { _updateJointPos(x, y, e.shiftKey); return; }

  if (inputMode === 'cut') {
    if (e.shiftKey && cutStart) {
      const dx = x - cutStart.x;
      const dy = y - cutStart.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      cutCurrent = {
        x: cutStart.x + dist * Math.cos(snapped),
        y: cutStart.y + dist * Math.sin(snapped),
      };
    } else {
      cutCurrent = { x, y };
    }
  }

  // Hover outline   only when idle
  if (inputMode === 'idle') {
    const hit = hitsAnyPiece(x, y);
    const candidate = hit && (!isolatedMesh || hit === isolatedMesh) ? hit : null;
    if (candidate !== hoveredMesh) {
      hoveredMesh = candidate;
      outlinePass.selectedObjects = hoveredMesh ? [hoveredMesh] : [];
      renderer.domElement.style.cursor = _toolCursor(!!hoveredMesh);
    }
  }

  if (inputMode === 'drag-piece' && dragBody) {
    raycaster.setFromCamera(getNDC(x, y), camera);
    const planeHit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(carryPlane, planeHit)) {
      planeHit.add(carryOffset3D);
      const bb = dragBody.mesh.geometry.boundingBox;
      const halfH = bb ? (bb.max.y - bb.min.y) / 2 : 1;
      planeHit.y = Math.max(planeHit.y, halfH + 0.05);
      dragBody.mesh.position.copy(planeHit);
      setCarryPosition(dragBody, planeHit.x, planeHit.y, planeHit.z);
    }
    prevDragPositions.push({
      pos: dragBody.mesh.position.clone(),
      time: performance.now(),
    });
    if (prevDragPositions.length > 8) prevDragPositions.shift();

    // Auto-snap while dragging in recon mode
    if (recon.active && _checkSnap(dragBody.mesh)) {
      prevDragPositions = [];
      dragBody = null;
    }
  }
}

// ── Pointer up ────────────────────────────────────────────────────────────────
function onPointerUp(e) {
  controls.enabled = true;
  renderer.domElement.style.cursor = _toolCursor();
  mouseDownPos = null;

  if (inputMode === 'drag-piece' && dragBody) {
    if (!isolatedMesh) { layFlatFaces = []; layFlatIdx = -1; }

    // Reconstruction snap check — if close enough, freeze in place instead of throwing
    if (recon.active && _checkSnap(dragBody.mesh)) {
      // body state + carry flag already handled inside _snapPiece
      prevDragPositions = [];
      dragBody = null;
    } else {
      let linVel = null, angVel = null;
      const pts = prevDragPositions;
      if (pts.length >= 2) {
        const p0 = pts[Math.max(0, pts.length - 5)];
        const p1 = pts[pts.length - 1];
        const dt = (p1.time - p0.time) / 1000;
        if (dt > 0.01) {
          const vel = new THREE.Vector3().subVectors(p1.pos, p0.pos).divideScalar(dt);
          vel.clampLength(0, 100);
          linVel = vel;
          const spd = vel.length();
          angVel = new THREE.Vector3(
            (Math.random() - 0.5) * spd * 0.13,
            (Math.random() - 0.5) * spd * 0.06,
            (Math.random() - 0.5) * spd * 0.13,
          );
        }
      }
      stopCarrying(dragBody, linVel, angVel);
      prevDragPositions = [];
      dragBody = null;
    }
  }


  if (inputMode === 'cut' && cutStart && cutCurrent) {
    const dx = cutCurrent.x - cutStart.x;
    const dy = cutCurrent.y - cutStart.y;
    if (Math.sqrt(dx * dx + dy * dy) >= 25) executeCut(cutStart, cutCurrent);
  }


  inputMode  = 'idle';
  cutStart   = null;
  cutCurrent = null;
}

renderer.domElement.addEventListener('mousedown',  onPointerDown);
renderer.domElement.addEventListener('mousemove',  onPointerMove);
window.addEventListener('mouseup',    onPointerUp);   // window-level so drag-off-canvas still fires
renderer.domElement.addEventListener('touchstart', onPointerDown, { passive: true });
renderer.domElement.addEventListener('touchmove',  onPointerMove, { passive: true });
renderer.domElement.addEventListener('touchend',   onPointerUp);

// ── Scroll to cycle lay-flat faces ────────────────────────────────────────────
renderer.domElement.addEventListener('wheel', (e) => {
  // Lay flat only works while actively dragging a piece
  if (inputMode !== 'drag-piece' || !dragBody) return;
  const activeMesh = dragBody.mesh;
  if (!activeMesh || !layFlatFaces.length) return;
  e.preventDefault();
  const dir = e.deltaY > 0 ? 1 : -1;
  layFlatIdx = (layFlatIdx + dir + layFlatFaces.length) % layFlatFaces.length;
  _applyLayFlat(activeMesh, layFlatIdx);
}, { passive: false });

// ── Double-click to enter / exit isolate mode ─────────────────────────────────
renderer.domElement.addEventListener('dblclick', (e) => {
  if (isolatedMesh) {
    exitIsolate(true);  // confirm whatever face is chosen (or just exit if none)
    return;
  }
  const { x, y } = getEventXY(e);
  const hit = hitsAnyPiece(x, y);
  if (hit) enterIsolate(hit);
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && jointState) { _cancelJoint(); return; }
  if (e.key === 'Escape' && currentTool === 'transform') { _detachTransform(); return; }
  if (e.key === 'Escape' && isolatedMesh) { exitIsolate(false); return; }
  if (e.key === '1') { setTool('pointer'); return; }
  if (e.key === '2') { setTool('cut-straight'); return; }
  if (e.key === '3') { setTool('transform'); return; }
  if (e.key === '4') { setTool('hand'); return; }

  // Transform gizmo mode shortcuts (only when transform tool active)
  if (currentTool === 'transform' && transformTarget) {
    if (e.key.toLowerCase() === 't') { transformCtrl.setMode('translate'); return; }
    if (e.key.toLowerCase() === 'r') { transformCtrl.setMode('rotate'); return; }
    if (e.key.toLowerCase() === 's') { transformCtrl.setMode('scale'); return; }
  }

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
});


// ── View cube ─────────────────────────────────────────────────────────────────
const vcCubeEl = document.getElementById('vc-cube');

function updateViewCube() {
  // Maps Three.js camera rotation → CSS 3D cube rotation, accounting for Y-axis flip.
  // Formula derived from: CSS_M = F × R_cam^T × F, where F = diag(1,-1,1).
  const e = camera.matrixWorld.elements;
  vcCubeEl.style.transform = `matrix3d(
    ${e[0]},${-e[4]},${e[8]},0,
    ${-e[1]},${e[5]},${-e[9]},0,
    ${e[2]},${-e[6]},${e[10]},0,
    0,0,0,1)`;
}

let snapAnim = null; // { startPos, startQuat, endPos, endQuat, t }

function snapToView(viewName) {
  const dist = camera.position.distanceTo(controls.target);
  const tgt  = controls.target.clone();

  // Direction from target to camera end position
  const DIRS = {
    front:  new THREE.Vector3( 0,    0,   1),
    back:   new THREE.Vector3( 0,    0,  -1),
    right:  new THREE.Vector3( 1,    0,   0),
    left:   new THREE.Vector3(-1,    0,   0),
    top:    new THREE.Vector3( 0,    1,   0),
    bottom: new THREE.Vector3( 0, 0.12, 0.99).normalize(), // low front (floor clips true bottom)
  };
  // Camera "up" for each preset (determines roll angle)
  const UPS = {
    top:    new THREE.Vector3(0, 0, -1),
    bottom: new THREE.Vector3(0, 1,  0),
  };

  const dir = DIRS[viewName];
  if (!dir) return;

  const endPos  = tgt.clone().addScaledVector(dir, dist);
  const up      = UPS[viewName] ?? new THREE.Vector3(0, 1, 0);
  const lookM   = new THREE.Matrix4().lookAt(endPos, tgt, up);
  const endQuat = new THREE.Quaternion().setFromRotationMatrix(lookM);

  // Ensure slerp takes the short path
  if (camera.quaternion.dot(endQuat) < 0) endQuat.negate();

  snapAnim = {
    startPos:  camera.position.clone(),
    startQuat: camera.quaternion.clone(),
    endPos, endQuat, t: 0,
  };
  setStatus(`View: ${viewName}`);
}

document.querySelectorAll('.vc-face').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    snapToView(el.dataset.snap);
  });
});

// ── STL export ───────────────────────────────────────────────────────────────

function _meshToSTLBuffer(mesh) {
  mesh.updateMatrixWorld(true);
  const geo   = mesh.geometry;
  const pos   = geo.attributes.position;
  const index = geo.index;
  const numTris = index ? index.count / 3 : pos.count / 3;
  const buf  = new ArrayBuffer(84 + numTris * 50);
  const view = new DataView(buf);
  view.setUint32(80, numTris, true);
  let off = 84;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const n = new THREE.Vector3();
  for (let t = 0; t < numTris; t++) {
    for (let c = 0; c < 3; c++) {
      const idx = index ? index.getX(t * 3 + c) : t * 3 + c;
      v[c].fromBufferAttribute(pos, idx).applyMatrix4(mesh.matrixWorld);
    }
    n.crossVectors(
      new THREE.Vector3().subVectors(v[1], v[0]),
      new THREE.Vector3().subVectors(v[2], v[0]),
    ).normalize();
    view.setFloat32(off, n.x, true); off += 4;
    view.setFloat32(off, n.y, true); off += 4;
    view.setFloat32(off, n.z, true); off += 4;
    for (const vert of v) {
      view.setFloat32(off, vert.x, true); off += 4;
      view.setFloat32(off, vert.y, true); off += 4;
      view.setFloat32(off, vert.z, true); off += 4;
    }
    view.setUint16(off, 0, true); off += 2;
  }
  return buf;
}

function _downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportSTL() {
  if (!pieces.length) { showNotice('Nothing to export'); return; }

  if (pieces.length === 1) {
    _downloadBlob(new Blob([_meshToSTLBuffer(pieces[0])], { type: 'application/octet-stream' }), 'piece.stl');
    setStatus('Downloaded piece.stl');
    return;
  }

  // Multiple pieces → zip
  const JSZip = window.JSZip;
  if (!JSZip) { showNotice('JSZip not loaded'); return; }
  const zip = new JSZip();
  pieces.forEach((m, i) => {
    zip.file(`piece_${String(i + 1).padStart(2, '0')}.stl`, _meshToSTLBuffer(m));
  });
  const blob = await zip.generateAsync({ type: 'blob' });
  _downloadBlob(blob, `cuttable_${pieces.length}pieces.zip`);
  setStatus(`Downloaded ${pieces.length} STL files as zip`);
}

document.getElementById('export-btn').addEventListener('click', exportSTL);

// ── Cut execution ─────────────────────────────────────────────────────────────
function executeCut(screenStart, screenEnd) {
  if (jointState) return;
  pushUndo();
  const plane = straightLinePlane(screenStart, screenEnd, camera, renderer.domElement, pieces);
  if (!plane) {
    showNotice('Drag too short   try again');
    controls.enabled = true;
    return;
  }

  // Joint mode: only allow cutting one piece at a time
  if (cutMode === 'joint') {
    const wouldCut = pieces.filter(m => (!isolatedMesh || m === isolatedMesh) && planeSplitsMesh(m, plane));
    if (wouldCut.length > 1) {
      showNotice('Joint mode only cuts one object at a time   isolate a piece first, then slice');
      controls.enabled = true;
      return;
    }
  }

  const toRemove = [];
  const toAdd    = [];
  let   cutCount = 0;
  let   _jointPairCaptured = null;

  for (const mesh of pieces) {
    if (isolatedMesh && mesh !== isolatedMesh) continue;
    if (!planeSplitsMesh(mesh, plane)) continue;
    const result = clipMeshByPlane(mesh, plane);
    if (!result.above || !result.below) continue;

    cutCount++;
    const matA = nextMaterial(), matB = nextMaterial();

    // Drift = how far this parent has moved from its assembly position
    const assemblyDrift = (mesh.userData.assemblyPos ?? mesh.position).clone().sub(mesh.position);

    if (cutMode === 'joint' && !_jointPairCaptured) {
      // Clone world-space geos BEFORE createPhysicsBody modifies them
      const aboveGeoWorld = result.above.clone();
      const belowGeoWorld = result.below.clone();
      const meshA = new THREE.Mesh(result.above, matA);
      const meshB = new THREE.Mesh(result.below, matB);
      meshA.castShadow = meshB.castShadow = true;
      const bodyA = createPhysicsBody(meshA);
      const bodyB = createPhysicsBody(meshB);
      meshA.userData.assemblyPos = meshA.position.clone().add(assemblyDrift);
      meshB.userData.assemblyPos = meshB.position.clone().add(assemblyDrift);
      freezeBody(bodyA);
      freezeBody(bodyB);
      toRemove.push(mesh);
      toAdd.push({ mesh: meshA, body: bodyA }, { mesh: meshB, body: bodyB });
      _jointPairCaptured = { meshA, bodyA, meshB, bodyB, aboveGeoWorld, belowGeoWorld, plane };
      continue;
    }

    const meshA = new THREE.Mesh(result.above, matA);
    const meshB = new THREE.Mesh(result.below, matB);
    meshA.castShadow = meshB.castShadow = true;

    // createPhysicsBody centres geometry & sets mesh.position
    const bodyA = createPhysicsBody(meshA);
    const bodyB = createPhysicsBody(meshB);

    // Correct assembly positions for any drift the parent accumulated since its own cut
    meshA.userData.assemblyPos = meshA.position.clone().add(assemblyDrift);
    meshB.userData.assemblyPos = meshB.position.clone().add(assemblyDrift);

    // Inherit parent velocity, add separation impulse
    const parentBody  = bodiesMap.get(mesh);
    const baseVel     = parentBody ? getLinearVelocity(parentBody) : new THREE.Vector3();

    const velA = baseVel.clone().addScaledVector(plane.normal,  5); velA.y += 4;
    const velB = baseVel.clone().addScaledVector(plane.normal, -5); velB.y += 4;

    setLinearVelocity(bodyA, velA.x, velA.y, velA.z);
    setLinearVelocity(bodyB, velB.x, velB.y, velB.z);

    // Initial spin so thin pieces tumble
    setAngularVelocity(bodyA,
      (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 9);
    setAngularVelocity(bodyB,
      (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 9);

    toRemove.push(mesh);
    toAdd.push({ mesh: meshA, body: bodyA }, { mesh: meshB, body: bodyB });
  }

  if (cutCount === 0) {
    showNotice('Cut missed   try a different angle');
    controls.enabled = true;
    return;
  }

  for (const mesh of toRemove) removePiece(mesh);
  for (const { mesh, body } of toAdd) addPiece(mesh, body);

  // If the isolated piece was cut, clear isolate state (new pieces have fresh materials)
  if (isolatedMesh && !pieces.includes(isolatedMesh)) {
    isolatedMesh = null; layFlatFaces = []; layFlatIdx = -1;
    controls.enableZoom = true;
  }

  if (_jointPairCaptured) {
    totalCuts++;
    updateHUD();
    _startJoint(_jointPairCaptured);
    return;
  }

  // ── Juicy feedback ────────────────────────────────────────────────────────
  const now = performance.now();
  comboCount  = (now - lastCutTime < COMBO_WINDOW) ? comboCount + 1 : 1;
  lastCutTime = now;
  totalCuts++;
  updateHUD();

  spawnCutParticles(screenStart, screenEnd);
  const isCombo = comboCount >= 3;
  flashScreen(isCombo ? 'rgba(255,220,0,0.20)' : 'rgba(0,220,255,0.18)');
  feedbackTextEl.style.color = '#ffdd00';
  showFeedback(
    isCombo ? `COMBO ×${comboCount}` : 'SLICED!',
    isCombo ? 'SLICE STREAK' : (cutCount > 1 ? `${cutCount} PIECES SPLIT` : 'CLEAN CUT'),
  );

  setStatus(`${pieces.length} pieces · drag to lift & throw · right-drag to orbit`);
  controls.enabled = true;
}

// ── Render loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);


  // Step Rapier + sync meshes
  stepAndSync(Array.from(bodiesMap.values()));
  _syncTransformBody();

  // Reconstruction mode: tick timer + update labels
  if (recon.active && recon.startTime && !recon.allSnapped) {
    recon.elapsed = (performance.now() - recon.startTime) / 1000;
    document.getElementById('recon-timer').textContent = recon.elapsed.toFixed(1) + 's';
  }
  _updateReconLabels();

  // Out-of-bounds: fade + respawn
  tickOutOfBounds();

  // Overlay: clear → particles → laser / pen path
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  updateAndDrawParticles(dt);
  if (inputMode === 'cut' && cutStart && cutCurrent) drawLaserLine(cutStart, cutCurrent);


  // Always update controls   this drains orbit velocity each frame.
  // If a snap is active we then override camera state so velocity can't drift.
  controls.update();

  // Clamp pan so target can't drift too far from origin
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, -PAN_LIMIT, PAN_LIMIT);
  controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0, PAN_LIMIT * 0.5);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, -PAN_LIMIT, PAN_LIMIT);

  if (snapAnim) {
    snapAnim.t = Math.min(1, snapAnim.t + 0.08);
    const ease = 1 - Math.pow(1 - snapAnim.t, 3); // cubic ease-out
    camera.position.lerpVectors(snapAnim.startPos, snapAnim.endPos, ease);
    camera.quaternion.slerpQuaternions(snapAnim.startQuat, snapAnim.endQuat, ease);
    if (isOrthoView) _updateOrthoFrustum();
    if (snapAnim.t >= 1) snapAnim = null;
  }

  updateViewCube();
  composer.render();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
setStatus('Loading…');

Promise.all([initPhysics(), initCutter()]).then(() => {
  loadModel(scene)
    .then(mesh => {
      const body = createPhysicsBody(mesh);
      addPiece(mesh, body);
      hintsEl.textContent = TOOL_HINTS['pointer'];
    })
    .catch(err => {
      console.error(err);
      showNotice('Could not load sample-model.stl');
    });

  animate();
});

// ── STL import ────────────────────────────────────────────────────────────────
const TARGET_IMPORT_SIZE = 40;

function loadSTLBuffer(buffer) {
  const loader = new STLLoader();
  const geo    = loader.parse(buffer);

  geo.computeBoundingBox();
  const size   = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const scale  = TARGET_IMPORT_SIZE / Math.max(size.x, size.y, size.z);
  geo.scale(scale, scale, scale);
  geo.computeBoundingBox();
  const nb = geo.boundingBox;
  geo.translate(
    -((nb.min.x + nb.max.x) / 2),
    -nb.min.y,
    -((nb.min.z + nb.max.z) / 2),
  );
  geo.computeVertexNormals();

  // Clear all existing pieces
  if (isolatedMesh) { _clearIsoMaterials(); isolatedMesh = null; layFlatFaces = []; layFlatIdx = -1; controls.enableZoom = true; }
  [...pieces].forEach(removePiece);
  totalCuts = 0; comboCount = 0; colorCursor = 0;
  undoStack.length = 0; redoStack.length = 0; _updateUndoRedoBtns();
  updateHUD();

  const mesh = new THREE.Mesh(geo, nextMaterial());
  mesh.castShadow = true;
  const body = createPhysicsBody(mesh);
  addPiece(mesh, body);
  setStatus('Model loaded · drag across to cut · right-drag to orbit');
}

function onImportClick() {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.stl';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setStatus('Loading…');
    const reader = new FileReader();
    reader.onload  = (ev) => loadSTLBuffer(ev.target.result);
    reader.onerror = ()  => showNotice('Failed to read file');
    reader.readAsArrayBuffer(file);
  };
  input.click();
}

document.getElementById('import-btn').addEventListener('click', onImportClick);

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  perspCamera.aspect = window.innerWidth / window.innerHeight;
  perspCamera.updateProjectionMatrix();
  if (isOrthoView) _updateOrthoFrustum();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.resolution.set(window.innerWidth, window.innerHeight);
  outlinePass.resolution.set(window.innerWidth, window.innerHeight);
  overlayCanvas.width  = window.innerWidth;
  overlayCanvas.height = window.innerHeight;
});
