import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// Tests keep their original URLs, relative assets and child-process topology.
// Only this project's TypeScript is transformed. JavaScript, dependencies and
// compiled serving modules retain the ordinary Node loader.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
let compiler;
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const file = fileURLToPath(url);
    if (!file.startsWith(root) || !file.endsWith('.ts') || file.endsWith('.d.ts') || file.includes('/node_modules/')) return nextLoad(url, context);
    compiler ??= require('typescript');
    const result = compiler.transpileModule(readFileSync(new URL(url), 'utf8'), {
      fileName: file, reportDiagnostics: true,
      compilerOptions: { target: compiler.ScriptTarget.ESNext, module: compiler.ModuleKind.ESNext, verbatimModuleSyntax: true }
    });
    const errors = (result.diagnostics ?? []).filter(d => d.category === compiler.DiagnosticCategory.Error);
    if (errors.length) throw new SyntaxError(compiler.formatDiagnostics(errors, { getCanonicalFileName: p => p, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
    return { format: 'module', source: result.outputText, shortCircuit: true };
  }
});
