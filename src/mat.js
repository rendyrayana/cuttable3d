import * as THREE from 'three';

const MAT_SIZE   = 300;
const MAJOR_STEP = 10;   // major grid line every 10 units (≈ 1 cm)
const MINOR_STEP = 2;    // minor grid line every 2 units  (≈ 2 mm)

function buildMatTexture() {
  const RES = 2048;
  const c   = document.createElement('canvas');
  c.width = RES; c.height = RES;
  const ctx = c.getContext('2d');

  // Base   dark cutting-mat green
  ctx.fillStyle = '#122a18';
  ctx.fillRect(0, 0, RES, RES);

  // Very soft dark-blue vignette to blend into the scene background (#0d0d18)
  const grad = ctx.createRadialGradient(RES/2, RES/2, RES * 0.15, RES/2, RES/2, RES * 0.82);
  grad.addColorStop(0,   'rgba(0,0,0,0)');
  grad.addColorStop(1,   'rgba(8,8,28,0.72)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, RES, RES);

  const px = RES / MAT_SIZE;

  // ── Minor grid (2-unit spacing) ────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 0.7;
  for (let u = 0; u <= MAT_SIZE; u += MINOR_STEP) {
    const p = u * px;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, RES); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(RES, p); ctx.stroke();
  }

  // ── Major grid (10-unit = 1 cm spacing) ───────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.4;
  for (let u = 0; u <= MAT_SIZE; u += MAJOR_STEP) {
    const p = u * px;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, RES); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(RES, p); ctx.stroke();
  }

  // ── 5-cm accent lines (every 50 units) ────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.50)';
  ctx.lineWidth = 2.0;
  for (let u = 0; u <= MAT_SIZE; u += 50) {
    const p = u * px;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, RES); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(RES, p); ctx.stroke();
  }

  // ── Cross-hair tick marks at 5-cm intersections ────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.40)';
  const TICK = 6;
  for (let u = 50; u < MAT_SIZE; u += 50) {
    for (let v = 50; v < MAT_SIZE; v += 50) {
      const px2 = u * px, py2 = v * px;
      ctx.fillRect(px2 - TICK/2, py2 - 1, TICK, 2);
      ctx.fillRect(px2 - 1, py2 - TICK/2, 2, TICK);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export function createMat(scene) {
  const tex = buildMatTexture();

  // ── Base plane ─────────────────────────────────────────────────────────────
  const geo = new THREE.PlaneGeometry(MAT_SIZE, MAT_SIZE);
  const mat = new THREE.MeshStandardMaterial({
    map:       tex,
    roughness: 0.60,
    metalness: 0.04,
    envMapIntensity: 0.3,
  });
  const plane = new THREE.Mesh(geo, mat);
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  scene.add(plane);

  // ── Subtle edge border (thin darker frame) ─────────────────────────────────
  const edgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(MAT_SIZE, MAT_SIZE));
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3aff88, opacity: 0.18, transparent: true });
  const border  = new THREE.LineSegments(edgeGeo, edgeMat);
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.02;
  scene.add(border);

  return plane;
}
