/**
 * joint.js   peg + socket generation at the cut cross-section.
 *
 * NOTE: three-bvh-csg ≥ 0.0.17 requires Brush instances as CSG operands.
 * All mesh inputs to Evaluator.evaluate() must be Brush objects.
 */

import * as THREE from 'three';
import { Evaluator, ADDITION, SUBTRACTION, Brush } from 'three-bvh-csg';

// toBrush helper is no longer exported from cut.js (CSG removed from cut path).
// Replicate a minimal version here for the joint step only.
function toBrush(mesh) {
  const b = new Brush(mesh.geometry, mesh.material);
  b.position.copy(mesh.position);
  b.quaternion.copy(mesh.quaternion);
  b.scale.copy(mesh.scale);
  b.updateMatrixWorld(true);
  return b;
}

const PEG_RADIUS    = 2.5;
const PEG_PROTRUDE  = 5.0;
const PEG_EMBED     = 1.5;
const SOCKET_RADIUS = 2.85;
const SOCKET_EXTRA  = 1.0;
const CYL_SEGS      = 32;

function quatAlignY(targetDir) {
  const from = new THREE.Vector3(0, 1, 0);
  const to   = targetDir.clone().normalize();
  const dot  = from.dot(to);
  const q    = new THREE.Quaternion();
  if (dot > 0.9999) return q;
  if (dot < -0.9999) {
    const perp = Math.abs(from.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 0, 1);
    return q.setFromAxisAngle(perp, Math.PI);
  }
  return q.setFromUnitVectors(from, to);
}

const _evaluator = new Evaluator();
_evaluator.useGroups = false;

export function applyJoint(pieceA, pieceB, plane, scene) {
  // Project pieceA's centroid onto the cut plane to find the joint centre
  const boxA       = new THREE.Box3().setFromObject(pieceA);
  const centA      = boxA.getCenter(new THREE.Vector3());
  const dist       = plane.distanceToPoint(centA);
  const jointCenter = centA.clone().addScaledVector(plane.normal, -dist);

  const pegQ    = quatAlignY(plane.normal);
  const pegHeight = PEG_PROTRUDE + PEG_EMBED;

  // Peg: embed end inside pieceA (+normal), tip inside pieceB (−normal)
  const pegCenter = jointCenter.clone().addScaledVector(plane.normal, (PEG_EMBED - PEG_PROTRUDE) / 2);
  const pegBrush  = new Brush(new THREE.CylinderGeometry(PEG_RADIUS, PEG_RADIUS, pegHeight, CYL_SEGS));
  pegBrush.quaternion.copy(pegQ);
  pegBrush.position.copy(pegCenter);
  pegBrush.updateMatrixWorld(true);

  // Socket: from cut face into pieceB
  const socketHeight = PEG_PROTRUDE + SOCKET_EXTRA;
  const socketCenter = jointCenter.clone().addScaledVector(plane.normal, -socketHeight / 2);
  const socketBrush  = new Brush(new THREE.CylinderGeometry(SOCKET_RADIUS, SOCKET_RADIUS, socketHeight, CYL_SEGS));
  socketBrush.quaternion.copy(pegQ);
  socketBrush.position.copy(socketCenter);
  socketBrush.updateMatrixWorld(true);

  // Wrap the cut pieces as Brushes for CSG input
  const brushA = toBrush(pieceA);
  const brushB = toBrush(pieceB);

  let newA = pieceA;
  let newB = pieceB;

  try {
    const withPeg = _evaluator.evaluate(brushA, pegBrush, ADDITION);
    withPeg.material = pieceA.material;
    withPeg.castShadow = true;
    newA = withPeg;
  } catch (err) {
    console.warn('[joint] Peg union failed   skipping peg:', err);
  }

  try {
    const withSocket = _evaluator.evaluate(brushB, socketBrush, SUBTRACTION);
    withSocket.material = pieceB.material;
    withSocket.castShadow = true;
    newB = withSocket;
  } catch (err) {
    console.warn('[joint] Socket subtraction failed   skipping socket:', err);
  }

  scene.remove(pieceA);
  scene.remove(pieceB);
  scene.add(newA);
  scene.add(newB);

  return { pieceA: newA, pieceB: newB };
}
