#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CALLS = new Set(["eval", "Function", "require", "fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);
const RUNTIME_GLOBALS = new Set(["process", "global", "globalThis", "module", "exports", "__dirname", "__filename"]);
const UNSAFE_GLOBALS = new Set([
  "console", "Bun", "Deno", "performance", "localStorage", "document", "window", "XMLHttpRequest", "WebSocket",
  "Object", "Reflect", "crypto", "navigator", "location", "Buffer", "WebAssembly", "SharedArrayBuffer",
  "setImmediate", "clearImmediate", "clearTimeout", "clearInterval", "queueMicrotask",
]);
const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
const NUMERIC_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

// Computed keys can name arbitrary properties through coercion. Keep only numeric
// indices and arithmetic expressions that necessarily coerce their operands to numbers.
function isNumericIndex(node, numericCoercion = false) {
  if (ts.isParenthesizedExpression(node)) return isNumericIndex(node.expression, numericCoercion);
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isIdentifier(node)) return numericCoercion;
  if (ts.isPrefixUnaryExpression(node)) {
    return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(node.operator) && isNumericIndex(node.operand, true);
  }
  if (ts.isBinaryExpression(node)) {
    return NUMERIC_BINARY_OPERATORS.has(node.operatorToken.kind) && isNumericIndex(node.left, true) && isNumericIndex(node.right, true);
  }
  return false;
}

export function purityViolations(source, filename = "candidate.ts") {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const add = (node, reason) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${filename}:${line + 1}: ${reason}`);
  };
  if (file.parseDiagnostics.length) {
    for (const diagnostic of file.parseDiagnostics) {
      const { line } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      violations.push(`${filename}:${line + 1}: TypeScript parse error`);
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) add(node, "imports and re-exports are not allowed");
    if (ts.isComputedPropertyName(node)) add(node, "computed property names are not allowed");
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword) add(node, "dynamic import is not allowed");
      else if (ts.isIdentifier(expr) && (CALLS.has(expr.text) || expr.text === "Date")) add(node, `${expr.text} calls are not allowed`);
      else if (ts.isPropertyAccessExpression(expr)) {
        const owner = expr.expression.getText(file);
        if (owner === "Date" && expr.name.text === "now") add(node, "Date.now is not allowed");
        if (owner === "Math" && expr.name.text === "random") add(node, "Math.random is not allowed");
        if (RUNTIME_GLOBALS.has(owner)) add(node, "runtime and global access are not allowed");
      }
    }
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_PROPERTIES.has(node.name.text)) add(node, "constructor-based dynamic evaluation and prototype access are not allowed");
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "Math" && node.name.text === "random") add(node, "Math.random is not allowed");
    if (ts.isElementAccessExpression(node) && (!node.argumentExpression || !isNumericIndex(node.argumentExpression))) add(node, "computed property access is not allowed");
    if (ts.isNewExpression(node) && ["Date", "Function"].includes(node.expression.getText(file))) add(node, `${node.expression.getText(file)} construction is not allowed`);
    if (ts.isIdentifier(node) && (RUNTIME_GLOBALS.has(node.text) || UNSAFE_GLOBALS.has(node.text) || CALLS.has(node.text) || node.text === "Date")) add(node, "runtime, clock, I/O, or dynamic evaluation access is not allowed");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(violations)];
}

export function countCodeTokens(source) {
  const file = ts.createSourceFile("tokens.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.EndOfFileToken || (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)) return;
    const children = node.getChildren(file);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.SyntaxList) count += 1;
      return;
    }
    children.forEach(visit);
  };
  visit(file);
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = process.argv[2];
  if (!candidate) {
    console.error("usage: node purity.mjs <candidate.ts>");
    process.exitCode = 2;
  } else {
    try {
      const failures = purityViolations(fs.readFileSync(candidate, "utf8"), candidate);
      if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
      else console.log("purity contract passed");
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
  }
}

