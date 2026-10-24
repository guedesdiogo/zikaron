import { beforeAll, describe, expect, it } from "vitest";
import { GitHubError, GitHubVaultBackend } from "../src/index.ts";
import { generateAppKey } from "./helpers.ts";

let privateKey: string;

beforeAll(async () => {
  privateKey = (await generateAppKey()).pem;
});

/**
 * A backend whose GitHub answers each request from `routes`, by method and path; the installation
 * token always comes, unless a route answers it too.
 */
function vaultAnswering(routes: Record<string, () => Response>) {
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    const route = routes[key];
    if (route) return route();
    if (key === "POST /app/installations/7/access_tokens") {
      return Response.json(
        { token: "t", expires_at: new Date(Date.now() + 3_600_000) },
        {
          status: 201,
        },
      );
    }
    throw new Error(`unexpected ${key}`);
  };
  return new GitHubVaultBackend({
    appId: "123",
    installationId: "7",
    repository: "owner/vault",
    privateKey,
    fetch: fetchFn as typeof fetch,
  });
}

const json = (status: number, body: unknown) => () => Response.json(body, { status });

async function failure(promise: Promise<unknown>): Promise<GitHubError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitHubError);
  return error as GitHubError;
}

describe("GitHubVaultBackend, on unexpected answers", () => {
  it("fails when GitHub refuses the installation token", async () => {
    const vault = vaultAnswering({
      "POST /app/installations/7/access_tokens": json(403, { message: "Forbidden" }),
    });
    expect((await failure(vault.defaultBranch())).message).toBe(
      "GitHub installation token answered 403",
    );
  });

  it("keeps a token GitHub gave without an expiry for an hour", async () => {
    let tokens = 0;
    const vault = vaultAnswering({
      "POST /app/installations/7/access_tokens": () => {
        tokens += 1;
        return Response.json({ token: "t" }, { status: 201 });
      },
      "GET /repos/owner/vault": json(200, { default_branch: "main" }),
    });
    await vault.defaultBranch();
    await vault.defaultBranch();
    expect(tokens).toBe(1);
  });

  it("fails on a server error, and on an answer without what was asked", async () => {
    expect(
      (await failure(vaultAnswering({ "GET /repos/owner/vault": json(502, {}) }).defaultBranch()))
        .status,
    ).toBe(502);
    expect(
      (await failure(vaultAnswering({ "GET /repos/owner/vault": json(200, {}) }).defaultBranch()))
        .message,
    ).toBe("GitHub repository answered 200");
    const head = vaultAnswering({ "GET /repos/owner/vault/git/ref/heads/main": json(200, {}) });
    expect((await failure(head.branchHead("main"))).message).toBe(
      "GitHub branch head answered 200",
    );
  });

  it("refuses a tree GitHub cut short, or didn't send", async () => {
    const tree = (body: unknown) =>
      vaultAnswering({ "GET /repos/owner/vault/git/trees/abc?recursive=1": json(200, body) });
    expect((await failure(tree({ truncated: true, tree: [] }).snapshot("abc"))).message).toBe(
      "GitHub tree answered 200: the vault's tree is too large to list",
    );
    expect((await failure(tree({}).snapshot("abc"))).message).toBe("GitHub tree answered 200");
  });

  it("fails a branch GitHub didn't create, and accepts deleting one already gone", async () => {
    const vault = vaultAnswering({
      "POST /repos/owner/vault/git/refs": json(422, { message: "Reference already exists" }),
      "DELETE /repos/owner/vault/git/refs/heads/kelpie/gone": () =>
        new Response(null, { status: 404 }),
      "DELETE /repos/owner/vault/git/refs/heads/kelpie/locked": json(422, {}),
    });
    expect((await failure(vault.createBranch("kelpie/x", "abc"))).status).toBe(422);
    await expect(vault.deleteBranch("kelpie/gone")).resolves.toBeUndefined();
    expect((await failure(vault.deleteBranch("kelpie/locked"))).status).toBe(422);
  });

  it("fails a pull request answered without its number", async () => {
    const vault = vaultAnswering({ "POST /repos/owner/vault/pulls": json(201, {}) });
    const request = { branch: "kelpie/x", base: "main", title: "t", body: "b" };
    expect((await failure(vault.openPullRequest(request))).message).toBe(
      "GitHub open pull request answered 201",
    );
  });

  it("retries a rate-limited commit later, and reports any other refusal", async () => {
    const commitWith = (type: string) =>
      vaultAnswering({
        "POST /graphql": json(200, { data: null, errors: [{ type, message: type }] }),
      }).commit({
        branch: "main",
        expectedHead: "abc",
        headline: "h",
        writes: [],
        deletions: [],
      });
    expect((await failure(commitWith("RATE_LIMITED"))).message).toBe(
      "GitHub commit answered 200: RATE_LIMITED",
    );
    await expect(commitWith("FORBIDDEN")).resolves.toEqual({
      kind: "refused",
      reason: "FORBIDDEN",
    });
  });
});
