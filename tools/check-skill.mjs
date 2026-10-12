#!/usr/bin/env node
// Verification gate for the agent-builder skill: makes the repo's own claims checkable.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const REF_DIR = path.join(ROOT, 'references');

// Paths that the references actually use. SKILL.md declares the base monorepo layout
// (apps/web, apps/electron, packages/core, packages/shared); the references additionally
// document a `server/` backend, `packages/mcp-servers` and `packages/web`.
const ALLOWED_PREFIXES = [
  'packages/core',
  'packages/shared',
  'packages/mcp-servers',
  'packages/web',
  'apps/web',
  'apps/electron',
  'server/src',
];
// Rules the skill states about itself. Numbers here are the current measured baseline;
// CI fails only on regressions, so fixing a file lets you ratchet the number down.
const BASELINE = { 'as-any': 51, 'explicit-any': 177, 'console-log': 13 };

const fail = [];
const warn = [];
const bump = (m) => fail.push(m);
const note = (m) => warn.push(m);

function* mdBlocks(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^```(typescript|tsx|ts|javascript|js)\s*$/.exec(lines[i]);
    if (!m) continue;
    const fence = i + 1;
    const body = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
    yield { file, fence, lang: m[1], code: body.join('\n'), body };
  }
}

// TypeScript blocks in the references are often "fragments" — method bodies, class
// continuations, or object-literal slices that only make sense inside a class, namespace
// or function. Parsing every block as a standalone file would flag perfectly valid
// snippets. Try progressively more permissive wrapping contexts before reporting a failure.
function blockParses(code, lang) {
  const kind = lang === 'tsx' || /<[A-Za-z][^>]*className=/.test(code) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const candidates = [
    code,
    `class __Snippet__ {\n${code}\n}`,
    `namespace __Snippet__ {\n${code}\n}`,
    `async function* __snippet__() {\n${code}\n}`,
  ];
  for (const src of candidates) {
    const sf = ts.createSourceFile('block', src, ts.ScriptTarget.Latest, true, kind);
    if (!sf.parseDiagnostics || sf.parseDiagnostics.length === 0) return true;
  }
  return false;
}

const refFiles = fs.readdirSync(REF_DIR).filter((f) => f.endsWith('.md')).sort();
const allFiles = [path.join(ROOT, 'SKILL.md'), ...refFiles.map((f) => path.join(REF_DIR, f))];

// 1. Every TypeScript block must parse in at least one plausible context.
let blocks = 0;
for (const f of allFiles) {
  for (const b of mdBlocks(f)) {
    blocks++;
    if (blockParses(b.code, b.lang)) continue;
    const kind = b.lang === 'tsx' || /<[A-Za-z][^>]*className=/.test(b.code) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile('block', b.code, ts.ScriptTarget.Latest, true, kind);
    const d = sf.parseDiagnostics || [];
    const { line } = sf.getLineAndCharacterOfPosition(d[0].start);
    const rel = path.relative(ROOT, f);
    bump(`SYNTAX ${rel}:${b.fence + line + 1} (${d.length} errors) — ${b.body[line]?.trim().slice(0, 70)}`);
  }
}

// 2. Relative links must resolve (prose only — fenced code is not a link).
const stripFences = (t) => t.replace(/^```[\s\S]*?^```$/gm, '');
for (const f of allFiles.concat(['README.md', 'README.zh.md', 'README.en.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'assets/QUICK_START.md', 'assets/PRE_LAUNCH_CHECKLIST.md'].map((p) => path.join(ROOT, p)))) {
  if (!fs.existsSync(f)) continue;
  const text = stripFences(fs.readFileSync(f, 'utf8'));
  const rel = path.relative(ROOT, f);
  for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(#[^)]*)?\)/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target)) bump(`LINK   ${rel} -> ${m[1]} does not exist`);
  }
}

// 3. Declared file paths must live inside the layout the references (and SKILL.md) promise.
for (const f of refFiles.map((r) => path.join(REF_DIR, r))) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);
  for (const m of text.matchAll(/^\/\/ ((?:packages|apps|server|src)\/[A-Za-z0-9._/-]+)/gm)) {
    if (!ALLOWED_PREFIXES.some((p) => m[1].startsWith(p))) bump(`LAYOUT ${rel} -> ${m[1]} is outside the declared monorepo layout`);
  }
}

// 4. Per-reference structural promises made in SKILL.md.
//    Pitfall annotations are marked with 🤖 across all references ("🤖 **AI 常见错误** ...").
for (const r of refFiles) {
  const text = fs.readFileSync(path.join(REF_DIR, r), 'utf8');
  const pitfalls = (text.match(/🤖/g) || []).length;
  if (pitfalls < 3) bump(`PROMISE references/${r} -> ${pitfalls} pitfall markers (SKILL.md requires >=3)`);
  if (!/^##.*验收|^##.*[Cc]hecklist/m.test(text)) bump(`PROMISE references/${r} -> no verification-checklist section (SKILL.md claims every reference has one)`);
}

// 5. Self-imposed bans: track instead of pretending they are gone.
let asAny = 0, anyAnn = 0, clog = 0;
for (const r of refFiles) {
  const t = fs.readFileSync(path.join(REF_DIR, r), 'utf8');
  asAny += (t.match(/\bas any\b/g) || []).length;
  anyAnn += (t.match(/: any\b/g) || []).length;
  clog += (t.match(/console\.log\(/g) || []).length;
}
for (const [k, now] of [['as-any', asAny], ['explicit-any', anyAnn], ['console-log', clog]]) {
  if (now > BASELINE[k]) bump(`REGRESS ${k}: ${now} > baseline ${BASELINE[k]}`);
  else if (now < BASELINE[k]) note(`${k}: ${now} (baseline ${BASELINE[k]} — lower it)`);
}

console.log(`code blocks parsed: ${blocks}`);
for (const w of warn) console.log('  note  ' + w);
for (const e of fail) console.log('  FAIL  ' + e);
console.log(`\n${fail.length} failures, ${warn.length} notes`);
process.exit(fail.length ? 1 : 0);