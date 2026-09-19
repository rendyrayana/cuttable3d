/**
 * physics.js   Rapier-backed rigid body simulation.
 *
 * Call initPhysics() once (async, loads WASM) before anything else.
 * All other exports are synchronous after that.
 *
 * Geometry contract: clipMeshByPlane() returns world-space geometry with an
 * identity mesh transform. createPhysicsBody() centers each geometry around
 * the origin and moves mesh.position to that centroid, so the Rapier body and
 * its ConvexHull collider are properly centred.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export const CARRY_HEIGHT = 14; // units above y=0 that the piece bottom floats at

const GRAVITY     = -260;
const RESTITUTION = 0.38;
const FRICTION    = 0.75;
const LIN_DAMPING = 0.05;
const ANG_DAMPING = 0.25;

let world = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initPhysics() {
  await RAPIER.init();

  world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });

  // Fixed ground plane at y = 0
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(1000, 0.05, 1000)
      .setTranslation(0, -0.05, 0)
      .setRestitution(RESTITUTION)
      .setFriction(FRICTION),
    groundBody,
  );
}

// ── Body creation ─────────────────────────────────────────────────────────────

/**
 * Centers the mesh geometry around origin, sets mesh.position to the centroid,
 * then creates a Rapier dynamic body + ConvexHull collider.
 * Falls back to a bounding-box cuboid if the convex hull is degenerate.
 */
export function createPhysicsBody(mesh) {
  // ── Centre geometry ────────────────────────────────────────────────────────
  mesh.geometry.computeBoundingBox();
  const centroid = new THREE.Vector3();
  mesh.geometry.boundingBox.getCenter(centroid);

  const posAttr = mesh.geometry.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    posAttr.setXYZ(
      i,
      posAttr.getX(i) - centroid.x,
      posAttr.getY(i) - centroid.y,
      posAttr.getZ(i) - centroid.z,
    );
  }
  posAttr.needsUpdate = true;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeVertexNormals();
  mesh.position.copy(centroid);

  // ── Rapier rigid body ──────────────────────────────────────────────────────
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(centroid.x, centroid.y, centroid.z)
    .setLinearDamping(LIN_DAMPING)
    .setAngularDamping(ANG_DAMPING);

  const rigidBody = world.createRigidBody(bodyDesc);

  // ── Collider ───────────────────────────────────────────────────────────────
  const verts = new Float32Array(posAttr.array);
  let collDesc = RAPIER.ColliderDesc.convexHull(verts);

  if (!collDesc) {
    // Degenerate / coplanar   fall back to AABB cuboid
    mesh.geometry.computeBoundingBox();
    const bb   = mesh.geometry.boundingBox;
    const half = new THREE.Vector3();
    bb.getSize(half).multiplyScalar(0.5);
    collDesc = RAPIER.ColliderDesc.cuboid(
      Math.max(half.x, 0.05),
      Math.max(half.y, 0.05),
      Math.max(half.z, 0.05),
    );
  }

  collDesc.setRestitution(RESTITUTION).setFriction(FRICTION).setDensity(1.2);
  world.createCollider(collDesc, rigidBody);

  return { mesh, body: rigidBody, carrying: false };
}

// ── Body removal ──────────────────────────────────────────────────────────────

export function removePhysicsBody(pbody) {
  if (pbody?.body) world.removeRigidBody(pbody.body);
}

// ── Carry (kinematic ↔ dynamic) ───────────────────────────────────────────────

export function startCarrying(pbody) {
  if (!pbody?.body) return;
  pbody.carrying = true;
  pbody.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  pbody.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  pbody.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
}

export function stopCarrying(pbody, linVel, angVel) {
  if (!pbody?.body) return;
  pbody.carrying = false;
  pbody.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  if (linVel) pbody.body.setLinvel({ x: linVel.x, y: linVel.y, z: linVel.z }, true);
  if (angVel) pbody.body.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
}

export function setCarryPosition(pbody, x, y, z) {
  pbody?.body?.setNextKinematicTranslation({ x, y, z });
}

// ── Velocity helpers (used when spawning cut pieces) ─────────────────────────

export function setLinearVelocity(pbody, vx, vy, vz) {
  pbody?.body?.setLinvel({ x: vx, y: vy, z: vz }, true);
}

export function setAngularVelocity(pbody, wx, wy, wz) {
  pbody?.body?.setAngvel({ x: wx, y: wy, z: wz }, true);
}

export function getLinearVelocity(pbody) {
  const v = pbody?.body?.linvel() ?? { x: 0, y: 0, z: 0 };
  return new THREE.Vector3(v.x, v.y, v.z);
}

export function freezeBody(pbody) {
  pbody?.body?.setBodyType(RAPIER.RigidBodyType.Fixed, true);
}

export function unfreezeBody(pbody, linVel, angVel) {
  if (!pbody?.body) return;
  pbody.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  if (linVel) pbody.body.setLinvel({ x: linVel.x, y: linVel.y, z: linVel.z }, true);
  if (angVel) pbody.body.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
}

// ── Step + sync ───────────────────────────────────────────────────────────────

export function stepAndSync(bodies) {
  world.step();

  for (const b of bodies) {
    if (!b.body || b.carrying) continue;
    const t = b.body.translation();
    const r = b.body.rotation();
    b.mesh.position.set(t.x, t.y, t.z);
    b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
