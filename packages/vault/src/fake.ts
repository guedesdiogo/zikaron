import type {
  CommitOutcome,
  CommitRequest,
  FileChange,
  PullRequest,
  VaultBackend,
  VaultDiff,
  VaultSnapshot,
} from "./backend.ts";
import { isVaultText } from "./backend.ts";
import { gitBlobSha } from "./blob-sha.ts";

interface Commit {
  parent: string | null;
  files: Map<string, string>;
}

/** An in-memory git repository behind the vault interface, for tests. */
export class FakeVaultBackend implements VaultBackend {
  readonly #commits = new Map<string, Commit>();
  readonly #branches = new Map<string, string>();
  /** Every commit request Kelpie made, accepted or not. */
  readonly commitRequests: CommitRequest[] = [];
  readonly pullRequests: (PullRequest & {
    branch: string;
    base: string;
    title: string;
    body: string;
  })[] = [];
  #count = 0;

  constructor(files: Record<string, string> = {}) {
    this.#branches.set("main", this.#add(null, new Map(Object.entries(files))));
  }

  #add(parent: string | null, files: Map<string, string>): string {
    this.#count += 1;
    const sha = this.#count.toString(16).padStart(40, "0");
    this.#commits.set(sha, { parent, files });
    return sha;
  }

  #commit(sha: string): Commit {
    const commit = this.#commits.get(sha);
    if (!commit) throw new Error(`no commit ${sha}`);
    return commit;
  }

  /** An edit made outside Kelpie, such as the owner's in Obsidian: a commit straight on a branch. */
  push(changes: Record<string, string | null>, branch = "main"): string {
    const head = this.#branches.get(branch);
    if (head === undefined) throw new Error(`no branch ${branch}`);
    const files = new Map(this.#commit(head).files);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    const sha = this.#add(head, files);
    this.#branches.set(branch, sha);
    return sha;
  }

  /**
   * A rewritten history, as `git filter-repo` and a force-push leave it: the branch moves to a new
   * root commit with these files, which descends from nothing Kelpie has seen.
   */
  forcePush(files: Record<string, string>, branch = "main"): string {
    const sha = this.#add(null, new Map(Object.entries(files)));
    this.#branches.set(branch, sha);
    return sha;
  }

  /** The branches, in creation order. */
  branches(): string[] {
    return [...this.#branches.keys()];
  }

  /** The files at a branch's head. */
  files(branch = "main"): Record<string, string> {
    return Object.fromEntries(this.#commit(this.#branches.get(branch) ?? "").files);
  }

  async defaultBranch(): Promise<string> {
    return "main";
  }

  async branchHead(branch: string): Promise<string | null> {
    return this.#branches.get(branch) ?? null;
  }

  async snapshot(commit: string): Promise<VaultSnapshot> {
    const files = await Promise.all(
      [...this.#commit(commit).files]
        .filter(([path]) => isVaultText(path))
        .map(async ([path, content]) => ({ path, content, blobSha: await gitBlobSha(content) })),
    );
    return { commit, files };
  }

  async diff(from: string, to: string): Promise<VaultDiff | null> {
    let cursor: string | null = to;
    while (cursor !== null && cursor !== from) cursor = this.#commit(cursor).parent;
    if (cursor === null) return null;
    const before = this.#commit(from).files;
    const after = this.#commit(to).files;
    const changes: FileChange[] = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      if (!isVaultText(path) || before.get(path) === after.get(path)) continue;
      const content = after.get(path);
      changes.push(
        content === undefined
          ? { path, content: null }
          : { path, content, blobSha: await gitBlobSha(content) },
      );
    }
    return {
      from,
      to,
      changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
  }

  async commit(request: CommitRequest): Promise<CommitOutcome> {
    this.commitRequests.push(request);
    const head = this.#branches.get(request.branch);
    if (head !== request.expectedHead) return { kind: "stale" };
    const files = new Map(this.#commit(head).files);
    // A binary file is kept as one character per byte, so a test reads it back as a string.
    for (const { path, content } of request.writes) {
      files.set(path, typeof content === "string" ? content : String.fromCharCode(...content));
    }
    for (const path of request.deletions) {
      // As GitHub does, a commit that removes a missing file is refused.
      if (!files.has(path)) return { kind: "refused", reason: "UNPROCESSABLE" };
      files.delete(path);
    }
    const sha = this.#add(head, files);
    this.#branches.set(request.branch, sha);
    return { kind: "committed", commit: sha };
  }

  async createBranch(name: string, from: string): Promise<void> {
    if (this.#branches.has(name)) throw new Error(`branch ${name} exists`);
    this.#commit(from);
    this.#branches.set(name, from);
  }

  async deleteBranch(name: string): Promise<void> {
    this.#branches.delete(name);
  }

  async openPullRequest(request: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const number = this.pullRequests.length + 1;
    const pull = { number, url: `https://github.test/vault/pull/${number}`, ...request };
    this.pullRequests.push(pull);
    return { number, url: pull.url };
  }
}
