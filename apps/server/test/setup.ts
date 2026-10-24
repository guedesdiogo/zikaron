// Runs before every test file (vitest.config.ts `setupFiles`), so each one, a new one too, sets up
// its vaults and cleans up after its tests the same way.
import { reset } from "cloudflare:test";
import { afterEach } from "vitest";
import { clearKeyCache } from "../src/identity.ts";
import { replaceBackendForTesting, replaceKeyFetcherForTesting, Vault } from "../src/index.ts";

// Tests run a vault's alarm by hand, with `runDurableObjectAlarm`. The runtime also fires it by the
// clock, a second or five after it's set, and would overtake a test that stalls that long.
// The runtime passes a real alarm its invocation info and a manual run nothing: a real one only
// waits an hour more, so the test's own run still finds an alarm to run.
const MANUAL = Symbol.for("zikaron.test.alarm");
const vault = Vault.prototype as Vault & { [MANUAL]?: Vault["alarm"] };
// This file runs again for each test file; the vault's own handler is kept from the first time.
vault[MANUAL] ??= vault.alarm;
const manual = vault[MANUAL];
vault.alarm = async function (this: Vault, ...info: unknown[]) {
  if (info[0] === undefined) return manual.call(this);
  const { ctx } = this as unknown as { ctx: DurableObjectState };
  await ctx.storage.setAlarm(Date.now() + 60 * 60_000);
};

afterEach(async () => {
  replaceBackendForTesting(undefined);
  // As chaves do Access ficam em cache pelo domínio do time: cada arquivo gera as suas.
  replaceKeyFetcherForTesting(undefined);
  clearKeyCache();
  // A test's vaults go, alarms and all: one left with an alarm wakes in a later test, where it
  // syncs with that test's backend.
  await reset();
});
