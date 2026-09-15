import { describe, expect, it } from "vitest";
import { isBoundedRegex } from "../src/clause.js";

/**
 * JS-specific half of expand-targeting-model task 4.7's bounded-regex
 * requirement: unlike Go's RE2-native stdlib regexp (which structurally
 * cannot express these), native JS RegExp accepts backreferences and
 * lookaround, both of which can cause catastrophic (non-linear)
 * backtracking, so isBoundedRegex must reject them explicitly. Manually
 * verified load-bearing: commenting out EXCLUDED_REGEX_CONSTRUCTS'
 * check in isBoundedRegex made both rejection cases below pass (return
 * true) instead of failing; restored before committing.
 */
describe("isBoundedRegex", () => {
  it("accepts an RE2-safe pattern", () => {
    expect(isBoundedRegex("^br-.*$")).toBe(true);
  });

  it("rejects a backreference", () => {
    expect(isBoundedRegex("(foo)\\1")).toBe(false);
  });

  it("rejects a named backreference", () => {
    expect(isBoundedRegex("(?<x>foo)\\k<x>")).toBe(false);
  });

  it("rejects a positive lookahead", () => {
    expect(isBoundedRegex("foo(?=bar)")).toBe(false);
  });

  it("rejects a negative lookbehind", () => {
    expect(isBoundedRegex("(?<!foo)bar")).toBe(false);
  });

  it("rejects a syntactically invalid pattern", () => {
    expect(isBoundedRegex("(unclosed")).toBe(false);
  });
});
