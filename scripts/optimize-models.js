// Allège les modèles 3D déposés dans public/models/ pour la simulation (npm run models).
// Entrées acceptées : <nom>.glb, <nom>.gltf, ou un dossier <nom>/ contenant scene.gltf (export Sketchfab dézippé).
// Sortie : public/models/opt/<nom>.glb (géométrie compressée meshopt, textures WebP ≤ 1024 px).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'public', 'models');
const OUT = path.join(SRC, 'opt');
// Légère simplification des scans de bois seulement : au-delà, les facettes se voient en gros plan
const RATIO = { bois: 0.8 };
const TEXTURE_SIZE = '2048';

fs.mkdirSync(OUT, { recursive: true });
const inputs = [];
for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (entry.name === 'opt') continue;
  const full = path.join(SRC, entry.name);
  if (entry.isFile() && /\.(glb|gltf)$/i.test(entry.name)) inputs.push([entry.name.replace(/\.(glb|gltf)$/i, ''), full]);
  else if (entry.isDirectory()) {
    const scene = ['scene.gltf', 'scene.glb'].map((f) => path.join(full, f)).find((f) => fs.existsSync(f));
    if (scene) inputs.push([entry.name, scene]);
  }
}
if (!inputs.length) {
  console.log('Aucun modèle dans public/models/ (attendu : neon, scalaire, corydoras, anubias, bois).');
  process.exit(0);
}

const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'gltf-transform');
for (const [name, file] of inputs) {
  const out = path.join(OUT, `${name.toLowerCase()}.glb`);
  const args = ['optimize', file, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', TEXTURE_SIZE];
  if (RATIO[name]) args.push('--simplify-ratio', String(RATIO[name]), '--simplify-error', '0.002');
  else args.push('--simplify', 'false');
  process.stdout.write(`${name} … `);
  // Les vieux matériaux « specular/glossiness » ne sont plus lus par Three.js : conversion préalable
  const tmp = path.join(OUT, `.${name}.tmp.glb`);
  execFileSync(bin, ['metalrough', file, tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
  args[1] = tmp;
  execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(tmp);
  const before = file.endsWith('.glb') ? fs.statSync(file).size : dirSize(path.dirname(file));
  console.log(`${(before / 1e6).toFixed(1)} Mo → ${(fs.statSync(out).size / 1e6).toFixed(1)} Mo`);
}

function dirSize(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
}
