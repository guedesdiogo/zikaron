import { isReservedPath } from "@zikaron/memory";
import { isVaultText } from "@zikaron/vault";

/**
 * O nome de um cliente (`noah`, `alan`, `mac`…): um slug, que nomeia o escopo `agent/<nome>` e a
 * pasta `agents/<nome>/memory/` (ADR-0001 §1).
 */
export function isClientName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

/** Names Windows reserves, which would break the owner's checkout there. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * A relative vault path with no `.`/`..` segments, and nothing that breaks a checkout or spoofs a
 * name: none of `\ : * ? " < > |`, no control or format characters (bidirectional overrides,
 * zero-width spaces), no segment ending in a dot or a space, and no reserved Windows names.
 */
export function isCleanPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith("/") &&
    !/[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(path) &&
    path
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !/[. ]$/.test(segment) &&
          !RESERVED.test(segment),
      )
  );
}

/** Folders any client may write memory and knowledge into (Kelpie's ADR-0016 and ADR-0020). */
const SHARED_ROOTS = ["memory/", "knowledge/", "areas/", "projects/", "conversations/"];

/**
 * Where a client may write: memory and knowledge, and its own memory folder. Root files and other
 * clients' folders not at all.
 */
export function isWritable(client: string, path: string): boolean {
  // `memory/_…/` holds the server's own files, such as the memory report, which no client may forge.
  if (!isCleanPath(path) || !isVaultText(path) || isReservedPath(path)) return false;
  return (
    SHARED_ROOTS.some((root) => path.startsWith(root)) ||
    path.startsWith(`agents/${client}/memory/`)
  );
}
