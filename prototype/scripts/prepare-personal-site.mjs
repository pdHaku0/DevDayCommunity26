import { copyFile, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const argument = process.argv[2];
if (!argument || process.argv.length !== 3 || !isAbsolute(argument)) {
  throw new Error('Usage: node prepare-personal-site.mjs /absolute/nonexistent/template-directory');
}
const destination = resolve(argument);
const insideSource = relative(source, destination);
if (!insideSource || (!insideSource.startsWith('..' + '/') && insideSource !== '..' && !isAbsolute(insideSource))) {
  throw new Error('Template destination must be outside prototype/');
}

// Explicit source areas exclude hosting identities, Git metadata, credentials,
// dependency trees and runtime state. New implementation files within these
// areas must be ordinary source files; symlinks are never followed.
const roots = [
  '.gitignore', 'README.md', 'package.json', 'package-lock.json',
  'cloudflare-env.d.ts', 'drizzle.config.ts', 'eslint.config.mjs',
  'next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'vite.config.ts',
  'app', 'build', 'db', 'drizzle', 'lib', 'server', 'tests', 'client/probe.mjs',
  'skills/dot-link/SKILL.md', 'skills/dot-link/package.json',
  'skills/dot-link/package-lock.json', 'skills/dot-link/scripts',
  'scripts/build-verified.sh', 'scripts/connector-preview',
  'scripts/execution-profile.mjs', 'scripts/install-ci.mjs',
  'scripts/install-ci.sh', 'scripts/install-pnpm.sh', 'scripts/npm-install.mjs',
  'scripts/pnpm-install.mjs', 'scripts/run-framework.mjs', 'scripts/sites-env.mjs',
  'scripts/sites-env.sh', 'scripts/prepare-personal-site.mjs',
];
const files = [];
const permitted = /\.(?:[cm]?js|[cm]?ts|tsx|css|sql|json|md|sh|LICENSE)$/;
async function collect(path) {
  const info = await lstat(join(source, path));
  if (info.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${path}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(join(source, path))) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
      await collect(join(path, entry));
    }
  } else if (info.isFile() && (roots.includes(path) || permitted.test(path))) {
    files.push(path);
  } else if (!info.isFile()) {
    throw new Error(`Unsupported source entry: ${path}`);
  }
}
for (const root of roots) await collect(root);

// mkdir without recursive intentionally refuses every existing destination,
// including an empty one. The parent directory must already exist.
await mkdir(destination);
try {
  for (const path of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, path), target);
  }
  await writeFile(join(destination, '.npmrc'), 'audit=false\nfund=false\nupdate-notifier=false\n');
  await mkdir(join(destination, '.openai'));
  await writeFile(join(destination, '.openai/hosting.json'), JSON.stringify({
    d1: 'DB', r2: null, capabilities: ['mcp'],
  }, null, 2) + '\n');
  await writeFile(join(destination, 'plugin.json'), JSON.stringify({
    '$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'dot-link', version: '0.2.0',
    description: 'Encrypted peer communication for personal AI agents',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ template: destination, files: files.length + 3,
    next: 'In another empty directory run Sites project-setup.mjs --template-source with this path, create your own Site, then persist its ID with set-project-id.mjs.' }));
} catch (error) {
  await rm(destination, { recursive: true, force: true });
  throw error;
}
