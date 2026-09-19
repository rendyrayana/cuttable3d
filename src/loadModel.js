import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const TARGET_SIZE = 40; // scale model to fit within this cube

export function loadModel(scene) {
  const loader = new STLLoader();

  return new Promise((resolve, reject) => {
    loader.load(
      './sample-model.stl',
      (geometry) => {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = TARGET_SIZE / maxDim;

        geometry.scale(scale, scale, scale);
        geometry.computeBoundingBox();

        // Center XZ, sit on y = 0
        const nb = geometry.boundingBox;
        const cx = (nb.min.x + nb.max.x) / 2;
        const cz = (nb.min.z + nb.max.z) / 2;
        geometry.translate(-cx, -nb.min.y, -cz);

        geometry.computeVertexNormals();

        // three-bvh-csg requires all CSG operands to have the same attribute
        // set.  BoxGeometry (used as the cutting slab) includes 'uv'; add a
        // zero-filled uv here so the attribute merge doesn't crash.
        if (!geometry.attributes.uv) {
          const count = geometry.attributes.position.count;
          geometry.setAttribute(
            'uv',
            new THREE.BufferAttribute(new Float32Array(count * 2), 2),
          );
        }

        const material = new THREE.MeshStandardMaterial({
          color:       0x5588cc,
          roughness:   0.92,
          metalness:   0.0,
          flatShading: true,
          side:        THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        scene.add(mesh);

        resolve(mesh);
      },
      undefined,
      reject,
    );
  });
}
