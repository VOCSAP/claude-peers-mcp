import { test, expect } from "bun:test";
import { startBroker, stopBroker } from "./_helper.ts";

// The pure-function tests prove scrubEnv itself works, but not that
// startBroker actually WIRES it in -- a revert of that one call site would
// leave those green. This spawns a real broker and asserts on the env it was
// ACTUALLY given, not a reconstruction of it.

test("startBroker's actual spawn env is protected, not a value reconstructed after the fact", async () => {
  const b = await startBroker();
  try {
    expect(b.env.APPDATA).toBe(b.tmpDir);
    expect(b.env.XDG_CONFIG_HOME).toBe(b.tmpDir);
  } finally {
    await stopBroker(b);
  }
});
