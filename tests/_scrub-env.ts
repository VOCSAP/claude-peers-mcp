// CLAUDE_PEERS_* is purged so a token or URL left in the developer's shell
// can never leak in -- otherwise a stray token turns every unauthenticated
// test POST into a 401. But loadConfig() resolves env THEN a settings file,
// so that purge owns only half: offline_replica (file only) demotes an
// injected broker_url to a replication upstream, since brokerUrl() returns
// broker_url only in "remote" mode. settingsDir must be a directory that
// never holds a claude-peers/config.json (an already-owned scratch dir, e.g.
// a TestBroker's tmpDir, needs no new directory). extra is spread last so a
// caller-owned override (its own config.json elsewhere) keeps winning.
export function scrubEnv(
  settingsDir: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  // extra winning last (below) is a real override path, not just a leftover
  // ordering: refuse the one shape it must never carry, extra reinjecting the
  // REAL ambient value of the var it exists to neutralize. Only compares when
  // extra explicitly SETS the key: an unset ambient var (e.g. APPDATA on a
  // non-Windows CI runner) and an absent extra key are both undefined, and
  // that pairing must never be read as reinjection.
  for (const k of ["APPDATA", "XDG_CONFIG_HOME"] as const) {
    const ambient = process.env[k];
    if (ambient !== undefined && Object.prototype.hasOwnProperty.call(extra, k) && extra[k] === ambient) {
      throw new Error(`scrubEnv: extra.${k} re-injects the real ambient ${k}; pass a scratch directory instead`);
    }
  }
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
  ) as Record<string, string>;
  return { ...scrubbed, APPDATA: settingsDir, XDG_CONFIG_HOME: settingsDir, ...extra };
}
