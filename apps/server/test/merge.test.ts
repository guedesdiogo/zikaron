import { describe, expect, it } from "vitest";
import { mergeOwnerWins } from "../src/merge.ts";

const lines = (...text: string[]) => `${text.join("\n")}\n`;

describe("mergeOwnerWins", () => {
  const base = lines("# Ana", "", "Mora em Lisboa.", "", "Gosta de café.", "", "Tem um gato.");

  it("keeps both sides' changes where they don't overlap", () => {
    const owner = lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem um gato.");
    const server = lines(
      "# Ana",
      "",
      "Mora em Lisboa.",
      "",
      "Gosta de café.",
      "",
      "Tem dois gatos.",
    );
    expect(mergeOwnerWins(base, owner, server)).toEqual({
      content: lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem dois gatos."),
      overlapped: false,
    });
  });

  it("takes the owner's side where they overlap, and keeps the server's other changes", () => {
    const owner = lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem um gato.");
    const server = lines("# Ana", "", "Mora em Braga.", "", "Gosta de chá.", "", "Tem um gato.");
    // The server's line 5 is next to nothing the owner touched, so it stays.
    expect(mergeOwnerWins(base, owner, server)).toEqual({
      content: lines("# Ana", "", "Mora no Porto.", "", "Gosta de chá.", "", "Tem um gato."),
      overlapped: true,
    });
  });

  it("sees the same change on both sides as no overlap", () => {
    const both = lines("# Ana", "", "Mora no Porto.", "", "Gosta de café.", "", "Tem um gato.");
    expect(mergeOwnerWins(base, both, both)).toEqual({ content: both, overlapped: false });
  });

  it("keeps lines the server appended after the owner's edit", () => {
    const owner = base.replace("café", "café forte");
    const server = `${base}\nFaz anos em maio.\n`;
    expect(mergeOwnerWins(base, owner, server)).toEqual({
      content: `${owner}\nFaz anos em maio.\n`,
      overlapped: false,
    });
  });

  it("follows the owner's line endings, and a file without a final newline", () => {
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    const owner = crlf(base.replace("café", "café forte"));
    const server = base.replace("um gato", "dois gatos");
    expect(mergeOwnerWins(base, owner, server)).toEqual({
      content: crlf(base.replace("café", "café forte").replace("um gato", "dois gatos")),
      overlapped: false,
    });
    const trimmed = base.trimEnd();
    expect(mergeOwnerWins(base, trimmed, `${base}Faz anos em maio.\n`)).toEqual({
      content: `${trimmed}\nFaz anos em maio.`,
      overlapped: false,
    });
  });

  it("keeps lines both sides added at the same place, the owner's first", () => {
    expect(mergeOwnerWins(base, `${base}Do dono.\n`, `${base}Do servidor.\n`)).toEqual({
      content: `${base}Do dono.\nDo servidor.\n`,
      overlapped: false,
    });
  });

  it("leaves a file too long to merge, or one without a common start, to the owner", () => {
    const most = "linha\n".repeat(499);
    expect(mergeOwnerWins(most, `${most}a\n`, `${most}b\n`)).not.toBeNull();
    const long = "linha\n".repeat(501);
    expect(mergeOwnerWins(long, `${long}a\n`, `${long}b\n`)).toBeNull();
    // Both wrote a whole document over an empty file: two documents aren't one.
    expect(
      mergeOwnerWins("", "---\nkind: note\n---\n# A\n", "---\nkind: person\n---\n# B\n"),
    ).toBeNull();
  });

  it("takes the owner's first line ending for the whole file", () => {
    const owner = "# Ana\r\n\r\nMora no Porto.\n";
    const merged = mergeOwnerWins(
      "# Ana\n\nMora em Lisboa.\n",
      owner,
      "# Ana\n\nMora em Lisboa.\nTem um gato.\n",
    );
    expect(merged?.content.startsWith("# Ana\r\n")).toBe(true);
  });
});
