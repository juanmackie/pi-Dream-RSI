#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function parseArgs(args) {
  const options = { mode: "elapsed", warmup: 1, repeats: 3, timeout: 300_000, output: "eval/score.json", unit: "ms" };
  let index = 0;
  while (index < args.length && args[index] !== "--") {
    const match = /^(--[a-z-]+)=(.*)$/.exec(args[index]);
    if (!match) throw new Error(`expected --name=value option, got ${args[index]}`);
    const [, key, value] = match;
    if (key === "--mode") options.mode = value;
    else if (key === "--output") options.output = value;
    else if (key === "--unit") options.unit = value;
    else if (["--warmup", "--repeats", "--timeout"].includes(key)) options[key.slice(2)] = Number(value);
    else throw new Error(`unknown option ${key}`);
    index += 1;
  }
  if (args[index] !== "--") throw new Error("missing -- before evaluator command");
  const command = args.slice(index + 1);
  if (!command.length) throw new Error("evaluator command is required");
  if (!["elapsed", "stdout-number"].includes(options.mode)) throw new Error("mode must be elapsed or stdout-number");
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0 || !Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 100) throw new Error("warmup must be >= 0 and repeats must be from 1 to 100");
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 2_147_483_647) throw new Error("timeout must be an integer from 1 to 2147483647 milliseconds");
  return { options, command };
}

export function measure(args = process.argv.slice(2), cwd = process.cwd()) {
  let options;
  let command;
  try { ({ options, command } = parseArgs(args)); }
  catch (error) { return writeFailure(cwd, { error: error.message, fail_class: "invalid_configuration" }); }
  const samples = [];
  const total = options.warmup + options.repeats;
  for (let index = 0; index < total; index += 1) {
    const started = performance.now();
    const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", timeout: options.timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      return writeFailure(cwd, { error: result.error?.message ?? `command exited with status ${result.status}`, fail_class: result.error?.code === "ETIMEDOUT" ? "timeout" : "evaluator_error" }, options.output);
    }
    const elapsedMs = performance.now() - started;
    let value = elapsedMs;
    if (options.mode === "stdout-number") {
      const text = result.stdout.trim();
      if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(text)) return writeFailure(cwd, { error: "evaluator stdout must contain one finite number", fail_class: "invalid_output" }, options.output);
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return writeFailure(cwd, { error: "evaluator stdout must contain one finite number", fail_class: "invalid_output" }, options.output);
      value = parsed;
    }
    if (index >= options.warmup) samples.push(value);
  }
  const score = median(samples);
  const result = { score, raw_score: score, valid: true, fail_class: "ok", error: null, mode: options.mode, unit: options.mode === "elapsed" ? options.unit : "", warmup: options.warmup, repeats: options.repeats, samples };
  const output = path.resolve(cwd, options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return 0;
}

function writeFailure(cwd, fields, outputPath = "eval/score.json") {
  const output = path.resolve(cwd, outputPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ score: 0, raw_score: null, valid: false, fail_class: fields.fail_class, error: fields.error }, null, 2)}\n`, "utf8");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = measure();
