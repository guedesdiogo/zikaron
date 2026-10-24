// The vault on GitHub, through a GitHub App installation (ADR-0005), as spike #28 proved it: the
// App's JWT signed with WebCrypto, an installation token narrowed to the vault repository, reads
// over REST and GraphQL, and writes with `createCommitOnBranch` guarded by `expectedHeadOid`.
import {
  type CommitOutcome,
  type CommitRequest,
  type FileChange,
  isVaultText,
  type PullRequest,
  type VaultBackend,
  type VaultDiff,
  type VaultFile,
  type VaultSnapshot,
} from "../backend.ts";
import { base64 } from "./encoding.ts";
import { importPrivateKey, signAppJwt } from "./jwt.ts";

const API = "https://api.github.com";
/** A blob GraphQL truncates is fetched again over REST; past this size it isn't kept at all. */
const MAX_FILE_BYTES = 1_048_576;
/** Paths read per GraphQL query. */
const BLOB_BATCH = 50;
/** GitHub's compare lists at most 300 files; a longer diff takes a snapshot instead. */
const COMPARE_FILE_LIMIT = 300;
/** Git's mode for a symbolic link. Its blob holds the target's path, not a note (#196). */
const SYMLINK_MODE = 0o120000;

export interface GitHubVaultOptions {
  appId: string;
  installationId: string;
  /** `owner/name`. */
  repository: string;
  /** The App's private key as a PKCS#8 PEM. */
  privateKey: string;
  fetch: typeof fetch;
  now?: () => number;
}

/** A GitHub request that failed. The message names the call and the status, never a credential. */
export class GitHubError extends Error {
  readonly status: number;

  constructor(call: string, status: number, detail?: string) {
    super(`GitHub ${call} answered ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "GitHubError";
    this.status = status;
  }
}

interface GraphqlError {
  type?: string;
  message: string;
}

export class GitHubVaultBackend implements VaultBackend {
  readonly #options: GitHubVaultOptions;
  readonly #owner: string;
  readonly #name: string;
  #key: Promise<CryptoKey> | undefined;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(options: GitHubVaultOptions) {
    const [owner, name, ...rest] = options.repository.split("/");
    if (!owner || !name || rest.length > 0) {
      throw new Error("the vault repository must be `owner/name`");
    }
    this.#options = options;
    this.#owner = owner;
    this.#name = name;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** An installation token, renewed five minutes before it expires (it lasts an hour). */
  async #installationToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt - this.#now() > 300_000) return this.#token.value;
    this.#key ??= importPrivateKey(this.#options.privateKey);
    const jwt = await signAppJwt(await this.#key, this.#options.appId, this.#now());
    const response = await this.#options.fetch(
      `${API}/app/installations/${this.#options.installationId}/access_tokens`,
      {
        method: "POST",
        headers: { ...HEADERS, authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        // Narrowed to the vault and to what the Context Store does, whatever else the App may do.
        body: JSON.stringify({
          repositories: [this.#name],
          permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        }),
      },
    );
    const body = (await readJson(response)) as { token?: string; expires_at?: string } | null;
    if (response.status !== 201 || typeof body?.token !== "string") {
      throw new GitHubError("installation token", response.status);
    }
    const expiresAt = Date.parse(body.expires_at ?? "");
    this.#token = {
      value: body.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.#now() + 3_600_000,
    };
    return body.token;
  }

  async #rest<T>(
    call: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | null }> {
    const token = await this.#installationToken();
    const response = await this.#options.fetch(`${API}/repos/${this.#owner}/${this.#name}${path}`, {
      method,
      headers: {
        ...HEADERS,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await readJson(response)) as T | null;
    if (response.status >= 500 || response.status === 401 || response.status === 403) {
      throw new GitHubError(call, response.status);
    }
    return { status: response.status, body: parsed };
  }

  async #graphql<T>(call: string, query: string, variables: Record<string, unknown>) {
    const token = await this.#installationToken();
    const response = await this.#options.fetch(`${API}/graphql`, {
      method: "POST",
      headers: { ...HEADERS, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await readJson(response)) as { data?: T | null; errors?: GraphqlError[] } | null;
    if (!response.ok) throw new GitHubError(call, response.status);
    return { data: body?.data ?? null, errors: body?.errors ?? [] };
  }

  async defaultBranch(): Promise<string> {
    const { status, body } = await this.#rest<{ default_branch?: string }>("repository", "GET", "");
    if (status !== 200 || typeof body?.default_branch !== "string") {
      throw new GitHubError("repository", status);
    }
    return body.default_branch;
  }

  async branchHead(branch: string): Promise<string | null> {
    const { status, body } = await this.#rest<{ object?: { sha?: string } }>(
      "branch head",
      "GET",
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (status === 404) return null;
    if (status !== 200 || typeof body?.object?.sha !== "string") {
      throw new GitHubError("branch head", status);
    }
    return body.object.sha;
  }

  async snapshot(commit: string): Promise<VaultSnapshot> {
    const { status, body } = await this.#rest<{
      truncated?: boolean;
      tree?: { path: string; mode?: string; type: string; sha: string; size?: number }[];
    }>("tree", "GET", `/git/trees/${commit}?recursive=1`);
    if (status !== 200 || !body?.tree) throw new GitHubError("tree", status);
    if (body.truncated)
      throw new GitHubError("tree", status, "the vault's tree is too large to list");
    const entries = body.tree.filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== SYMLINK_MODE.toString(8) &&
        isVaultText(entry.path) &&
        (entry.size ?? 0) <= MAX_FILE_BYTES,
    );
    return { commit, files: await this.#read(commit, entries) };
  }

  /** File contents at a commit, in batches of GraphQL `object(expression:)` reads. */
  async #read(
    commit: string,
    entries: readonly { path: string; sha: string }[],
  ): Promise<VaultFile[]> {
    const files: VaultFile[] = [];
    for (let start = 0; start < entries.length; start += BLOB_BATCH) {
      const batch = entries.slice(start, start + BLOB_BATCH);
      const variables: Record<string, unknown> = { owner: this.#owner, name: this.#name };
      batch.forEach((entry, i) => {
        variables[`e${i}`] = `${commit}:${entry.path}`;
      });
      const { data, errors } = await this.#graphql<{
        repository: Record<
          string,
          { text: string | null; isTruncated: boolean; byteSize: number } | null
        >;
      }>("read files", readFilesQuery(batch.length), variables);
      if (errors.length > 0 || !data) {
        throw new GitHubError("read files", 200, errors[0]?.type ?? "no data");
      }
      for (const [i, entry] of batch.entries()) {
        const blob = data.repository[`f${i}`];
        // GitHub listed this file at this commit, so a missing object is a failed read, not a
        // removal.
        if (!blob) throw new GitHubError("read files", 200, "a listed file has no object");
        // A file past the size the vault keeps is skipped, whichever way it was found.
        if (blob.byteSize > MAX_FILE_BYTES) continue;
        let text = blob.text;
        if (blob.isTruncated) text = await this.#blobText(entry.sha);
        if (text !== null) files.push({ path: entry.path, content: text, blobSha: entry.sha });
      }
    }
    return files;
  }

  /** Which of these files are symbolic links at a commit, from their folders' entries. */
  async #symlinks(commit: string, entries: readonly { path: string }[]): Promise<Set<string>> {
    const wanted = new Set(entries.map(({ path }) => path));
    const folders = [...new Set([...wanted].map(folderOf))];
    const links = new Set<string>();
    for (let start = 0; start < folders.length; start += BLOB_BATCH) {
      const batch = folders.slice(start, start + BLOB_BATCH);
      const variables: Record<string, unknown> = { owner: this.#owner, name: this.#name };
      batch.forEach((folder, i) => {
        variables[`d${i}`] = `${commit}:${folder}`;
      });
      const { data, errors } = await this.#graphql<{
        repository: Record<string, { entries?: { name: string; mode: number }[] } | null>;
      }>("read folders", readFoldersQuery(batch.length), variables);
      if (errors.length > 0 || !data) {
        throw new GitHubError("read folders", 200, errors[0]?.type ?? "no data");
      }
      for (const [i, folder] of batch.entries()) {
        const tree = data.repository[`d${i}`];
        // A listed file's folder exists at this commit, so a missing tree is a failed read.
        if (!tree?.entries)
          throw new GitHubError("read folders", 200, "a listed folder has no tree");
        for (const { name, mode } of tree.entries) {
          const path = folder === "" ? name : `${folder}/${name}`;
          if (mode === SYMLINK_MODE && wanted.has(path)) links.add(path);
        }
      }
    }
    return links;
  }

  async #blobText(sha: string): Promise<string | null> {
    const { status, body } = await this.#rest<{ content?: string; encoding?: string }>(
      "blob",
      "GET",
      `/git/blobs/${sha}`,
    );
    if (status !== 200 || body?.encoding !== "base64" || typeof body.content !== "string") {
      throw new GitHubError("blob", status);
    }
    const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    try {
      // Kept byte for byte, BOM included, so the text hashes back to the same blob SHA.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  async diff(from: string, to: string): Promise<VaultDiff | null> {
    const { status, body } = await this.#rest<{
      status?: string;
      files?: { filename: string; status: string; sha: string; previous_filename?: string }[];
    }>("compare", "GET", `/compare/${from}...${to}`);
    if (status === 404) return null;
    if (status !== 200 || !body) throw new GitHubError("compare", status);
    if (body.status !== "ahead" && body.status !== "identical") return null;
    const files = body.files ?? [];
    if (files.length >= COMPARE_FILE_LIMIT) return null;
    const changes: FileChange[] = [];
    const reads: { path: string; sha: string }[] = [];
    for (const file of files) {
      if (
        file.status === "renamed" &&
        file.previous_filename &&
        isVaultText(file.previous_filename)
      ) {
        changes.push({ path: file.previous_filename, content: null });
      }
      if (!isVaultText(file.filename)) continue;
      if (file.status === "removed") changes.push({ path: file.filename, content: null });
      else reads.push({ path: file.filename, sha: file.sha });
    }
    // The compare API gives no mode. A link leaves the working copy, as a snapshot leaves it out.
    const links = await this.#symlinks(to, reads);
    for (const path of links) changes.push({ path, content: null });
    const notes = reads.filter(({ path }) => !links.has(path));
    const read = await this.#read(to, notes);
    for (const file of read) changes.push(file);
    // A file past the size the vault keeps, or no longer text, leaves the working copy, as a
    // snapshot would leave it out.
    const kept = new Set(read.map((file) => file.path));
    for (const { path } of notes) if (!kept.has(path)) changes.push({ path, content: null });
    return {
      from,
      to,
      changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
  }

  async commit(request: CommitRequest): Promise<CommitOutcome> {
    const encoder = new TextEncoder();
    const input = {
      branch: { repositoryNameWithOwner: this.#options.repository, branchName: request.branch },
      message: {
        headline: request.headline,
        ...(request.body === undefined ? {} : { body: request.body }),
      },
      expectedHeadOid: request.expectedHead,
      fileChanges: {
        additions: request.writes.map(({ path, content }) => ({
          path,
          contents: base64(typeof content === "string" ? encoder.encode(content) : content),
        })),
        deletions: request.deletions.map((path) => ({ path })),
      },
    };
    const { data, errors } = await this.#graphql<{
      createCommitOnBranch: { commit: { oid: string } | null } | null;
    }>("commit", COMMIT_MUTATION, { input });
    // A stale head answers 200 with STALE_DATA, and the branch doesn't move (spike #28).
    if (errors.some((error) => error.type === "STALE_DATA")) return { kind: "stale" };
    const oid = data?.createCommitOnBranch?.commit?.oid;
    if (typeof oid === "string" && errors.length === 0) return { kind: "committed", commit: oid };
    const type = errors[0]?.type;
    // GitHub answered, and refused this change; a rate limit passes, so it isn't a refusal.
    if (type !== undefined && type !== "RATE_LIMITED") return { kind: "refused", reason: type };
    throw new GitHubError("commit", 200, type ?? "no commit");
  }

  async createBranch(name: string, from: string): Promise<void> {
    const { status } = await this.#rest("create branch", "POST", "/git/refs", {
      ref: `refs/heads/${name}`,
      sha: from,
    });
    if (status !== 201) throw new GitHubError("create branch", status);
  }

  async deleteBranch(name: string): Promise<void> {
    const { status } = await this.#rest(
      "delete branch",
      "DELETE",
      `/git/refs/heads/${encodeURIComponent(name).replaceAll("%2F", "/")}`,
    );
    if (status !== 204 && status !== 404) throw new GitHubError("delete branch", status);
  }

  async openPullRequest(request: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const { status, body } = await this.#rest<{ number?: number; html_url?: string }>(
      "open pull request",
      "POST",
      "/pulls",
      { title: request.title, body: request.body, head: request.branch, base: request.base },
    );
    if (status !== 201 || typeof body?.number !== "number" || typeof body.html_url !== "string") {
      throw new GitHubError("open pull request", status);
    }
    return { number: body.number, url: body.html_url };
  }
}

/** GitHub rejects requests without a User-Agent, and Workers' fetch sets none. */
const HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "zikaron",
} as const;

const COMMIT_MUTATION = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

function readFilesQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, i) => `$e${i}: String!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `f${i}: object(expression: $e${i}) { ... on Blob { text isTruncated byteSize } }`,
  ).join("\n    ");
  return `query ($owner: String!, $name: String!, ${variables}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
}

/** The entries of folders, by `object(expression:)`; GraphQL gives a mode as a decimal number. */
function readFoldersQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, i) => `$d${i}: String!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `d${i}: object(expression: $d${i}) { ... on Tree { entries { name mode } } }`,
  ).join("\n    ");
  return `query ($owner: String!, $name: String!, ${variables}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
}

/** A path's folder, empty at the root, which `<commit>:` names. */
function folderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

/** A JSON body, or null when GitHub answered with something else, such as an HTML 5xx page. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
