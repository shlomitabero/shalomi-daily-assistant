// A real, lightweight 3D city — low-poly boxes on colored district tiles,
// not a photorealistic renderer (section 21: "it needs identity, not
// photorealism"). Built with raw three.js (no React renderer like Fiber)
// so the bundle stays small and the render loop is easy to reason about
// and fully clean up on unmount. Kept deliberately simple for mobile perf:
// no shadows, ~40 low-poly meshes total, antialias on but capped pixel
// ratio.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const COLS = 4;
const SPACING = 7;
const AUTO_ROTATE_RESUME_MS = 3500;
const TAP_MOVE_THRESHOLD_PX = 6;

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function createLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(8, 9, 13, 0.78)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4f5f7';
  ctx.font = '700 26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.6, 0.9, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export default function CityScene3D({ districts, onSelectDistrict, height = 320 }) {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const width = mount.clientWidth;
    const mountHeight = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0a0b12');
    scene.fog = new THREE.Fog('#0a0b12', 22, 50);

    const camera = new THREE.PerspectiveCamera(45, width / mountHeight, 0.1, 100);
    camera.position.set(13, 15, 19);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, mountHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 9;
    controls.maxDistance = 32;
    controls.maxPolarAngle = Math.PI / 2.25;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.HemisphereLight('#8aa0ff', '#1a0f20', 1.0));
    const sun = new THREE.DirectionalLight('#ffe9c2', 1.0);
    sun.position.set(10, 18, 8);
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: '#0d0f16', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);

    const clickable = [];
    const rows = Math.ceil(districts.length / COLS);

    districts.forEach((d, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = (col - (COLS - 1) / 2) * SPACING;
      const z = (row - (rows - 1) / 2) * SPACING;
      const rand = seededRandom(d.id.length * 17 + d.id.charCodeAt(0));

      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(SPACING - 1.4, 0.3, SPACING - 1.4),
        new THREE.MeshStandardMaterial({ color: d.color, emissive: d.color, emissiveIntensity: 0.12, roughness: 0.7 }),
      );
      tile.position.set(x, 0.15, z);
      tile.userData.districtId = d.id;
      scene.add(tile);
      clickable.push(tile);

      const buildingCount = 2 + Math.floor(rand() * 2);
      for (let b = 0; b < buildingCount; b++) {
        const isPlayerBuilding = d.presence > 0 && b === 0;
        const h = isPlayerBuilding ? 2.3 + rand() * 1.4 : 0.8 + rand() * 2.1;
        const w = 0.7 + rand() * 0.5;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, w),
          new THREE.MeshStandardMaterial({
            color: isPlayerBuilding ? '#f0b93d' : '#cfd3dc',
            emissive: isPlayerBuilding ? '#f0b93d' : '#000000',
            emissiveIntensity: isPlayerBuilding ? 0.4 : 0,
            roughness: 0.5,
          }),
        );
        const bx = x + (rand() - 0.5) * (SPACING - 2.4);
        const bz = z + (rand() - 0.5) * (SPACING - 2.4);
        mesh.position.set(bx, h / 2 + 0.3, bz);
        mesh.userData.districtId = d.id;
        scene.add(mesh);
        clickable.push(mesh);
      }

      const label = createLabelSprite(`${d.icon} ${d.name}`);
      label.position.set(x, 3.8, z);
      scene.add(label);
    });

    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();
    let downPoint = null;
    let resumeTimer = null;

    function screenPoint(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      return { cx, cy, rect };
    }

    function onPointerDown(e) {
      downPoint = screenPoint(e);
      controls.autoRotate = false;
      if (resumeTimer) clearTimeout(resumeTimer);
    }

    function onPointerUp(e) {
      if (downPoint) {
        const up = screenPoint(e);
        const moved = Math.hypot(up.cx - downPoint.cx, up.cy - downPoint.cy);
        if (moved < TAP_MOVE_THRESHOLD_PX) {
          pointerNDC.x = ((up.cx - up.rect.left) / up.rect.width) * 2 - 1;
          pointerNDC.y = -((up.cy - up.rect.top) / up.rect.height) * 2 + 1;
          raycaster.setFromCamera(pointerNDC, camera);
          const hits = raycaster.intersectObjects(clickable, false);
          if (hits.length) onSelectDistrict?.(hits[0].object.userData.districtId);
        }
      }
      downPoint = null;
      resumeTimer = setTimeout(() => { controls.autoRotate = true; }, AUTO_ROTATE_RESUME_MS);
    }

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointerup', onPointerUp);

    let rafId;
    function animate() {
      controls.update();
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(animate);
    }
    animate();

    function handleResize() {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      if (resumeTimer) clearTimeout(resumeTimer);
      window.removeEventListener('resize', handleResize);
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => { m.map?.dispose(); m.dispose(); });
        }
      });
      if (mount.contains(dom)) mount.removeChild(dom);
    };
  }, [districts, onSelectDistrict]);

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', height, borderRadius: 18, overflow: 'hidden', touchAction: 'none' }}
    />
  );
}
