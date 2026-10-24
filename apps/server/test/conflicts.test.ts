import { describe, expect, it } from "vitest";
import { hasConflictMarkers } from "../src/conflicts.ts";

describe("hasConflictMarkers", () => {
  it.each([
    ["git's markers", "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> main\nb\n"],
    ["diff3's, with the base", "<<<<<<< ours\nx\n||||||| base\ny\n=======\nz\n>>>>>>> theirs"],
    ["Windows line ends", "<<<<<<< HEAD\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> main\r\n"],
  ])("finds %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(true);
  });

  it.each([
    ["a heading's underline", "Planos\n=======\n\nViajar.\n"],
    ["an unfinished block", "<<<<<<< HEAD\nmine\n=======\ntheirs\n"],
    ["markers out of order", ">>>>>>> main\n=======\n<<<<<<< HEAD\n"],
    ["markers inside a line", "see <<<<<<< HEAD and ======= and >>>>>>> main"],
    ["markers quoted in a code fence", "```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n```\n"],
    ["markers quoted in a tilde fence", "~~~\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n~~~\n"],
  ])("ignores %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(false);
  });

  it.each([
    ["after a fence left open", "```\ncode\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n"],
    [
      "inside a fence a shorter one can't close",
      "````\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n```\n",
    ],
  ])("finds a conflict %s", (_name, text) => {
    expect(hasConflictMarkers(text)).toBe(true);
  });

  it("reads a file in one pass, however its markers repeat", () => {
    const repeated = "<<<<<<<\n=======\n".repeat(32_000);
    const opened = "<<<<<<<\n".repeat(64_000);
    const started = performance.now();
    expect(hasConflictMarkers(repeated)).toBe(false);
    expect(hasConflictMarkers(opened)).toBe(false);
    // A backtracking regex took tens of seconds on these 512 KB.
    expect(performance.now() - started).toBeLessThan(1_000);
    // An unfinished block over a long file: its lines are kept one at a time.
    expect(hasConflictMarkers(`<<<<<<< HEAD\n${"\n".repeat(600_000)}`)).toBe(false);
  });
});
