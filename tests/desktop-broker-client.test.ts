import { test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBrokerEndpoint,
  computeGroupSecretHash,
  buildAnnouncePayload,
  sendAnnounce
} from "../desktop/src/main/broker-client.ts";

const dirs: string[] = [];
function tmpConfig(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-bc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("resolveBrokerEndpoint defaults to loopback on the configured port", () => {
  const cfg = tmpConfig({ port: 7912 });
  const ep = resolveBrokerEndpoint({} as NodeJS.ProcessEnv, cfg);
  expect(ep.url).toBe("http://127.0.0.1:7912");
  expect(ep.token).toBeNull();
});

test("resolveBrokerEndpoint reads broker_url + broker_token from the config file", () => {
  const cfg = tmpConfig({ broker_url: "http://broker.local:7899", broker_token: "sekret" });
  const ep = resolveBrokerEndpoint({} as NodeJS.ProcessEnv, cfg);
  expect(ep.url).toBe("http://broker.local:7899");
  expect(ep.token).toBe("sekret");
});

test("resolveBrokerEndpoint: env overrides the config file", () => {
  const cfg = tmpConfig({ broker_url: "http://file:1", broker_token: "file-token", port: 1 });
  const env = {
    CLAUDE_PEERS_BROKER_URL: "http://env:2",
    CLAUDE_PEERS_BROKER_TOKEN: "env-token"
  } as unknown as NodeJS.ProcessEnv;
  const ep = resolveBrokerEndpoint(env, cfg);
  expect(ep.url).toBe("http://env:2");
  expect(ep.token).toBe("env-token");
});

test("resolveBrokerEndpoint tolerates a missing config file", () => {
  const ep = resolveBrokerEndpoint({ CLAUDE_PEERS_PORT: "8000" } as unknown as NodeJS.ProcessEnv, "/no/such/config.json");
  expect(ep.url).toBe("http://127.0.0.1:8000");
});

test("computeGroupSecretHash is the full sha256 hex of the secret", () => {
  const expected = createHash("sha256").update("my-secret", "utf-8").digest("hex");
  expect(computeGroupSecretHash("my-secret")).toBe(expected);
});

test("buildAnnouncePayload hashes the secret and defaults exclude to null", () => {
  const p = buildAnnouncePayload({ groupId: "abc123", secret: "s3cret", text: "hi" });
  expect(p.group_id).toBe("abc123");
  expect(p.group_secret_hash).toBe(createHash("sha256").update("s3cret", "utf-8").digest("hex"));
  expect(p.text).toBe("hi");
  expect(p.exclude_peer_id).toBeNull();
});

test("buildAnnouncePayload passes exclude_peer_id through", () => {
  const p = buildAnnouncePayload({ groupId: "g", secret: "s", text: "t", excludePeerId: "joiner" });
  expect(p.exclude_peer_id).toBe("joiner");
});

test("sendAnnounce POSTs /announce with the payload + bearer token and returns sent", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ sent: 3 }), { status: 200 });
  }) as unknown as typeof fetch;

  const res = await sendAnnounce(
    { groupId: "g1", secret: "s1", text: "broadcast", excludePeerId: "x" },
    { endpoint: { url: "http://broker:7899", token: "tok" }, fetchFn }
  );
  expect(res.sent).toBe(3);
  expect(captured!.url).toBe("http://broker:7899/announce");
  const headers = captured!.init.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer tok");
  const body = JSON.parse(captured!.init.body as string);
  expect(body.group_id).toBe("g1");
  expect(body.text).toBe("broadcast");
  expect(body.exclude_peer_id).toBe("x");
  expect(body.group_secret_hash).toBe(createHash("sha256").update("s1", "utf-8").digest("hex"));
});

test("sendAnnounce omits the Authorization header when there is no token", async () => {
  let headers: Record<string, string> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers = (init?.headers as Record<string, string>) ?? {};
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  await sendAnnounce(
    { groupId: "g", secret: "s", text: "t" },
    { endpoint: { url: "http://x", token: null }, fetchFn }
  );
  expect(headers["Authorization"]).toBeUndefined();
});

test("sendAnnounce throws on a non-2xx response", async () => {
  const fetchFn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await expect(
    sendAnnounce({ groupId: "g", secret: "s", text: "t" }, { endpoint: { url: "http://x", token: null }, fetchFn })
  ).rejects.toThrow("announce failed: 401");
});
