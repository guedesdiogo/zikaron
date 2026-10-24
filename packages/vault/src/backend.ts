// Where the vault lives (ADR-0005): one interface, with GitHub as its first adapter. Another backend
// is one more class behind the same interface, picked by configuration.

/** A file of the vault at one commit. */
export interface VaultFile {
  path: string;
  content: string;
  /** Git's blob SHA of the content. */
  blobSha: string;
}

export interface VaultSnapshot {
  commit: string;
  files: VaultFile[];
}

/** A file a diff added or changed (`content`), or removed (`content: null`). */
export interface FileChange {
  path: string;
  content: string | null;
  blobSha?: string;
}

export interface VaultDiff {
  from: string;
  to: string;
  changes: FileChange[];
}

export interface CommitRequest {
  branch: string;
  /** The head the commit must land on: if the branch moved, the commit is refused. */
  expectedHead: string;
  headline: string;
  /** Trailers go here, such as `Kelpie-Agent: <agent-id>` (ADR-0016). */
  body?: string;
  /** Text, written as UTF-8, or a binary file's bytes, such as a skill's font (ADR-0058 §5). */
  writes: readonly { path: string; content: string | Uint8Array }[];
  deletions: readonly string[];
}

/**
 * A commit landed, or the branch moved (`stale`: sync and try again), or GitHub refused this change
 * itself (`refused`: trying it again would fail the same way). Transport failures throw.
 */
export type CommitOutcome =
  | { kind: "committed"; commit: string }
  | { kind: "stale" }
  | { kind: "refused"; reason: string };

export interface PullRequest {
  number: number;
  url: string;
}

export interface VaultBackend {
  defaultBranch(): Promise<string>;
  /** The branch's head commit, or null when the branch doesn't exist. */
  branchHead(branch: string): Promise<string | null>;
  /** The vault's text files at a commit. */
  snapshot(commit: string): Promise<VaultSnapshot>;
  /**
   * What changed from one commit to a later one. Null when `to` doesn't descend from `from` (a
   * force-push) or the diff is too large to list: the caller then takes a snapshot.
   */
  diff(from: string, to: string): Promise<VaultDiff | null>;
  commit(request: CommitRequest): Promise<CommitOutcome>;
  createBranch(name: string, from: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  openPullRequest(request: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
}

/** The files the Context Store keeps: Markdown, outside hidden folders such as `.obsidian/`. */
export function isVaultText(path: string): boolean {
  return path.endsWith(".md") && !path.split("/").some((segment) => segment.startsWith("."));
}
