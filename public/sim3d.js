// Aquarium 3D (Three.js) : le décor, les poissons et les plantes réagissent à la lumière de la lampe.
// Le module ne connaît ni l'heure ni les profils : la page lui transmet l'état de la lumière via setLight().
// Le décor reproduit le bac réel (photo de référence 2000×1500 px). Toutes les textures sont générées
// à la volée (canvas) : aucun fichier à télécharger en dehors de Three.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Dimensions du bac (1 unité ≈ 10 cm) : bac long type Juwel Rio
const W = 14, H = 5.6, D = 5.2, WATER = 5.15;

// Sol de sable fin presque plat, à peine plus haut à l'arrière
const sandY = (x, z) => 0.38 + (0.5 - z / D) * 0.22 + Math.sin(x * 0.7) * 0.04 + Math.cos(x * 1.9 + z * 2.3) * 0.025;
// Repère photo -> scène : x de la vitre gauche (px 60) à la vitre droite (px 1910), y du sable (py 935) à la surface (py 295)
const PX = (px, py, z = 0) => new THREE.Vector3(((px - 985) / 1850) * W, 0.4 + ((935 - py) / 640) * (WATER - 0.5), z);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = THREE.MathUtils.clamp;
function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Livrées de scalaire proposées dans « Mon bac » (même ordre que les peintures générées)
const ANGEL_LIVERIES = ['argenté', 'koi', 'marbré', 'noir', 'doré', 'zèbre'];

export function createAquarium3D(container, { channels, quality = 'high', models = [], population }) {
  const rnd = rng(42);
  const U = {
    uTime: { value: 0 },
    uCaustic: { value: new THREE.Color(0, 0, 0) },
    uCloud: { value: 0 },
    uCloudOff: { value: new THREE.Vector2() },
    uGlow: { value: 0 },
  };

  // ------------------------------------------------------------ rendu
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none' });
  container.prepend(renderer.domElement);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2b2a28');
  scene.fog = new THREE.FogExp2('#0b3a44', 0.022);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);
  camera.position.set(0, 2.75, 17);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2.65, 0);
  controls.enableDamping = true;
  controls.minDistance = 4;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.autoRotateSpeed = 0.5;

  // Reflets (poissons, vitre, surface) : environnement neutre, intensité réglée selon la lumière
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const envMats = []; // { m, k }

  // ------------------------------------------------------------ textures générées
  function canvasTex(w, h, draw, { repeat, srgb = true } = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(...repeat);
    }
    return t;
  }
  // Carte de normales à partir de la luminosité d'une image (relief)
  function normalFrom(tex, strength, repeat) {
    const src = tex.image, w = src.width, h = src.height;
    const d = src.getContext('2d').getImageData(0, 0, w, h).data;
    const L = (x, y) => d[(((y + h) % h) * w + ((x + w) % w)) * 4 + 1] / 255;
    return canvasTex(w, h, (g) => {
      const out = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (L(x + 1, y) - L(x - 1, y)) * strength, dy = (L(x, y + 1) - L(x, y - 1)) * strength;
          const n = 1 / Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
          out.data[i] = (-dx * n * 0.5 + 0.5) * 255;
          out.data[i + 1] = (dy * n * 0.5 + 0.5) * 255;
          out.data[i + 2] = (n * 0.5 + 0.5) * 255;
          out.data[i + 3] = 255;
        }
      }
      g.putImageData(out, 0, 0);
    }, { repeat, srgb: false });
  }

  // Écorce : longues fibres sombres et claires, quelques nœuds (u = longueur de la racine)
  const barkTex = canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#6e4029';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1400; i++) {
      const x = rnd() * w, y = rnd() * h, len = 30 + rnd() * 220, dark = rnd() < 0.55;
      g.strokeStyle = dark ? `rgba(22,11,6,${0.25 + rnd() * 0.45})` : `rgba(160,92,58,${0.12 + rnd() * 0.3})`;
      g.lineWidth = 0.6 + rnd() * 2.6;
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(x + len * 0.3, y + (rnd() - 0.5) * 6, x + len * 0.6, y + (rnd() - 0.5) * 6, x + len, y + (rnd() - 0.5) * 4);
      g.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const x = rnd() * w, y = rnd() * h, r = 6 + rnd() * 14;
      const gr = g.createRadialGradient(x, y, 1, x, y, r);
      gr.addColorStop(0, 'rgba(15,7,4,0.85)');
      gr.addColorStop(1, 'rgba(15,7,4,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(x, y, r * 1.8, r, 0, 0, Math.PI * 2);
      g.fill();
    }
  }, { repeat: [3, 1] });
  const barkNormal = normalFrom(barkTex, 3, [3, 1]);

  // Sable fin : grains clairs, ocres et sombres
  const sandTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#cfb47e';
    g.fillRect(0, 0, w, h);
    const tones = ['#f1e3bd', '#e6cf98', '#c9945a', '#a7804f', '#6d5a40', '#8f8b82', '#fff4d6'];
    for (let i = 0; i < 26000; i++) {
      g.fillStyle = tones[Math.floor(rnd() * tones.length)];
      g.globalAlpha = 0.35 + rnd() * 0.65;
      const s = 0.8 + rnd() * 2.2;
      g.fillRect(rnd() * w, rnd() * h, s, s);
    }
    g.globalAlpha = 1;
  }, { repeat: [5, 2] });
  const sandNormal = normalFrom(sandTex, 1.6, [5, 2]);

  // Ruban de vallisnéria : bords plus sombres, nervure claire, pointe arrondie (niveaux de gris teintés par instance)
  const ribbonTex = canvasTex(64, 512, (g, w, h) => {
    const gx = g.createLinearGradient(0, 0, w, 0);
    [[0, '#7e7e7e'], [0.16, '#dedede'], [0.46, '#f2f2f2'], [0.5, '#ffffff'], [0.54, '#f0f0f0'], [0.84, '#dedede'], [1, '#7e7e7e']].forEach(([o, c]) => gx.addColorStop(o, c));
    g.fillStyle = gx;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < 6; i++) g.fillRect(6 + i * 9, 0, 1, h);
    // Découpe de la pointe : la couleur doit être opaque, sinon toute la feuille devient transparente
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = '#000';
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, 46);
    g.quadraticCurveTo(0, 0, w / 2, 0);
    g.quadraticCurveTo(w, 0, w, 46);
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  });

  // Feuille large : contour, nervure centrale, nervures secondaires (ronde = anubias, lancéolée ondulée = crypto/fougère)
  function leafTex(round, wavy) {
    return canvasTex(256, 256, (g, w, h) => {
      const half = round ? 0.46 : 0.26;
      const edge = (t) => Math.sin(Math.PI * Math.pow(t, round ? 0.8 : 0.62)) * half * w * (wavy ? 1 + 0.08 * Math.sin(t * 46) : 1);
      const path = new Path2D();
      path.moveTo(w / 2, h - 3);
      for (let i = 0; i <= 48; i++) path.lineTo(w / 2 + edge(i / 48), h - 3 - (i / 48) * (h - 6));
      for (let i = 48; i >= 0; i--) path.lineTo(w / 2 - edge(i / 48), h - 3 - (i / 48) * (h - 6));
      path.closePath();
      const gr = g.createRadialGradient(w / 2, h * 0.55, 8, w / 2, h * 0.55, w * 0.62);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(1, '#9c9c9c');
      g.fillStyle = gr;
      g.fill(path);
      g.save();
      g.clip(path);
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(w / 2, h);
      g.lineTo(w / 2, 4);
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.2)';
      g.lineWidth = 1.5;
      for (let i = 1; i < 10; i++) {
        const y = h - i * (h / 10.5);
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(w / 2, y + 6);
          g.quadraticCurveTo(w / 2 + s * w * 0.18, y - 4, w / 2 + s * w * 0.44, y - 20);
          g.stroke();
        }
      }
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 4;
      g.stroke(path);
      g.restore();
    });
  }
  const roundLeaf = leafTex(true, false), lanceLeaf = leafTex(false, true);

  // Rayons de lumière : dégradé vertical strié, défilant doucement
  const rayTex = canvasTex(128, 512, (g, w, h) => {
    for (let x = 0; x < w; x++) {
      const a = Math.pow(Math.sin((x / w) * Math.PI), 2) * (0.45 + 0.55 * Math.abs(Math.sin(x * 0.37) * Math.sin(x * 0.11)));
      const gy = g.createLinearGradient(0, 0, 0, h);
      gy.addColorStop(0, `rgba(255,255,255,${a})`);
      gy.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gy;
      g.fillRect(x, 0, 1, h);
    }
  });
  rayTex.wrapS = THREE.RepeatWrapping;

  // ------------------------------------------------------------ lumières
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.position.set(1.5, 14, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 1024);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 4.5, bottom: -4.5, near: 4, far: 20 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x6b5a3a, 0);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x9fb4c8, 0.02)); // lumière de la pièce

  // ------------------------------------------------------------ pièce, meuble blanc, couvercle, vitres
  // Le bac sert de séparation de pièce : on voit le mur clair derrière (flou par la profondeur de champ)
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(50, 20), new THREE.MeshBasicMaterial({ color: '#6f685e', fog: false }));
  wall.position.set(0, 3, -D / 2 - 4);
  scene.add(wall);
  const white = (r = 0.5) => new THREE.MeshStandardMaterial({ color: '#f2f1ee', roughness: r, emissive: '#7d7c79' });
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };
  box(W + 0.6, 6, D + 0.8, white(0.7), 0, -3.3, 0).receiveShadow = true;
  const seam = new THREE.MeshBasicMaterial({ color: '#9c9a95' });
  for (const x of [-W / 6, W / 6]) box(0.03, 5.4, 0.02, seam, x, -3.4, D / 2 + 0.41);
  box(W + 0.6, 0.03, 0.02, seam, 0, -0.75, D / 2 + 0.41);
  box(W + 0.3, 0.3, D + 0.3, white(), 0, -0.15, 0);
  box(W + 0.3, 0.45, 0.08, white(), 0, 0.2, D / 2 + 0.05);
  box(W + 0.35, 0.5, D + 0.35, white(0.35), 0, H + 0.2, 0);
  for (const x of [-W / 2 - 0.06, W / 2 + 0.06]) box(0.12, H, 0.12, new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.4 }), x, H / 2, D / 2);

  // Rampe LED sous le couvercle : chaque canal brille selon son intensité
  const strips = channels.map((c, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.025, 0.09), new THREE.MeshBasicMaterial({ color: c.color }));
    m.position.set(0, H - 0.08, -0.27 + (i * 0.54) / Math.max(1, channels.length - 1));
    scene.add(m);
    return m;
  });

  const glassMat = new THREE.MeshStandardMaterial({ color: '#cfeff5', transparent: true, opacity: 0.06, roughness: 0.03, metalness: 0, envMap: envTex, depthWrite: false });
  envMats.push({ m: glassMat, k: 0.5 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(W, H), glassMat);
  glass.position.set(0, H / 2, D / 2);
  const meniscus = new THREE.Mesh(new THREE.BoxGeometry(W, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: '#cdeef5', transparent: true, opacity: 0.35 }));
  meniscus.position.set(0, WATER, D / 2);
  scene.add(glass, meniscus);

  // Équipement : chauffage à gauche, filtre noir dans l'angle arrière droit
  const heaterMat = new THREE.MeshStandardMaterial({ color: '#cfe6ea', transparent: true, opacity: 0.5, roughness: 0.08, envMap: envTex });
  envMats.push({ m: heaterMat, k: 0.6 });
  const heater = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.9, 16), heaterMat);
  heater.position.set(-W / 2 + 0.25, 1.75, D / 2 - 0.6);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.18, 16), new THREE.MeshStandardMaterial({ color: '#d4542b', roughness: 0.5 }));
  cap.position.set(-W / 2 + 0.25, 0.85, D / 2 - 0.6);
  scene.add(heater, cap);
  box(1.0, WATER - 0.4, 1.0, new THREE.MeshStandardMaterial({ color: '#141617', roughness: 0.6 }), W / 2 - 0.55, (WATER - 0.4) / 2 + 0.25, -D / 2 + 0.55).castShadow = true;

  // ------------------------------------------------------------ sol avec caustiques et ombres de nuages
  const sandGeo = new THREE.PlaneGeometry(W - 0.02, D - 0.02, 140, 52);
  sandGeo.rotateX(-Math.PI / 2);
  const sp = sandGeo.attributes.position;
  for (let i = 0; i < sp.count; i++) sp.setY(i, sandY(sp.getX(i), sp.getZ(i)) + (rnd() - 0.5) * 0.012);
  sandGeo.computeVertexNormals();
  const sandMat = new THREE.MeshStandardMaterial({ map: sandTex, normalMap: sandNormal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1 });
  sandMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uTime; uniform vec3 uCaustic; uniform float uCloud; uniform vec2 uCloudOff;
        float caustic(vec2 p, float t) {
          p *= 1.6;
          vec2 q = p + vec2(sin(p.y * 1.7 + t * 0.9), cos(p.x * 1.3 - t * 0.7)) * 0.6;
          float a = sin(q.x * 2.3 + t) + sin(q.y * 2.9 - t * 1.2) + sin((q.x + q.y) * 1.9 + t * 0.6);
          return pow(clamp(1.0 - abs(a) / 1.5, 0.0, 1.0), 6.0);
        }
        float cloudShade(vec2 p) {
          float n = 0.5 + 0.28 * sin(p.x * 0.42 + uCloudOff.x) * sin(p.y * 0.55 - uCloudOff.y)
                  + 0.22 * sin(p.x * 0.19 - uCloudOff.x * 0.6 + p.y * 0.25);
          return 1.0 - uCloud * smoothstep(0.45, 0.8, n);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float shade = cloudShade(vWPos.xz);
        diffuseColor.rgb *= mix(1.0, shade, 0.85);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uCaustic * caustic(vWPos.xz, uTime * 0.8) * shade;`);
  };
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.receiveShadow = true;
  scene.add(sand);

  // Quelques petites pierres plates posées sur le sable
  function stone(v, r) {
    const g = new THREE.IcosahedronGeometry(r, 3);
    const p = g.attributes.position, t = new THREE.Vector3(), a = rnd() * 10;
    for (let i = 0; i < p.count; i++) {
      t.fromBufferAttribute(p, i);
      t.multiplyScalar(1 + 0.15 * Math.sin((t.x * 4) / r + a) * Math.cos((t.z * 3) / r));
      p.setXYZ(i, t.x * 1.3, t.y * 0.35, t.z);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#3d4144', roughness: 0.85 }));
    m.position.set(v.x, sandY(v.x, v.z) + r * 0.12, v.z);
    m.rotation.y = rnd() * 6;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  stone(PX(340, 915, 1.6), 0.28);
  stone(PX(1410, 935, 1.9), 0.25);
  stone(PX(1050, 940, 1.4), 0.16);

  // ------------------------------------------------------------ bois : grosses racines texturées, disposées comme sur la photo
  const woodMats = ['#ffffff', '#e2cdbf', '#f3dccb'].map((c) => new THREE.MeshStandardMaterial({ color: c, map: barkTex, normalMap: barkNormal, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.88 }));
  function root(points, r0, r1) {
    const curve = new THREE.CatmullRomCurve3(points);
    const seg = 64, rad = 14, mat = woodMats[Math.floor(rnd() * woodMats.length)];
    const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
    const p = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3(), ph = rnd() * 10;
    // Rayon effilé et irrégulier : nœuds, section aplatie, bosses
    for (let i = 0; i <= seg; i++) {
      curve.getPointAt(i / seg, c);
      const r = 1.35 * THREE.MathUtils.lerp(r0, r1, i / seg) * (1 + 0.14 * Math.sin(i * 0.9 + ph) + 0.07 * Math.sin(i * 3.1 + ph));
      for (let j = 0; j <= rad; j++) {
        const k = i * (rad + 1) + j;
        const bump = 1 + 0.1 * Math.sin(j * 2.1 + i * 0.7 + ph) + 0.06 * Math.sin(j * 5.3 - i * 1.3);
        v.fromBufferAttribute(p, k).sub(c).multiplyScalar(r * bump);
        p.setXYZ(k, c.x + v.x, c.y + v.y, c.z + v.z);
      }
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    for (const [pt, r] of [[points[0], r0], [points[points.length - 1], r1]]) {
      const end = new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 12, 10), mat);
      end.position.copy(pt);
      end.scale.set(1, 0.85, 1);
      end.castShadow = true;
      scene.add(end);
    }
  }
  // « A » de gauche : tronc couché et branche qui remonte vers le centre
  root([PX(660, 930, 0.9), PX(480, 810, 0.5), PX(320, 730, 0.1), PX(190, 690, -0.3)], 0.42, 0.3);
  root([PX(300, 760, 0.2), PX(470, 600, -0.4), PX(650, 500, -0.9), PX(800, 455, -1.1)], 0.3, 0.12);
  root([PX(420, 830, 0.6), PX(380, 640, -0.2), PX(430, 470, -1.0)], 0.2, 0.08);
  // Grande diagonale centrale
  root([PX(770, 450, -1.15), PX(890, 590, -0.7), PX(1040, 760, 0.0), PX(1230, 935, 0.7)], 0.24, 0.42);
  root([PX(880, 580, -0.8), PX(960, 480, -1.15), PX(1010, 420, -1.3)], 0.14, 0.06);
  // Souche de droite
  root([PX(1280, 470, -1.2), PX(1330, 600, -0.8), PX(1420, 760, -0.3), PX(1520, 885, 0.3)], 0.14, 0.34);
  root([PX(1440, 620, -0.9), PX(1580, 690, -0.6), PX(1690, 860, -0.2)], 0.22, 0.36);
  root([PX(1340, 890, 0.5), PX(1520, 900, 0.3), PX(1720, 880, -0.1)], 0.3, 0.26);

  // ------------------------------------------------------------ modèles réels (facultatifs, générés par npm run models)
  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const loadModel = (name) => gltfLoader.loadAsync(`models/opt/${name}.glb`);
  // Souche scannée (Poly Haven) : au pied de la souche de droite et sous le « A » de gauche, teintée brun-rouge
  if (models.includes('root_cluster')) {
    loadModel('root_cluster').then((g) => {
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = true;
        o.material.color.set('#c98e70');
      });
      for (const [x, z, s, ry] of [[3.9, 0.3, 0.9, 0.5], [-3.9, 1.0, 0.6, 2.4]]) {
        const r = g.scene.clone();
        r.scale.setScalar(s);
        r.rotation.y = ry;
        r.position.set(x, sandY(x, z) - 0.06, z);
        scene.add(r);
      }
    }).catch((e) => console.warn('Modèle root_cluster indisponible', e));
  }

  // ------------------------------------------------------------ plantes (ondulation dans le vertex shader)
  const tips = []; // sommets des feuilles, pour le perlage
  const glowMats = []; // { m, k } : lueur à contre-jour, proportionnelle à la lumière
  function swayMaterial(amp, map, glow) {
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6, map, alphaTest: 0.5 });
    if (glow) {
      m.emissive.set(glow[0]);
      m.emissiveMap = map;
      glowMats.push({ m, k: glow[1] });
    }
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aPhase;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float hh = max(position.y, 0.0);
          transformed.x += sin(uTime * 0.9 + aPhase) * ${amp.toFixed(3)} * hh * hh;
          transformed.z += cos(uTime * 0.7 + aPhase * 1.3) * ${(amp * 0.6).toFixed(3)} * hh * hh;`);
    };
    return m;
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S3 = new THREE.Vector3(), P3 = new THREE.Vector3(), C = new THREE.Color();
  // place(i) -> { x, z, y?, h, rot, scale, color } ; sans y, la plante est posée sur le sable
  function plantMesh(geo, count, amp, map, place, glow) {
    const mesh = new THREE.InstancedMesh(geo, swayMaterial(amp, map, glow), count);
    const ph = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const { x, z, y, h, rot, scale, color } = place(i);
      P3.set(x, y ?? sandY(x, z) - 0.05, z);
      E.copy(rot);
      mesh.setMatrixAt(i, M4.compose(P3, Q.setFromEuler(E), S3.copy(scale)));
      mesh.setColorAt(i, color);
      ph[i] = rnd() * 6.28;
      if (h) tips.push(new THREE.Vector3(x, P3.y + h * 0.95, z));
    }
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    // Ombres découpées selon la forme réelle des feuilles
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5 });
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
  // Ruban courbé et légèrement vrillé
  function ribbonGeo(width, bend, twist) {
    const g = new THREE.PlaneGeometry(width, 1, 1, 18);
    g.translate(0, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), a = twist * y;
      p.setXYZ(i, x * Math.cos(a) * (1 - y * 0.2), y, x * Math.sin(a) + bend * y * y);
    }
    g.computeVertexNormals();
    return g;
  }
  // Touffes de rubans dans une zone (vallisnérias, tiges, sagittaires), en 3 formes de courbure
  function blades(count, width, amp, area, hMin, hMax, hsl, glow) {
    for (let v = 0; v < 3; v++) {
      const n = Math.round(count / 3);
      plantMesh(ribbonGeo(width, 0.15 + v * 0.18, (v - 1) * 0.9), n, amp, ribbonTex, () => {
        const x = area.x0 + rnd() * (area.x1 - area.x0), z = area.z0 + rnd() * (area.z1 - area.z0);
        const h = Math.min(hMin + rnd() * (hMax - hMin), WATER - sandY(x, z) - 0.12);
        return {
          x, z, h,
          rot: new THREE.Euler((rnd() - 0.5) * 0.22, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.22),
          scale: new THREE.Vector3(1, h, 1),
          color: C.setHSL(hsl[0] + rnd() * hsl[1], hsl[2], hsl[3] + rnd() * hsl[4]).clone(),
        };
      }, glow);
    }
  }
  const VALLIS = [0.25, 0.06, 0.6, 0.3, 0.14], VALLIS_GLOW = ['#4f8f1f', 0.3];
  const xL = -W / 2 + 0.25, xR = W / 2 - 0.25;
  // Vallisnérias géantes sur tout l'arrière et les côtés, jusqu'à la surface
  blades(390, 0.16, 0.3, { x0: xL, x1: xR, z0: -D / 2 + 0.12, z1: -D / 2 + 0.95 }, 3.6, 5.2, VALLIS, VALLIS_GLOW);
  blades(105, 0.16, 0.3, { x0: xL, x1: xL + 1.8, z0: -1.2, z1: 1.2 }, 3.0, 5.0, VALLIS, VALLIS_GLOW);
  blades(120, 0.16, 0.3, { x0: xR - 2.2, x1: xR, z0: -1.0, z1: 1.4 }, 3.0, 5.0, VALLIS, VALLIS_GLOW);
  // Plantes à tiges rouges (en haut à gauche et à droite) et vert clair (à droite)
  blades(72, 0.09, 0.2, { x0: PX(410, 0).x, x1: PX(560, 0).x, z0: -D / 2 + 0.3, z1: -D / 2 + 1.0 }, 3.4, 4.6, [0.95, 0.03, 0.5, 0.45, 0.12]);
  blades(60, 0.09, 0.2, { x0: PX(1500, 0).x, x1: PX(1620, 0).x, z0: -D / 2 + 0.4, z1: -D / 2 + 1.2 }, 3.0, 4.2, [0.96, 0.03, 0.45, 0.48, 0.12]);
  blades(72, 0.08, 0.2, { x0: PX(1460, 0).x, x1: PX(1640, 0).x, z0: -0.6, z1: 0.4 }, 2.6, 4.0, [0.2, 0.04, 0.6, 0.5, 0.1], ['#7fb83a', 0.25]);
  // Petites sagittaires éparses devant
  blades(150, 0.07, 0.08, { x0: xL, x1: xR, z0: D / 2 - 1.6, z1: D / 2 - 0.3 }, 0.25, 0.9, [0.25, 0.05, 0.55, 0.32, 0.12]);

  // Feuilles de vallisnéria couchées sous la surface : la bande verte du haut et l'ombre tachetée au sol
  plantMesh(ribbonGeo(0.17, 0.05, 0.6), 240, 0.12, ribbonTex, () => {
    const x = xL + rnd() * (xR - xL), z = -D / 2 + 0.3 + rnd() * (D - 0.8);
    // Surtout dans la longueur du bac ; la feuille part dans la direction (-sin a, 0, -cos a)
    const a = (rnd() < 0.5 ? 1 : -1) * Math.PI / 2 + (rnd() - 0.5) * 0.9;
    const dx = -Math.sin(a), dz = -Math.cos(a);
    const room = Math.min(dx > 0 ? (xR - x) / dx : dx < 0 ? (xL - x) / dx : 99, dz > 0 ? (D / 2 - 0.25 - z) / dz : dz < 0 ? (-D / 2 + 0.25 - z) / dz : 99);
    const len = Math.max(0.4, Math.min(1.5 + rnd() * 2.5, room));
    return {
      x, z, y: WATER - 0.07 - rnd() * 0.18,
      rot: new THREE.Euler(-Math.PI / 2 + (rnd() - 0.5) * 0.12, a, 0, 'YXZ'),
      scale: new THREE.Vector3(1, len, 1),
      color: C.setHSL(0.24 + rnd() * 0.05, 0.65, 0.42 + rnd() * 0.12).clone(),
    };
  }, ['#7fc23a', 0.7]);

  // Feuille large : plan courbé (creusé au centre, recourbé vers l'extérieur)
  function leafGeo() {
    const g = new THREE.PlaneGeometry(1, 1, 6, 10);
    g.translate(0, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getY(i) ** 2 * 0.4 + p.getX(i) ** 2 * 0.45);
    g.computeVertexNormals();
    return g;
  }
  // Rosettes : n feuilles autour d'un point (sur le sable ou sur le bois)
  function rosettes(map, aspect, centers, n, amp, len, tilt, hsl, onWood) {
    return plantMesh(leafGeo(), centers.length * n, amp, map, (i) => {
      const c = centers[Math.floor(i / n)], l = len[0] + rnd() * (len[1] - len[0]);
      return {
        x: c.x + (rnd() - 0.5) * 0.2, z: c.z + (rnd() - 0.5) * 0.2, y: onWood ? c.y : undefined, h: l * 0.6,
        rot: new THREE.Euler(tilt[0] + rnd() * (tilt[1] - tilt[0]), ((i % n) / n) * Math.PI * 2 + rnd() * 0.4, 0, 'YXZ'),
        scale: new THREE.Vector3(l * aspect, l, l),
        color: C.setHSL(hsl[0] + rnd() * hsl[1], hsl[2], hsl[3] + rnd() * hsl[4]).clone(),
      };
    });
  }
  // Cryptocorynes au premier plan (vert-brun, bord ondulé)
  rosettes(lanceLeaf, 0.6, [PX(150, 870, 1.3), PX(250, 880, 1.6), PX(800, 860, 1.1), PX(900, 880, 1.4), PX(1300, 880, 1.2), PX(1200, 895, 1.7)], 14, 0.06, [0.7, 1.2], [0.5, 1.1], [0.1, 0.12, 0.45, 0.24, 0.1]);
  // Anubias fixés sur le bois (feuilles ovales vert foncé, brillantes)
  const ANUBIAS_SPOTS = [PX(500, 560, -0.3), PX(560, 600, -0.1), PX(920, 560, -0.7), PX(1050, 660, -0.2), PX(1180, 600, -0.6), PX(1560, 690, -0.5)];
  const JAVA_SPOTS = [PX(290, 600, -0.4), PX(330, 640, 0.1)];
  const procAnubias = rosettes(roundLeaf, 0.85, ANUBIAS_SPOTS, 13, 0.04, [0.5, 0.8], [0.6, 1.3], [0.3, 0.04, 0.55, 0.24, 0.1], true);
  // Fougère de Java à gauche (feuilles longues et étroites)
  const procJava = rosettes(lanceLeaf, 0.45, JAVA_SPOTS, 12, 0.08, [0.9, 1.5], [0.3, 0.9], [0.27, 0.04, 0.5, 0.34, 0.1], true);

  // ------------------------------------------------------------ eau : surface, rayons, particules en suspension
  const surfGeo = new THREE.PlaneGeometry(W, D, 56, 22);
  surfGeo.rotateX(-Math.PI / 2);
  const surfBase = surfGeo.attributes.position.array.slice();
  const surfMat = new THREE.MeshStandardMaterial({ color: '#9ad7e6', transparent: true, opacity: 0.28, roughness: 0.08, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false, envMap: envTex });
  envMats.push({ m: surfMat, k: 0.9 });
  const surf = new THREE.Mesh(surfGeo, surfMat);
  surf.position.y = WATER;
  scene.add(surf);

  const rays = Array.from({ length: 9 }, (_, i) => {
    const mat = new THREE.MeshBasicMaterial({ map: rayTex.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false });
    mat.map.wrapS = THREE.RepeatWrapping;
    mat.map.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8 + rnd() * 1.2, WATER - 0.3), mat);
    m.position.set(-6.2 + i * 1.55 + rnd() * 0.5, WATER / 2 + 0.1, -0.8 + rnd() * 1.8);
    m.rotation.z = -0.14 + rnd() * 0.08;
    scene.add(m);
    return { m, x: m.position.x, ph: rnd() * 6, sp: 0.01 + rnd() * 0.02 };
  });

  // Particules en suspension : elles accrochent la lumière et donnent de la profondeur à l'eau
  const NS = 380;
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const snowMat = new THREE.PointsMaterial({ color: '#ffffff', size: 0.028, transparent: true, opacity: 0.55, depthWrite: false });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  scene.add(snow);
  const snowData = Array.from({ length: NS }, () => ({ x: (rnd() - 0.5) * (W - 0.4), y: 0.5 + rnd() * (WATER - 0.7), z: (rnd() - 0.5) * (D - 0.4), ph: rnd() * 6, v: 0.02 + rnd() * 0.04 }));

  // Perlage des plantes (bulles d'oxygène)
  const pearls = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(160 * 3), 3).setUsage(THREE.DynamicDrawUsage)),
    new THREE.PointsMaterial({ color: '#f0fbff', size: 0.04, transparent: true, opacity: 0.9, depthWrite: false })
  );
  pearls.frustumCulled = false;
  scene.add(pearls);
  const pearlData = Array.from({ length: 160 }, () => ({ tip: tips[Math.floor(rnd() * tips.length)], t: rnd() * 3, life: 1.5 + rnd() * 2.5 }));

  // ------------------------------------------------------------ poissons
  // Corps = sphère déformée (tête vers +x) + nageoires plates ; la queue ondule dans le vertex shader.
  // L'attribut « glow » rend certaines zones iridescentes (bande des néons).
  const bodyShape = (k) => (x, y, z) => {
    if (x < 0) { const t = 1 + x * k.taper; y *= t; z *= t; }
    if (x > 0.55) { const t = 1 - (x - 0.55) * 0.55; y *= t; z *= t; }
    if (k.flatBelly && y < -0.3) y = -0.3 + (y + 0.3) * 0.4;
    return [x, y, z];
  };
  function finsFor(L, Hh, f) {
    const xt = -L * 0.44, tl = L * f.tail, th = Hh * f.tailH, out = [];
    out.push((s) => {
      s.moveTo(xt + L * 0.08, 0);
      s.quadraticCurveTo(xt - tl * 0.4, th * 0.55, xt - tl, th);
      s.quadraticCurveTo(xt - tl * 0.62, 0, xt - tl, -th);
      s.quadraticCurveTo(xt - tl * 0.4, -th * 0.55, xt + L * 0.08, 0);
    });
    if (f.dorsal) out.push((s) => {
      const b = Hh * 0.4;
      s.moveTo(L * 0.12, b);
      s.quadraticCurveTo(L * 0.02, b + Hh * f.dorsal * 0.9, -L * f.sweep, b + Hh * f.dorsal);
      s.quadraticCurveTo(-L * 0.18, b + Hh * 0.15, -L * 0.28, b * 0.7);
      s.lineTo(L * 0.12, b);
    });
    if (f.anal) out.push((s) => {
      const b = -Hh * 0.4;
      s.moveTo(L * 0.05, b);
      s.quadraticCurveTo(-L * 0.02, b - Hh * f.anal * 0.9, -L * f.sweep, b - Hh * f.anal);
      s.quadraticCurveTo(-L * 0.2, b - Hh * 0.15, -L * 0.3, b * 0.7);
      s.lineTo(L * 0.05, b);
    });
    if (f.filaments) out.push((s) => {
      s.moveTo(L * 0.2, -Hh * 0.38);
      s.lineTo(L * 0.03, -Hh * 2.3);
      s.lineTo(L * 0.13, -Hh * 0.42);
    });
    return out;
  }
  function fishGeometry(cfg, paint) {
    const g = new THREE.SphereGeometry(1, 28, 16);
    const p = g.attributes.position, col = [], glow = [], cc = new THREE.Color(), shape = bodyShape(cfg.body);
    for (let i = 0; i < p.count; i++) {
      const [x, y, z] = shape(p.getX(i), p.getY(i), p.getZ(i));
      const [hex, gl = 0] = paint.body(x, y, z);
      cc.set(hex);
      col.push(cc.r, cc.g, cc.b);
      glow.push(gl);
      p.setXYZ(i, (x * cfg.len) / 2, (y * cfg.h) / 2, (z * cfg.w) / 2);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 1));
    g.computeVertexNormals();
    const parts = [g];
    cc.set(paint.fin);
    for (const build of finsFor(cfg.len, cfg.h, cfg.fins)) {
      const s = new THREE.Shape();
      build(s);
      const fg = new THREE.ShapeGeometry(s, 8);
      const n = fg.attributes.position.count;
      fg.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, k) => [cc.r, cc.g, cc.b][k % 3]), 3));
      fg.setAttribute('glow', new THREE.Float32BufferAttribute(new Array(n).fill(paint.finGlow || 0), 1));
      parts.push(fg);
    }
    return mergeGeometries(parts);
  }
  const eye = (x, y, z) => x > 0.74 && y > 0.02 && Math.abs(z) > 0.38;
  const fishMaterial = (len) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.25, side: THREE.DoubleSide, envMap: envTex });
    envMats.push({ m, k: 0.9 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uGlow = U.uGlow;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nattribute float aAmp;\nattribute float glow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vGlow = glow;
          float kb = clamp(0.25 - position.x / ${(len / 2).toFixed(3)} * 0.8, 0.0, 1.5);
          transformed.z += sin(aPhase + position.x * ${(7 / len).toFixed(2)}) * aAmp * kb * kb;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlow;');
    };
    return m;
  };

  // Une espèce peut avoir plusieurs livrées : une variante par poisson, à tour de rôle
  const SPECIES = {
    neon: {
      n: 32, len: 0.44, h: 0.12, w: 0.07, amp: 0.04, freq: 14, maxPitch: 0.3, minS: 0.25, maxS: 1.5, view: 1.3, sepR: 0.4, school: true, wander: 0.6,
      body: { taper: 0.55 }, fins: { tail: 0.24, tailH: 0.6, dorsal: 0.35, anal: 0.32, sweep: 0.06 },
      paints: [{
        body: (x, y, z) => (eye(x, y, z) ? ['#0c0c0c'] : y > 0.08 && y < 0.5 && x > -0.82 ? ['#1fd3ff', 1] : y < 0.02 && x > -0.9 ? ['#e0233a', 0.25] : y >= 0.5 ? ['#7d8a73'] : ['#e9eeee']),
        fin: '#c7d2d6',
      }],
    },
    angel: {
      n: 3, len: 0.95, h: 0.55, w: 0.11, amp: 0.05, freq: 5, maxPitch: 0.12, minS: 0.12, maxS: 0.6, view: 2.5, sepR: 1.4, school: false, wander: 0.25,
      body: { taper: 0.75 }, fins: { tail: 0.3, tailH: 0.55, dorsal: 1.15, anal: 1.15, sweep: 0.32, filaments: true },
      paints: [
        { body: (x, y, z) => (eye(x, y, z) ? ['#9c1f1f'] : Math.sin((x + 0.2) * 9) > 0.78 ? ['#262626'] : ['#dfe2db', 0.05]), fin: '#cdd2c9' },
        { body: (x, y, z) => (eye(x, y, z) ? ['#9c1f1f'] : x > 0.35 && Math.abs(y) < 0.9 ? ['#f39a2b', 0.1] : Math.sin(x * 7 + 1) * Math.sin(y * 5 + 2) > 0.5 ? ['#1e1e1e'] : ['#f4f1ea']), fin: '#ece6dc' },
        { body: (x, y, z) => (eye(x, y, z) ? ['#9c1f1f'] : Math.sin(x * 11 + Math.sin(y * 6) * 2) > 0.3 ? ['#232323'] : ['#e8e8e2']), fin: '#bdbdb6' },
        { body: (x, y, z) => (eye(x, y, z) ? ['#9c1f1f'] : ['#1d1d1f', 0.04]), fin: '#2a2a2c' },
        { body: (x, y, z) => (eye(x, y, z) ? ['#9c1f1f'] : ['#f0c35a', 0.12]), fin: '#f4d98a' },
        { body: (x, y, z) => (eye(x, y, z) ? ['#9c1f1f'] : Math.sin((x + 0.2) * 14) > 0.45 ? ['#202020'] : ['#e2e4de', 0.05]), fin: '#cfd3cb' },
      ],
    },
    apisto: {
      n: 1, len: 0.58, h: 0.22, w: 0.11, amp: 0.035, freq: 10, minS: 0.04, maxS: 0.7, view: 1, sepR: 0.5, school: false, wander: 0.5,
      home: PX(560, 820, 0.8),
      body: { taper: 0.6 }, fins: { tail: 0.26, tailH: 0.7, dorsal: 0.6, anal: 0.45, sweep: 0.2 },
      paints: [{ body: (x, y, z) => (eye(x, y, z) ? ['#111'] : y > 0.45 ? ['#d8661a', 0.1] : ['#f39233', 0.12]), fin: '#ffcb47', finGlow: 0.1 }],
    },
    cory: {
      n: 6, len: 0.46, h: 0.17, w: 0.15, amp: 0.03, freq: 12,
      body: { taper: 0.5, flatBelly: true }, fins: { tail: 0.22, tailH: 0.75, dorsal: 0.75, anal: 0.2, sweep: 0.02 },
      // façon Corydoras sterbai : sombre à points blancs, ventre clair
      paints: [{ body: (x, y, z) => (eye(x, y, z) ? ['#111'] : y < -0.3 ? ['#d9cfb8'] : Math.sin(x * 29) * Math.sin(y * 23 + z * 13) > 0.45 ? ['#f1efe6'] : ['#3d3a36']), fin: '#e09a3c' }],
    },
  };

  // Population de « Mon bac » (sinon celle de la photo) ; une livrée de scalaire par poisson
  const pop = population || { neon: 32, angel: ['argenté', 'koi', 'marbré'], cory: 6, apisto: 1 };
  SPECIES.neon.n = pop.neon;
  SPECIES.cory.n = pop.cory;
  SPECIES.apisto.n = pop.apisto;
  SPECIES.angel.n = pop.angel.length;
  SPECIES.angel.variantOf = (i) => Math.max(0, ANGEL_LIVERIES.indexOf(pop.angel[i]));

  const B = { x: W / 2 - 0.7, zMin: -D / 2 + 0.5, zMax: D / 2 - 0.4, yTop: WATER - 0.35 };
  const floorAt = (x, z) => sandY(x, z) + 0.3;
  const groups = {};
  for (const [key, cfg] of Object.entries(SPECIES)) {
    const vis = Array.from({ length: cfg.n }, (_, i) => (cfg.variantOf ? cfg.variantOf(i) : i % cfg.paints.length));
    const seen = cfg.paints.map(() => 0);
    const variants = cfg.paints.map((paint, vi) => {
      const count = vis.filter((v) => v === vi).length;
      const geo = fishGeometry(cfg, paint);
      const mesh = new THREE.InstancedMesh(geo, fishMaterial(cfg.len), count);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const aPhase = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
      const aAmp = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aPhase', aPhase);
      geo.setAttribute('aAmp', aAmp);
      scene.add(mesh);
      return { mesh, aPhase, aAmp };
    });
    const list = Array.from({ length: cfg.n }, (_, i) => {
      // Territoire propre à chaque individu (plusieurs apistogrammas ne se partagent pas le même coin)
      const home = cfg.home ? cfg.home.clone().add(new THREE.Vector3(i * 2.4, 0, (i % 2) * -0.7)) : null;
      const x = home ? home.x : (rnd() - 0.5) * 2 * B.x, z = home ? home.z : B.zMin + rnd() * (B.zMax - B.zMin);
      const y = key === 'cory' ? sandY(x, z) + 0.1 : home ? home.y : floorAt(x, z) + rnd() * (B.yTop - floorAt(x, z));
      const dir = new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).normalize();
      return {
        p: new THREE.Vector3(x, y, z), v: dir.clone().multiplyScalar(cfg.minS || 0.1), dir, home,
        phase: rnd() * 6, scale: 0.85 + rnd() * 0.3, seed: rnd() * 100, heading: Math.atan2(dir.z, dir.x), timer: rnd() * 3, moving: false,
        vi: vis[i], idx: seen[vis[i]]++, livery: key === 'angel' ? pop.angel[i] : null,
      };
    });
    groups[key] = { cfg, variants, list };
  }

  // ------------------------------------------------------------ modèles réels : poissons, plantes, bois
  // Chaque maillage est « aplati » avec sa transformation (pose de repos pour les modèles animés),
  // converti en flottants (les fichiers optimisés sont quantifiés), recentré puis mis à l'échelle.
  const GET = ['getX', 'getY', 'getZ', 'getW'];
  const toFloat = (a) => {
    const n = a.itemSize, out = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = a[GET[k]](i);
    return new THREE.BufferAttribute(out, n);
  };
  function bakeParts(root, filter = () => true) {
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      let name = '';
      for (let n = o; n; n = n.parent) name += ' ' + n.name;
      if (!filter(name, o)) return;
      const src = o.geometry, g = new THREE.BufferGeometry(), count = src.attributes.position.count;
      const pos = toFloat(src.attributes.position);
      // Maillage animé : on calcule la pose de repos à travers le squelette (sinon le corps reste dans l'espace des os)
      const skinned = o.isSkinnedMesh;
      if (skinned) {
        o.skeleton.update();
        const v = new THREE.Vector3();
        for (let i = 0; i < count; i++) {
          v.fromBufferAttribute(pos, i);
          o.applyBoneTransform(i, v);
          pos.setXYZ(i, v.x, v.y, v.z);
        }
      }
      g.setAttribute('position', pos);
      if (src.attributes.normal && !skinned) g.setAttribute('normal', toFloat(src.attributes.normal));
      g.setAttribute('uv', src.attributes.uv ? toFloat(src.attributes.uv) : new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      g.setIndex(src.index ? Array.from(src.index.array) : [...Array(count).keys()]);
      g.applyMatrix4(o.matrixWorld);
      if (!g.attributes.normal) g.computeVertexNormals();
      parts.push({ geometry: g, material: Array.isArray(o.material) ? o.material[0] : o.material, name: name + ' ' + (o.material?.name || '') });
    });
    return parts;
  }
  const merged = (parts) => mergeGeometries(parts.map((p) => p.geometry), true);

  // Poisson : longueur sur l'axe x, tête vers +x (repérée par les yeux quand le modèle en a), longueur réelle de l'espèce
  function fishFromModel(gltf, len, flip) {
    const parts = bakeParts(gltf.scene);
    const geo = merged(parts), size = new THREE.Vector3(), c = new THREE.Vector3();
    geo.computeBoundingBox();
    geo.boundingBox.getSize(size);
    if (size.z > size.x) geo.rotateY(Math.PI / 2);
    geo.computeBoundingBox();
    geo.boundingBox.getCenter(c);
    geo.translate(-c.x, -c.y, -c.z);
    let head = 1;
    const eyes = parts.findIndex((p) => /eye|cornea/i.test(p.name));
    if (eyes >= 0) {
      const gr = geo.groups[eyes], idx = geo.index.array, pos = geo.attributes.position;
      let sx = 0;
      for (let i = gr.start; i < gr.start + gr.count; i++) sx += pos.getX(idx[i]);
      head = Math.sign(sx) || 1;
    }
    if (flip) head = -head;
    if (head < 0) geo.rotateY(Math.PI);
    geo.computeBoundingBox();
    geo.boundingBox.getSize(size);
    geo.scale(len / size.x, len / size.x, len / size.x);
    return { geo, materials: parts.map((p) => p.material) };
  }
  // Matériau d'origine conservé (brillance, reflets spéculaires, transparence des nageoires) + ondulation de nage
  function modelFishMaterial(src, len) {
    const m = src.clone();
    m.side = THREE.DoubleSide;
    m.envMap = envTex;
    if (m.transparent) {
      // Nageoires translucides : on écarte seulement les pixels quasi invisibles
      m.alphaTest = 0.04;
      m.depthWrite = true;
    }
    envMats.push({ m, k: 0.8 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nattribute float aAmp;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float kb = clamp(0.25 - position.x / ${(len / 2).toFixed(3)} * 0.8, 0.0, 1.5);
          transformed.z += sin(aPhase + position.x * ${(7 / len).toFixed(2)}) * aAmp * kb * kb;`);
    };
    return m;
  }
  // Remplace les formes générées d'une espèce par le modèle (mêmes poissons, mêmes comportements)
  function replaceFish(key, gltf, flip = false) {
    const g = groups[key], n = g.list.length;
    const { geo, materials } = fishFromModel(gltf, g.cfg.len, flip);
    const mats = materials.map((m) => modelFishMaterial(m, g.cfg.len));
    const mesh = new THREE.InstancedMesh(geo, mats.length > 1 ? mats : mats[0], n);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    const aPhase = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    const aAmp = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPhase', aPhase);
    geo.setAttribute('aAmp', aAmp);
    for (const v of g.variants) {
      scene.remove(v.mesh);
      v.mesh.dispose();
    }
    scene.add(mesh);
    g.variants = [{ mesh, aPhase, aAmp }];
    g.list.forEach((f, i) => { f.vi = 0; f.idx = i; });
  }

  // Plante : base au sol, hauteur donnée ; elle ondule comme les plantes générées
  function plantPrefab(parts, height) {
    const geo = merged(parts), b = new THREE.Box3(), c = new THREE.Vector3();
    geo.computeBoundingBox();
    b.copy(geo.boundingBox).getCenter(c);
    geo.translate(-c.x, -b.min.y, -c.z);
    const k = height / (b.max.y - b.min.y);
    geo.scale(k, k, k);
    return { geo, materials: parts.map((p) => p.material), h: height };
  }
  function placePrefab(prefab, spots, ampTip, glow) {
    const mats = prefab.materials.map((src) => {
      const m = swayMaterial(ampTip / (prefab.h * prefab.h), src.map || null, glow);
      if (src.color) m.color.copy(src.color);
      return m;
    });
    const mesh = new THREE.InstancedMesh(prefab.geo, mats.length > 1 ? mats : mats[0], spots.length);
    const ph = new Float32Array(spots.length);
    spots.forEach((s, i) => {
      P3.set(s.x, s.y ?? sandY(s.x, s.z) - 0.03, s.z);
      E.set(0, s.ry ?? rnd() * Math.PI * 2, 0);
      mesh.setMatrixAt(i, M4.compose(P3, Q.setFromEuler(E), S3.setScalar(s.s ?? 0.85 + rnd() * 0.3)));
      ph[i] = rnd() * 6.28;
    });
    prefab.geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }
  const spot = (v, dy = 0, s) => ({ x: v.x, y: v.y + dy, z: v.z, s });

  const has = (n) => models.includes(n);
  const warn = (n) => (e) => console.warn(`Modèle ${n} indisponible`, e);
  if (has('neon')) loadModel('neon').then((g) => replaceFish('neon', g)).catch(warn('neon'));
  if (has('scalaire')) loadModel('scalaire').then((g) => replaceFish('angel', g)).catch(warn('scalaire'));
  if (has('corydoras')) loadModel('corydoras').then((g) => replaceFish('cory', g)).catch(warn('corydoras'));
  // Anubias : 3 plantes de tailles différentes, fixées sur le bois aux emplacements de la photo
  if (has('anubias')) loadModel('anubias').then((g) => {
    const parts = bakeParts(g.scene);
    parts.forEach((part, k) => {
      const spots = ANUBIAS_SPOTS.filter((_, i) => i % parts.length === k).map((v) => spot(v, -0.08));
      if (spots.length) placePrefab(plantPrefab([part], 0.5 + k * 0.08), spots, 0.03);
    });
    procAnubias.visible = false;
  }).catch(warn('anubias'));
  // Pack de plantes : fougère de Java sur le bois, staurogyne devant, quelques touffes de vallisnérias réelles
  if (has('plantes')) loadModel('plantes').then((g) => {
    const pick = (re) => bakeParts(g.scene, (name) => re.test(name));
    const java = pick(/java/i), stauro = pick(/staurogyne/i), vallis = pick(/vallisneria/i);
    if (java.length) {
      placePrefab(plantPrefab(java, 1.3), JAVA_SPOTS.map((v) => spot(v, -0.15)), 0.08, ['#3f7a22', 0.2]);
      procJava.visible = false;
    }
    if (stauro.length) {
      placePrefab(plantPrefab(stauro, 0.35), [-4.8, -2.6, 0.4, 2.2, 4.6].map((x) => ({ x, z: D / 2 - 0.8 - rnd() * 0.4 })), 0.02);
    }
    if (vallis.length) {
      const xs = Array.from({ length: 9 }, (_, i) => -5.8 + i * 1.45 + rnd() * 0.5);
      placePrefab(plantPrefab(vallis, 4.2), xs.map((x) => ({ x, z: -D / 2 + 0.45 + rnd() * 0.5 })), 0.3, VALLIS_GLOW);
    }
  }).catch(warn('plantes'));
  // Bois scanné : posé au premier plan, au pied de la grande diagonale
  if (has('bois')) loadModel('bois').then((g) => {
    const geo = merged(bakeParts(g.scene)), size = new THREE.Vector3(), c = new THREE.Vector3();
    geo.computeBoundingBox();
    geo.boundingBox.getSize(size);
    geo.boundingBox.getCenter(c);
    geo.translate(-c.x, -geo.boundingBox.min.y, -c.z);
    const k = 3.4 / Math.max(size.x, size.z);
    geo.scale(k, k, k);
    const src = bakeParts(g.scene)[0].material;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: src.map, normalMap: src.normalMap || null, roughness: 0.85, color: '#d9b49c' }));
    m.position.set(-0.6, sandY(-0.6, 0.9) - 0.08, 0.9);
    m.rotation.y = 0.5;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }).catch(warn('bois'));

  // ------------------------------------------------------------ comportement
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), acc = new THREE.Vector3();
  function steerBounds(f, k) {
    const m = 0.8, fl = floorAt(f.p.x, f.p.z);
    if (f.p.x > B.x - m) acc.x -= k * (f.p.x - (B.x - m));
    if (f.p.x < -B.x + m) acc.x += k * (-B.x + m - f.p.x);
    if (f.p.z > B.zMax - m) acc.z -= k * (f.p.z - (B.zMax - m));
    if (f.p.z < B.zMin + m) acc.z += k * (B.zMin + m - f.p.z);
    if (f.p.y < fl + 0.3) acc.y += k * (fl + 0.3 - f.p.y);
    if (f.p.y > B.yTop - 0.3) acc.y -= k * (f.p.y - (B.yTop - 0.3));
  }
  function clampBounds(f) {
    f.p.x = clamp(f.p.x, -B.x, B.x);
    f.p.z = clamp(f.p.z, B.zMin, B.zMax);
    f.p.y = clamp(f.p.y, floorAt(f.p.x, f.p.z), B.yTop);
  }

  // Banc (boids) : séparation, alignement, cohésion, errance, profondeur préférée, territoire éventuel
  function swim(g, dt, act, targetY, scare) {
    const { cfg, list } = g;
    for (const f of list) {
      acc.set(0, 0, 0);
      vA.set(0, 0, 0);
      vB.set(0, 0, 0);
      vC.set(0, 0, 0);
      let n = 0;
      for (const o of list) {
        if (o === f) continue;
        const d = f.p.distanceTo(o.p);
        if (d < cfg.view) { n++; vA.add(o.v); vB.add(o.p); }
        if (d < cfg.sepR * (1 + scare * 1.5)) vC.addScaledVector(vD.subVectors(f.p, o.p), 1 / (d * d + 0.02));
      }
      if (n && cfg.school) {
        acc.addScaledVector(vA.divideScalar(n).sub(f.v), 1.2);
        acc.addScaledVector(vB.divideScalar(n).sub(f.p), 0.9 * (1 - scare * 0.5));
      }
      acc.addScaledVector(vC, cfg.school ? 0.25 : 0.8);
      const tt = time * cfg.wander, s = f.seed;
      acc.x += Math.sin(tt * 0.9 + s) * 0.6;
      acc.z += Math.cos(tt * 0.7 + s * 1.7) * 0.6;
      acc.y += Math.sin(tt * 0.5 + s * 2.3) * 0.25 + (targetY + Math.sin(s) * 0.5 - f.p.y) * 0.8;
      // Territoire : reste près de son coin, avec de petites patrouilles
      if (f.home) acc.addScaledVector(vD.subVectors(f.home, f.p), 1.2);
      steerBounds(f, 6);
      if (scare > 0.05) acc.addScaledVector(vD.set(rnd() - 0.5, (rnd() - 0.5) * 0.4, rnd() - 0.5), 30 * scare);
      f.v.addScaledVector(acc, dt);
      f.v.y *= 0.96;
      const speed = f.v.length(), min = cfg.minS * act, max = cfg.maxS * (act + scare * 1.5);
      if (speed > max) f.v.multiplyScalar(max / speed);
      else if (speed < min) f.v.multiplyScalar(min / Math.max(speed, 1e-4));
      f.p.addScaledVector(f.v, dt);
      clampBounds(f);
      f.dir.lerp(vD.copy(f.v).normalize(), Math.min(1, dt * 5));
      f.phase += dt * cfg.freq * (0.35 + f.v.length() / cfg.maxS);
    }
  }

  // Corydoras : alternent fouille et repos sur le sol, plus actifs à la tombée de la nuit
  function crawl(g, dt, act) {
    const zMin = -0.4;
    for (const f of g.list) {
      f.timer -= dt;
      if (f.timer <= 0) {
        f.moving = rnd() < 0.3 + 0.65 * act;
        f.timer = f.moving ? 1.5 + rnd() * 3 : 1 + rnd() * 3 * (1.3 - act);
        f.heading += (rnd() - 0.5) * 2.4;
      }
      if (f.p.x > B.x - 0.4 || f.p.x < -B.x + 0.4 || f.p.z > B.zMax - 0.2 || f.p.z < zMin) {
        f.heading = Math.atan2(-f.p.z * 0.5 + 0.6, -f.p.x) + (rnd() - 0.5) * 0.6;
      }
      const target = f.moving ? 0.35 * (0.5 + act) : 0;
      vD.set(Math.cos(f.heading) * target, 0, Math.sin(f.heading) * target);
      f.v.lerp(vD, Math.min(1, dt * 3));
      f.p.addScaledVector(f.v, dt);
      f.p.x = clamp(f.p.x, -B.x, B.x);
      f.p.z = clamp(f.p.z, zMin, B.zMax);
      f.p.y = sandY(f.p.x, f.p.z) + 0.11 + (f.moving ? 0.02 : 0);
      f.dir.set(Math.cos(f.heading), f.moving ? -0.18 : -0.05, Math.sin(f.heading));
      f.phase += dt * g.cfg.freq * (0.2 + f.v.length() * 2);
    }
  }

  const rotM = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), fwd = new THREE.Vector3(), side = new THREE.Vector3(), upv = new THREE.Vector3(), sc = new THREE.Vector3();
  function writeFish(g) {
    for (const f of g.list) {
      const v = g.variants[f.vi];
      fwd.copy(f.dir);
      const pitch = g.cfg.maxPitch ?? 0.45;
      fwd.y = clamp(fwd.y, -pitch, pitch);
      fwd.normalize();
      side.crossVectors(fwd, UP);
      if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
      side.normalize();
      upv.crossVectors(side, fwd);
      rotM.makeBasis(fwd, upv, side);
      q.setFromRotationMatrix(rotM);
      v.mesh.setMatrixAt(f.idx, M4.compose(f.p, q, sc.setScalar(f.scale)));
      v.aPhase.array[f.idx] = f.phase;
      v.aAmp.array[f.idx] = g.cfg.amp * (0.6 + Math.min(1.5, f.v.length() / (g.cfg.maxS || 0.4)));
    }
    for (const v of g.variants) {
      v.mesh.instanceMatrix.needsUpdate = true;
      v.aPhase.needsUpdate = true;
      v.aAmp.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ post-traitement « photo »
  // Bloom (lueurs), profondeur de champ (arrière-plan flou), étalonnage (saturation, vignettage, grain)
  let hq = quality === 'high';
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.5, 1.2);
  const bokeh = new BokehPass(scene, camera, { focus: 17, aperture: 0.00012, maxblur: 0.004 });
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
      float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        c.rgb = max(mix(vec3(l), c.rgb, 1.15), 0.0);
        vec2 d = vUv - 0.5;
        c.rgb *= mix(0.5, 1.0, smoothstep(0.85, 0.3, length(d * vec2(1.15, 1.0))));
        c.rgb += (rand(vUv * 1000.0 + uTime) - 0.5) * 0.012;
        gl_FragColor = c;
      }`,
  });
  composer.addPass(bloom);
  composer.addPass(bokeh);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  function applyQuality() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hq ? 2 : 1));
    bloom.enabled = bokeh.enabled = grade.enabled = hq;
    sun.shadow.mapSize.set(hq ? 2048 : 1024, hq ? 1024 : 512);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    resize();
  }

  // ------------------------------------------------------------ état de la lumière
  const target = { vals: channels.map(() => 0), clouds: 0, cloudSpeed: 0, dose: 0 };
  let lvl = 0, lvlSlow = 0, scare = 0, coryAct = 0.5, pearl = 0, time = 0;
  const lightCol = new THREE.Color(1, 1, 1), fogCol = new THREE.Color(), waterCol = new THREE.Color('#0d3a36');

  function mixColor(vals) {
    let r = 0, g = 0, b = 0;
    vals.forEach((v, i) => {
      const w = v / 100;
      r += channels[i].rgb[0] * w;
      g += channels[i].rgb[1] * w;
      b += channels[i].rgb[2] * w;
    });
    const mx = Math.max(r, g, b);
    return mx ? lightCol.setRGB(r / mx, g / mx, b / mx, THREE.SRGBColorSpace) : lightCol.setRGB(0.3, 0.4, 0.6, THREE.SRGBColorSpace);
  }

  // ------------------------------------------------------------ boucle
  let running = true, last = performance.now(), camAnim = null, raf = 0, follow = null;
  const VIEWS = {
    face: { pos: [0, 2.75, 17], tgt: [0, 2.65, 0] },
    plongee: { pos: [0, 13, 11], tgt: [0, 1.5, 0] },
    cote: { pos: [15, 3.2, 8], tgt: [0, 2.4, 0] },
    pres: { pos: [-2.4, 2.3, 7.6], tgt: [-3.4, 2.1, 0] },
  };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!running || document.hidden) return;
    time += dt;
    U.uTime.value = time;

    // Lumière : niveau lissé ; un changement brusque effraie les poissons
    const raw = Math.max(0, ...target.vals) / 100;
    lvl += (raw - lvl) * Math.min(1, dt * 8);
    lvlSlow += (raw - lvlSlow) * Math.min(1, dt * 0.7);
    if (Math.abs(raw - lvlSlow) > 0.3) scare = 1;
    scare = Math.max(0, scare - dt * 0.45);

    const cloudDepth = (target.clouds / 3) * 0.55, cs = 0.4 + target.cloudSpeed * 0.6;
    const cloudN = 0.5 + 0.5 * Math.sin(time * 0.37 * cs + Math.sin(time * 0.11 * cs) * 2);
    const L = lvl * (1 - cloudDepth * smooth(0.55, 0.9, cloudN));
    U.uCloud.value = (target.clouds / 3) * 0.6;
    U.uCloudOff.value.x += dt * (0.25 + target.cloudSpeed * 0.35);
    U.uCloudOff.value.y += dt * (0.1 + target.cloudSpeed * 0.12);

    const col = mixColor(target.vals);
    sun.color.copy(col);
    sun.intensity = 3.4 * L;
    hemi.color.copy(col);
    hemi.intensity = 0.55 * L + 0.02;
    U.uCaustic.value.copy(col).multiplyScalar(0.8 * L);
    U.uGlow.value = 0.25 + 0.75 * L;
    glowMats.forEach((g) => (g.m.emissiveIntensity = g.k * L));
    envMats.forEach((e) => (e.m.envMapIntensity = e.k * (0.08 + 0.92 * L)));
    // Adaptation de l'œil : on y voit un peu la nuit, sous la veilleuse
    renderer.toneMappingExposure = 1.08 + 2.4 * Math.pow(1 - smooth(0, 0.35, lvl), 2);
    fogCol.copy(waterCol).lerp(col, 0.25).multiplyScalar(0.12 + 0.88 * Math.sqrt(L));
    scene.fog.color.copy(fogCol);
    strips.forEach((m, i) => m.material.color.set(channels[i].color).multiplyScalar(0.06 + 2.5 * ((target.vals[i] || 0) / 100)));
    rays.forEach((r) => {
      r.m.material.color.copy(col);
      r.m.material.opacity = 0.12 * L * (0.6 + 0.4 * Math.sin(time * 0.6 + r.ph));
      r.m.material.map.offset.x = time * r.sp;
      r.m.position.x = r.x + Math.sin(time * 0.15 + r.ph) * 0.3;
    });
    snowMat.color.copy(col).multiplyScalar(0.15 + 0.85 * L);

    // Surface de l'eau
    const sp2 = surfGeo.attributes.position;
    for (let i = 0; i < sp2.count; i++) {
      const x = surfBase[i * 3], z = surfBase[i * 3 + 2];
      sp2.setY(i, 0.03 * Math.sin(x * 1.3 + time * 1.1) + 0.02 * Math.cos(z * 2.1 + time * 1.7) + 0.012 * Math.sin((x + z) * 3 + time * 2.3));
    }
    sp2.needsUpdate = true;
    surfGeo.computeVertexNormals();

    // Particules en suspension
    const sn = snowGeo.attributes.position;
    snowData.forEach((s, i) => {
      s.y -= s.v * dt * 0.3;
      if (s.y < 0.4) s.y = WATER - 0.2;
      sn.setXYZ(i, s.x + Math.sin(time * 0.3 + s.ph) * 0.15, s.y + Math.sin(time * 0.5 + s.ph * 2) * 0.05, s.z + Math.cos(time * 0.25 + s.ph) * 0.12);
    });
    sn.needsUpdate = true;

    // Perlage : apparaît après plusieurs heures de lumière forte
    pearl = smooth(0.45, 0.8, target.dose) * smooth(0.15, 0.4, lvl);
    const pp = pearls.geometry.attributes.position;
    pearlData.forEach((b, i) => {
      b.t += dt;
      if (b.t > b.life) { b.t = 0; b.tip = tips[Math.floor(rnd() * tips.length)]; }
      pp.setXYZ(i, b.tip.x + Math.sin(b.t * 4 + i) * 0.02, Math.min(WATER - 0.05, b.tip.y + b.t * 0.35), b.tip.z);
    });
    pp.needsUpdate = true;
    pearls.geometry.setDrawRange(0, Math.floor(pearlData.length * pearl));

    // Poissons
    const day = smooth(0.03, 0.4, lvl);
    swim(groups.neon, dt, 0.3 + 0.7 * day, 1.4 + 1.6 * day, scare);
    swim(groups.angel, dt, 0.3 + 0.6 * day, 2.6 + 1.2 * day, scare * 0.5);
    swim(groups.apisto, dt, 0.25 + 0.75 * day, SPECIES.apisto.home.y, scare * 0.3);
    coryAct = 0.35 + 0.65 * (1 - smooth(0.05, 0.6, lvl));
    crawl(groups.cory, dt, coryAct);
    Object.values(groups).forEach(writeFish);

    // Caméra : suivi d'un poisson (vue de côté, à distance fixe) ou transition vers une vue
    if (follow && !camAnim) {
      const f = follow.list[follow.i % follow.list.length];
      if (f) {
        // Toujours devant la vitre avant, comme un observateur : jamais au milieu des plantes
        controls.target.lerp(f.p, Math.min(1, dt * 3));
        vA.set(f.p.x * 0.9, f.p.y + 0.15, Math.max(D / 2 + 0.25, f.p.z + 1.7 * follow.k));
        camera.position.lerp(vA, Math.min(1, dt * 1.5));
      }
    }
    if (camAnim) {
      camAnim.t = Math.min(1, camAnim.t + dt / 1.2);
      const e = camAnim.t * camAnim.t * (3 - 2 * camAnim.t);
      camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
      controls.target.lerpVectors(camAnim.t0, camAnim.t1, e);
      if (camAnim.t >= 1) camAnim = null;
    }
    controls.update();
    // Mise au point sur le centre du bac (ce que l'on regarde)
    bokeh.uniforms.focus.value = camera.position.distanceTo(controls.target);
    grade.uniforms.uTime.value = time;
    if (hq) composer.render(dt);
    else renderer.render(scene, camera);
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1 ? Math.min(70, 30 / Math.pow(camera.aspect, 0.8)) : 30;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  applyQuality();
  raf = requestAnimationFrame(frame);

  return {
    /** vals : 0-100 par canal ; clouds/cloudSpeed : 0-3 ; dose : lumière moyenne des 2 dernières heures (0-1) */
    setLight(vals, { clouds = 0, cloudSpeed = 0, dose = 0 } = {}) {
      target.vals = vals.slice(0, channels.length);
      target.clouds = clouds;
      target.cloudSpeed = cloudSpeed;
      target.dose = dose;
    },
    view(name) {
      if (name === 'suivre') {
        // Le scalaire en priorité (le plus grand), sinon le premier banc disponible
        const g = [groups.angel, groups.neon, groups.apisto, groups.cory].find((x) => x.list.length);
        if (g) follow = { list: g.list, i: follow && follow.list === g.list ? follow.i + 1 : 0, k: g === groups.angel ? 1 : 0.5 };
        return;
      }
      follow = null;
      const v = VIEWS[name];
      if (!v) return;
      camAnim = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: new THREE.Vector3(...v.pos), t1: new THREE.Vector3(...v.tgt) };
    },
    setAutoRotate(on) { controls.autoRotate = on; },
    // Diagnostic : taille des modèles de poissons et position du premier individu
    debug() {
      return Object.fromEntries(Object.entries(groups).map(([k, g]) => {
        const geo = g.variants[0].mesh.geometry;
        geo.computeBoundingBox();
        const s = geo.boundingBox.getSize(new THREE.Vector3());
        return [k, { size: s.toArray().map((x) => +x.toFixed(2)), first: g.list[0].p.toArray().map((x) => +x.toFixed(2)), n: g.list.length }];
      }));
    },
    setQuality(q) { hq = q === 'high'; applyQuality(); },
    pause(p) { running = !p; last = performance.now(); },
    status() {
      const night = lvl < 0.06;
      return {
        neons: !groups.neon.list.length ? null : scare > 0.3 ? 'effrayés par le changement brusque de lumière !' : night ? 'au repos, immobiles près des plantes' : lvl < 0.35 ? 'banc calme, nage lente' : 'banc actif en pleine eau',
        angels: !groups.angel.list.length ? null : night ? 'en veille, presque immobiles' : lvl < 0.35 ? 'nagent doucement' : 'patrouillent le haut du bac',
        apisto: !groups.apisto.list.length ? null : night ? 'au repos dans son abri sous le bois' : 'défend son territoire au pied des racines',
        corys: !groups.cory.list.length ? null : coryAct > 0.75 ? 'fouillent activement le sol' : coryAct > 0.5 ? 'cherchent de la nourriture' : 'se reposent près du bois',
        plants: pearl > 0.3 ? 'photosynthèse intense : elles perlent (bulles d\'oxygène)' : lvl > 0.3 ? 'photosynthèse en cours' : lvl > 0.06 ? 'photosynthèse faible' : 'au repos (respiration nocturne)',
      };
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      composer.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
