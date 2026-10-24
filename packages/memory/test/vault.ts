import type { VaultChange, VaultCommit } from "../src/index.ts";

/** An in-memory git repository: files at the head, and every commit in order. */
export class FakeVault {
  readonly files = new Map<string, string>();
  readonly history: VaultCommit[] = [];
  #clock = Date.parse("2026-10-01T00:00:00Z");

  /** Commits a change set an hour after the previous commit; a null content removes the file. */
  commit(changes: Record<string, string | null>): VaultCommit {
    this.#clock += 3_600_000;
    const list: VaultChange[] = Object.entries(changes).map(([path, content]) => ({
      path,
      content,
    }));
    for (const { path, content } of list) {
      if (content === null) this.files.delete(path);
      else this.files.set(path, content);
    }
    const commit = {
      sha: (this.history.length + 1).toString(16).padStart(40, "c"),
      committedAt: this.#clock,
      changes: list,
    };
    this.history.push(commit);
    return commit;
  }

  /** The head as a single commit: what a rebuild without history sees. */
  snapshot(): VaultCommit {
    const head = this.history.at(-1);
    if (head === undefined) throw new Error("no commits");
    return {
      sha: head.sha,
      committedAt: head.committedAt,
      changes: [...this.files].map(([path, content]) => ({ path, content })),
    };
  }
}
