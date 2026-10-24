import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it, vi } from "vitest";
import { replaceBackendForTesting } from "../src/index.ts";

describe("test setup", () => {
  it("leaves a vault's alarm to the test: when it fires on its own, it only waits", async () => {
    const backend = new FakeVaultBackend({ "README.md": "# Vault" });
    replaceBackendForTesting(backend);
    const stub = env.VAULT.getByName("setup-real-alarm");
    expect(await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A" }], "x")).toEqual({
      ok: true,
    });
    const alarmAt = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    // Due at once, as if the test had stalled past it: the runtime fires it.
    const due = Date.now() + 50;
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(due));
    await vi.waitFor(async () => expect(await alarmAt()).not.toBe(due), { timeout: 10_000 });

    // It wrote nothing and waits an hour, so the test's own run still finds it.
    expect(backend.commitRequests).toHaveLength(0);
    expect(((await alarmAt()) ?? 0) - Date.now()).toBeGreaterThan(30 * 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(backend.commitRequests).toHaveLength(1);
  });
});
