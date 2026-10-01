/**
 * Rewrites `@engine/...` specifiers in the compiled server to relative paths.
 *
 * `tsc` resolves path aliases for type checking but emits them verbatim, so a
 * compiled `require("@engine/run/pipeline")` fails at runtime. The usual answer
 * is another build dependency; this is fifteen lines instead, and the output
 * layout it depends on is fixed by `rootDir` in the tsconfig beside it.
 *
 * It fails loudly if it finds a specifier it cannot resolve, rather than
 * leaving a broken require for the first request to discover.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? 'dist/server');
const engineRoot = join(outDir, 'engine', 'src');

if (!existsSync(engineRoot)) {
  console.error(`fix-aliases: ${engineRoot} does not exist — did the server build run?`);
  process.exit(1);
}

let rewritten = 0;
let failed = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!path.endsWith('.js')) continue;

    const before = readFileSync(path, 'utf8');
    const after = before.replace(/(["'])@engine\/([^"']+)\1/g, (match, quote, tail) => {
      const target = join(engineRoot, tail);
      const candidates = [`${target}.js`, join(target, 'index.js')];
      if (!candidates.some((c) => existsSync(c))) {
        console.error(`fix-aliases: cannot resolve @engine/${tail} from ${path}`);
        failed += 1;
        return match;
      }
      let rel = relative(dirname(path), target).split('\\').join('/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      rewritten += 1;
      return `${quote}${rel}${quote}`;
    });

    if (after !== before) writeFileSync(path, after, 'utf8');
  }
}

walk(outDir);

if (failed > 0) {
  console.error(`fix-aliases: ${failed} unresolved specifier(s)`);
  process.exit(1);
}
console.log(`fix-aliases: rewrote ${rewritten} specifier(s) under ${outDir}`);
