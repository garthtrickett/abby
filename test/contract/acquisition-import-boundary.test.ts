import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(new URL("../../", import.meta.url).pathname);
const source = (...parts: string[]) => resolve(root, "src", ...parts);
const entries = [
  ...readdirSync(source("core")).filter(name => name.endsWith(".ts")).map(name => source("core", name)),
  source("reference", "text-reception.ts"), source("reference", "availability-text-runner.ts"),
  source("reference", "embedded-composition.ts"), source("reference", "embedded-voice-composition.ts"),
  source("voice", "voice-session.ts"), source("voice", "connected-voice-call.ts"),
];
const forbidden = /^src\/(?:storage|standalone|cliniko|splose)\//;

test("portable call core and embedded composition have no standalone database or provider import path", () => {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    const path = relative(root, file).replaceAll("\\", "/");
    assert.doesNotMatch(path, forbidden);
    if (seen.has(file)) continue;
    seen.add(file);
    const body = readFileSync(file, "utf8");
    if (entries.includes(file)) assert.doesNotMatch(body, /\b(?:cliniko|splose|postgres|kysely)\b/i,
      `${path} contains a provider or standalone database branch`);
    const parsed = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      const module = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        ? statement.moduleSpecifier : undefined;
      if (!module || !ts.isStringLiteral(module) || !module.text.startsWith(".")) continue;
      const target = resolve(file, "..", module.text);
      assert.ok(existsSync(target), `${path} imports missing ${module.text}`);
      pending.push(target);
    }
  }
});
