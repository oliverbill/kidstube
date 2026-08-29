// Monta docs/ (variante estática para GitHub Pages) a partir de public/ + static/static-api.js.
// O Pages serve sob /<repo>/, por isso todos os caminhos absolutos passam a relativos,
// e o shim é injetado antes de app.js/admin.js para implementar /api/* no browser.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const docs = join(root, 'docs');

rmSync(docs, { recursive: true, force: true });
mkdirSync(docs);
cpSync(join(root, 'public'), docs, { recursive: true });
cpSync(join(root, 'static/static-api.js'), join(docs, 'static-api.js'));
writeFileSync(join(docs, '.nojekyll'), '');

function rewrite(file, fns) {
  const p = join(docs, file);
  let s = readFileSync(p, 'utf8');
  for (const fn of fns) s = fn(s);
  writeFileSync(p, s);
}

// href/src absolutos → relativos (menos os fetch a /api/, que o shim interceta).
const relAttrs = (s) => s
  .replaceAll('href="/"', 'href="./"')
  .replace(/(href|src)="\/([^"]+)"/g, '$1="./$2"');

const injectShim = (name) => (s) =>
  s.replace(new RegExp(`<script src="\\.?/?${name}"`), `<script src="./static-api.js"></script>\n  <script src="./${name}"`);

rewrite('index.html', [relAttrs, injectShim('app.js')]);
rewrite('admin.html', [relAttrs, injectShim('admin.js')]);

for (const f of ['app.js', 'admin.js'])
  rewrite(f, [(s) => s.replace(/register\('\/sw\.js'\)/g, "register('./sw.js')")]);

// Cada deploy ganha um cache novo no service worker, senão os clientes ficam
// presos ao shim antigo (e à chave antiga) até alguém bumpar a versão à mão.
const buildId = process.env.KIDTUBE_BUILD_ID || 'dev';
rewrite('sw.js', [(s) => s
  .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = 'kidtube-${buildId.slice(0, 12)}';`)
  .replace(/'\/(admin|app|index|icons|manifest|sw)/g, "'./$1")
  .replace(/'\/'/g, "'./'")
  .replace("'./app.js',", "'./app.js',\n  './static-api.js',")
  .replace(/url\.pathname\.startsWith\('\/api\/'\)/g, "url.pathname.includes('/api/')")
  .replace(/url\.pathname\.startsWith\('\/mock-thumb\/'\)/g, "url.pathname.includes('/mock-thumb/')"),
]);

rewrite('manifest.webmanifest', [(s) => {
  const m = JSON.parse(s);
  m.start_url = './';
  m.scope = './';
  for (const i of m.icons) i.src = i.src.replace(/^\//, './');
  return JSON.stringify(m, null, 2);
}]);

console.log('docs/ montado.');
