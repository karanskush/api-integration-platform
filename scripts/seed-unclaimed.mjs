import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';

// No ts-node/tsx devDependency here, and this codebase's extensionless
// relative imports (e.g. `from '../ids'`) don't resolve under Node's native
// ESM loader, which requires explicit extensions — so plain `node` can't run
// src/lib/seed.ts (or the tree it imports) directly. `typescript` is already
// a devDependency, so hook a transpile-on-load shim into `require`'s classic
// CommonJS resolver instead: it already probes extensionless specifiers
// against every extension registered here, same as it does for '.js'.
const require = createRequire(import.meta.url);

Module._extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  });
  mod._compile(outputText, filename);
};

const { seedUnclaimedApi } = require('../src/lib/seed.ts');

function appOrigin() {
  return process.env.PUBLIC_APP_ORIGIN?.replace(/\/$/, '') || 'http://localhost:3000';
}

const sourceUrl = process.argv[2];
if (!sourceUrl) {
  console.error('Usage: npm run seed:unclaimed -- <spec-url>');
  process.exit(1);
}

try {
  const { slug } = await seedUnclaimedApi({ sourceUrl });
  console.log(`${appOrigin()}/${slug}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
