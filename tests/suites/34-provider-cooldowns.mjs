// Cooldowns, quota detection and key rotation — the arithmetic behind "Never
// Run Dry" — exercised without a network, a key, or an app.
//
// This is what the providers carve was for. The subsystem was three separate
// ranges of main.ts (docs/STRUCTURAL_DEBT.md item 1): cooldowns near the top,
// secrets in the middle, invocation five hundred lines later. Whole, it is one
// module that needs ten things and imports electron for none of them —
// `safeStorage` is injected precisely so this file can load.
//
// What that buys: the decision of WHICH key to try next, and how long to stand
// a provider down after a 429, is now checkable. Before, it could only be
// observed by running out of quota on a real account.
//
// Offline: no provider is called, no network is touched, no key is read.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const p = await fromBuild("electron/providers.js");
const store = await fromBuild("electron/store.js");

// providers.ts imports the store for its audit trail, so point it somewhere
// harmless rather than at a real profile.
const root = mkdtempSync(join(tmpdir(), "metis-providers-test-"));
store.configureStore(root);

p.configureProviders({
  cancellationError: () => new Error("cancelled"),
  isAbortError: (error) => error?.name === "AbortError",
  registerAbortController: () => new AbortController(),
  unregisterAbortController: () => {},
  directiveScopeKey: (path) => path ?? "global",
  emitStream: () => {},
  estimateUsage: (inChars, outChars) => ({ inputTokens: Math.ceil(inChars / 4), outputTokens: Math.ceil(outChars / 4), estimated: true }),
  createThinkTagStreamSplitter: () => ({ feed: () => {}, flush: () => {} }),
  splitThinkTaggedOutput: (value) => ({ output: value, thoughts: "" }),
  sha256: (value) => value,
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8")
  }
});

section("A quota error is recognised by status OR by message");
{
  // Two independent signals, because providers disagree about which they send.
  // A 429 with an unhelpful body and a 200-shaped error whose text says "rate
  // limit" both have to count, or a provider stays hot while it is refusing.
  ok("a 429 counts", p.isQuotaError(new p.ProviderHttpError("nope", 429)));
  ok("rate limit in the message counts", p.isQuotaError(new Error("Rate limit reached for this key")));
  ok("so does rate-limit hyphenated", p.isQuotaError(new Error("rate-limit exceeded")));
  ok("and quota", p.isQuotaError(new Error("You exceeded your current quota")));
  ok("and insufficient balance", p.isQuotaError(new Error("insufficient balance")));
  ok("and insufficient credits", p.isQuotaError(new Error("insufficient credits")));

  // The other side. Treating an ordinary failure as a quota error stands a
  // working key down for ten minutes.
  ok("a 500 does not count", !p.isQuotaError(new p.ProviderHttpError("server error", 500)));
  ok("a 401 does not count", !p.isQuotaError(new p.ProviderHttpError("unauthorized", 401)));
  ok("a timeout does not count", !p.isQuotaError(new Error("connect ETIMEDOUT")));
  ok("nor a plain string", !p.isQuotaError("something went wrong"));
  ok("nor null", !p.isQuotaError(null));
}

section("Cooldown length honours Retry-After, and falls back to ten minutes");
{
  const before = Date.now();
  const withHeader = p.markProviderCooldown("groq", new p.ProviderHttpError("slow down", 429, 30));
  const headerMs = withHeader - before;
  ok(`Retry-After: 30 gives ~30s, got ${Math.round(headerMs / 1000)}s`, headerMs >= 29_000 && headerMs <= 31_000);

  const plain = p.markProviderCooldown("nvidia", new Error("rate limit"));
  const plainMs = plain - Date.now();
  ok(`no header gives ~10m, got ${Math.round(plainMs / 60000)}m`, plainMs > 9 * 60_000 && plainMs <= 10 * 60_000);

  // A zero or negative Retry-After must NOT produce a cooldown in the past —
  // that would mean the provider never actually stands down.
  const zero = p.markProviderCooldown("openai", new p.ProviderHttpError("x", 429, 0));
  ok("Retry-After: 0 falls back rather than expiring immediately", zero - Date.now() > 60_000);
  const negative = p.markProviderCooldown("gemini", new p.ProviderHttpError("x", 429, -5));
  ok("and a negative one cannot schedule the past", negative > Date.now());
}

section("A cooling provider reads as cooling, and recovers");
{
  p.markProviderCooldown("deepseek", new Error("quota"));
  ok("it is cooling", p.isProviderCooling("deepseek") === true);
  ok("and the deadline is readable", typeof p.providerCooldownUntil("deepseek") === "number");

  ok("an untouched provider is not cooling", p.isProviderCooling("anthropic") === false);
  ok("and has no deadline", p.providerCooldownUntil("anthropic") === undefined);
}

section("Cooldown is shown in minutes, and never as a negative");
{
  check("ten minutes out", p.formatCooldownDuration(Date.now() + 10 * 60_000), "10m");
  check("one minute out", p.formatCooldownDuration(Date.now() + 60_000), "1m");
  // A deadline that has passed must read as nearly over, not as "-3m", which is
  // what a bare subtraction produces and what a user would see mid-recovery.
  check("already expired", p.formatCooldownDuration(Date.now() - 5 * 60_000), "under a minute");
  check("exactly now", p.formatCooldownDuration(Date.now()), "under a minute");
}

section("Rotation picks the least recently used key, and skips cooling ones");
{
  const account = (id, lastUsed) => ({ id, provider: "groq", label: id, keyRef: `ref-${id}`, lastUsed });

  const ordered = p.orderAccountsForRotation([
    account("recent", 3000),
    account("oldest", 1000),
    account("middle", 2000)
  ]);
  check("least recently used first", ordered.map((a) => a.id), ["oldest", "middle", "recent"]);

  // A key that has never been used sorts ahead of every key that has — it is
  // the one most likely to have quota left.
  const withFresh = p.orderAccountsForRotation([account("used", 500), account("fresh", undefined)]);
  check("a never-used key goes first", withFresh.map((a) => a.id), ["fresh", "used"]);

  // Cooling accounts are removed, not just deprioritised: trying one is a
  // guaranteed 429 and burns a request to learn nothing.
  p.markAccountCooldown("cooling-one", new Error("rate limit"));
  const filtered = p.orderAccountsForRotation([account("cooling-one", 100), account("fine", 200)]);
  check("a cooling account is dropped entirely", filtered.map((a) => a.id), ["fine"]);

  check("all cooling means nothing to try", p.orderAccountsForRotation([account("cooling-one", 1)]), []);
  check("and an empty pool stays empty", p.orderAccountsForRotation([]), []);

  // Ordering must not mutate the caller's array — it is read from a stored
  // record that other code holds a reference to.
  const input = [account("b", 2), account("a", 1)];
  p.orderAccountsForRotation(input);
  check("the input array is not reordered in place", input.map((a) => a.id), ["b", "a"]);
}

section("Secrets round-trip through the injected keychain");
{
  // safeStorage is injected precisely so this file can load at all. With
  // encryption unavailable — the fake's answer, and a real Linux box without a
  // keyring — the value must still round-trip rather than being lost.
  const status = await p.setSecret("groq", "sk-test-value");
  check("the status reports the provider", status.provider, "groq");
  ok("and says a secret is present", status.hasSecret === true);
  // The plain-local path is base64, not encryption, and says so rather than
  // implying a protection it does not have.
  check("storage is labelled honestly", status.storage, "plain-local");

  const back = await p.readProviderSecret("groq");
  check("the value survives", back, "sk-test-value");

  await p.deleteSecret("groq");
  ok("and deleting removes it", (await p.readProviderSecret("groq")) === undefined);
}

rmSync(root, { recursive: true, force: true });

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
