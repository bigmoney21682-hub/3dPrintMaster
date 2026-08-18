import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Mesh as PrintMesh } from '../lib/mesh';
import { meshBounds } from '../lib/mesh';

/** Turntable preview of a reconstructed mesh, sitting on a build plate. */
export function ModelViewer({ mesh, hint }: { mesh: PrintMesh | null; hint?: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const scene = useRef<THREE.Scene>();
  const renderer = useRef<THREE.WebGLRenderer>();
  const camera = useRef<THREE.PerspectiveCamera>();
  const controls = useRef<OrbitControls>();
  const model = useRef<THREE.Mesh>();
  const plate = useRef<THREE.Group>();

  useEffect(() => {
    const el = holder.current;
    if (!el) return;

    const rend = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    rend.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rend.setSize(el.clientWidth, el.clientHeight, false);
    el.appendChild(rend.domElement);

    const scn = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(38, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 5000);
    cam.position.set(90, 70, 120);

    const ctr = new OrbitControls(cam, rend.domElement);
    ctr.enableDamping = true;
    ctr.dampingFactor = 0.08;
    ctr.enablePan = false;

    scn.add(new THREE.HemisphereLight(0xbfe3ff, 0x18203a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(60, 110, 80);
    scn.add(key);
    const rim = new THREE.DirectionalLight(0x7fd4ff, 0.7);
    rim.position.set(-80, 40, -60);
    scn.add(rim);

    const plateGroup = new THREE.Group();
    scn.add(plateGroup);
    plate.current = plateGroup;

    scene.current = scn;
    renderer.current = rend;
    camera.current = cam;
    controls.current = ctr;

    let raf = 0;
    const tick = () => {
      ctr.update();
      rend.render(scn, cam);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      rend.setSize(w, h, false);
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctr.dispose();
      rend.dispose();
      rend.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const scn = scene.current;
    const cam = camera.current;
    const ctr = controls.current;
    const plateGroup = plate.current;
    if (!scn || !cam || !ctr || !plateGroup) return;

    if (model.current) {
      scn.remove(model.current);
      model.current.geometry.dispose();
      (model.current.material as THREE.Material).dispose();
      model.current = undefined;
    }
    plateGroup.clear();
    if (!mesh || mesh.indices.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x9fb6d8,
      metalness: 0.08,
      roughness: 0.62,
      side: THREE.DoubleSide,
    });
    const obj = new THREE.Mesh(geometry, material);
    scn.add(obj);
    model.current = obj;

    const b = meshBounds(mesh);
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const centre = new THREE.Vector3(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    );
    const longest = Math.max(size[0], size[1], size[2], 1);

    const grid = new THREE.GridHelper(longest * 3, 12, 0x2c3b63, 0x1d2745);
    grid.position.set(centre.x, b.min[1], centre.z);
    plateGroup.add(grid);

    ctr.target.copy(centre);
    cam.position.set(centre.x + longest * 1.15, centre.y + longest * 0.85, centre.z + longest * 1.5);
    cam.near = longest / 100;
    cam.far = longest * 60;
    cam.updateProjectionMatrix();
    ctr.update();
  }, [mesh]);

  return (
    <div className="viewer" ref={holder}>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
