import assert from "node:assert/strict";
import { test } from "node:test";

import { attemptDemotion } from "../extensions/pi-dream-rsi/engine/levers.ts";

test("one shared attempt-demotion factor preserves the outcome ranking", () => {
  assert.equal(attemptDemotion(undefined), 1);
  assert.equal(attemptDemotion("win"), 0.15);
  assert.equal(attemptDemotion("no-win"), 0.5);
  assert.equal(attemptDemotion("rejected"), 0.35);
  assert.equal(attemptDemotion("error"), 0.6);
});
