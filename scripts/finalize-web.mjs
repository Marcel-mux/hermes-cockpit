#!/usr/bin/env node
// Writes dist/index.html from web/index.template.html, pointing it at the newest
// exported JS bundle. The Expo export emits a bare index.html, so the PWA shell
// (fonts, manifest, service worker, icons, zoom) has to be re-applied after every build.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const bundleDir = path.join(dist, '_expo/static/js/web');
const bundles = fs.readdirSync(bundleDir).filter(f => f.endsWith('.js'));
if (!bundles.length) {
  console.error('no bundle found in', bundleDir);
  process.exit(1);
}
const newest = bundles
  .map(name => ({ name, at: fs.statSync(path.join(bundleDir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0].name;

const template = fs.readFileSync(path.join(root, 'web/index.template.html'), 'utf8');
fs.writeFileSync(path.join(dist, 'index.html'), template.replaceAll('{{BUNDLE}}', newest));
console.log('dist/index.html ->', newest);

// Copy PWA files, icons, and shell extras
const staticFiles = [
  'manifest.json',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'favicon.ico',
  'apple-touch-icon.png',
];

for (const file of staticFiles) {
  const fromWeb = path.join(root, 'web', file);
  const fromRoot = path.join(root, file);
  const srcFile = fs.existsSync(fromWeb) ? fromWeb : (fs.existsSync(fromRoot) ? fromRoot : null);
  if (srcFile) {
    fs.copyFileSync(srcFile, path.join(dist, file));
    console.log(`copied: ${file}`);
  }
}

const hermesHome = process.env.HERMES_HOME || path.join(process.env.HOME || '/root', '.hermes');
const fontDirs = [
  path.join(root, 'web/fonts'),
  path.join(dist, 'fonts'),
  path.join(hermesHome, 'hermes-agent/web/public/fonts'),
];
const fontDir = fontDirs.find(dir => fs.existsSync(dir));
if (fontDir) {
  const target = path.join(dist, 'fonts');
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(fontDir).filter(f => f.endsWith('.woff2'))) {
    fs.copyFileSync(path.join(fontDir, file), path.join(target, file));
  }
  console.log('fonts <-', fontDir);
} else {
  console.warn('no font directory found; /fonts/*.woff2 will 404');
}

// Copy sounds directory
const soundDir = path.join(root, 'web/sounds');
if (fs.existsSync(soundDir)) {
  const targetSounds = path.join(dist, 'sounds');
  fs.mkdirSync(targetSounds, { recursive: true });
  for (const f of fs.readdirSync(soundDir)) {
    fs.copyFileSync(path.join(soundDir, f), path.join(targetSounds, f));
  }
  console.log('sounds <-', soundDir);
}
