import { test, expect, beforeAll, afterAll } from "bun:test";
import { hostname } from "node:os";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => { broker = await startBroker(); });
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, pid: number) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: pid,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

// Bug D: handleRegister did process.kill(existingPeer.pid, 0) without filtering
// on host == BROKER_HOST. In HTTP cross-machine mode that kill throws
// unconditionally, flipping the existing peer to dormant, and the next branch
// resurrected the row with the second session's data while keeping the first
// session's instance_token. Two concurrent Claude Code sessions on the same
// (host, cwd, group_id) ended up sharing a single DB row, a single peer_id
// and a single WebSocket slot. The fix scopes the kill to same-host peers.

test("second register on same (host, cwd, group_id) from a cross-host peer mints a fresh id", async () => {
  const myHost = hostname();
  const remoteHost = `remote-${Date.now().toString(36)}`;
  const cwd = "/collide/cwd";

  // First register from a remote host with a guaranteed-live PID.
  const first = await register(remoteHost, cwd, livePid());
  expect(first.body.peer_id).toBeTruthy();

  // Second register on the exact same (host, cwd, group_id). The broker MUST
  // detect an active collision and mint a fresh peer_id with a suffix, rather
  // than incorrectly flipping the first to dormant and resurrecting in place.
  const second = await register(remoteHost, cwd, livePid());

  expect(second.body.peer_id).not.toBe(first.body.peer_id);
  expect(second.body.instance_token).not.toBe(first.body.instance_token);
  // Default id derivation appends a numeric suffix on collision.
  expect(second.body.peer_id.startsWith(first.body.peer_id)).toBe(true);
});

test("same-host duplicate register on dead pid still resurrects the original token", async () => {
  // Sanity check: the same-host path retains its old behavior. A dead PID
  // (very high integer the OS will not have allocated) triggers the kill
  // catch branch, which legitimately flips to dormant and resurrects.
  const myHost = hostname();
  const cwd = "/same-host/cwd";
  const DEAD_PID = 99_999_999;

  const first = await register(myHost, cwd, DEAD_PID);
  const second = await register(myHost, cwd, livePid());

  expect(second.body.instance_token).toBe(first.body.instance_token);
  expect(second.body.peer_id).toBe(first.body.peer_id);
});
