// Builds the Rayfin static site in dist/ from the dashboard at the repository root (index.html and assets/).
// Every asset URL gets a content-hash query string, including the data scripts the page loads on demand, so browsers
// never mix cached and freshly deployed files.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(app, '..');
const out = join(app, 'dist');

// The fonts ship inside assets/fonts.css (build_fonts.py); the source .woff2 files stay in the repository only
const skip = (p) => /(^|\/)\.DS_Store$/.test(p) || /\/assets\/fonts\/[^/]+\.woff2$/.test(p);

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(site, 'index.html'), join(out, 'index.html'));
cpSync(join(site, 'assets'), join(out, 'assets'), { recursive: true, filter: (p) => !skip(p) });

const required = ['index.html', 'assets/data.js', 'assets/fonts.css', 'assets/vendor/d3.min.js', 'assets/vendor/maplibre/maplibre-gl.js', 'assets/maternity.js', 'assets/maternity-access.js'];
required.forEach((f) => { if (!existsSync(join(out, f))) throw new Error(`Build output is missing ${f}. Build the data first: python3 build_all.py (see AGENTS.md)`); });

const hashOf = (path) => createHash('sha256').update(readFileSync(join(out, path))).digest('hex').slice(0, 10);
let versioned = 0;

// 1. Scripts loaded at run time ('assets/places.js', 'assets/maternity.js', ...): version the paths inside the JS first,
//    so the JS files' own hashes (used in index.html below) cover the change
const jsDir = join(out, 'assets', 'js');
readdirSync(jsDir).filter((n) => n.endsWith('.js')).forEach((n) => {
  const file = join(jsDir, n);
  const src = readFileSync(file, 'utf8');
  const next = src.replace(/'(assets\/[^'?#]+\.(?:js|css))'/g, (m, path) => {
    if (!existsSync(join(out, path))) throw new Error(`${n} references missing file ${path}`);
    versioned += 1;
    return `'${path}?v=${hashOf(path)}'`;
  });
  if (next !== src) writeFileSync(file, next);
});

// 2. Everything index.html links to
const indexPath = join(out, 'index.html');
const html = readFileSync(indexPath, 'utf8').replace(/\b(src|href)="(assets\/[^"?#]+)"/g, (m, attr, path) => {
  if (!existsSync(join(out, path))) throw new Error(`index.html references missing file ${path}`);
  versioned += 1;
  return `${attr}="${path}?v=${hashOf(path)}"`;
});
writeFileSync(indexPath, html);

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(out);
const bytes = files.reduce((s, f) => s + statSync(f).size, 0);
console.log(`Built ${files.length} files (${(bytes / 1024).toFixed(0)} KB), ${versioned} asset URLs versioned → ${relative(app, out)}/`);
