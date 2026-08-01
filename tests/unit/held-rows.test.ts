import { describe, expect, it } from "vitest";
import { matchKey } from "@/server/domain/held-rows";

/**
 * Matching a person in a file to a person in the program.
 *
 * The asymmetry that shapes every case here: a row that fails to match stays
 * held, visible to the administrator under the name the file used, and costs
 * somebody thirty seconds. A row that matches the *wrong* person puts one
 * resident's call on another resident's phone. So these tests are as interested
 * in what does not match as in what does.
 */

describe("two spellings of one name", () => {
  it("reads Last, First and First Last as the same person", () => {
    // Both appear in one real block file, written by two different people.
    expect(matchKey("Osei, Nadia")).toBe(matchKey("Nadia Osei"));
    expect(matchKey("Reyes, Tom")).toBe(matchKey("Tom Reyes"));
  });

  it("ignores case, punctuation and extra spacing", () => {
    expect(matchKey("  NADIA   OSEI ")).toBe(matchKey("Nadia Osei"));
    expect(matchKey("O'Brien, Sean")).toBe(matchKey("Sean O Brien"));
  });

  it("ignores a middle initial, which half the files carry and half do not", () => {
    expect(matchKey("Nadia K Osei")).toBe(matchKey("Nadia Osei"));
    expect(matchKey("Osei, Nadia K.")).toBe(matchKey("Nadia Osei"));
  });

  it("ignores a degree or a suffix", () => {
    expect(matchKey("Nadia Osei, MD")).toBe(matchKey("Nadia Osei"));
    expect(matchKey("Dr Nadia Osei")).toBe(matchKey("Nadia Osei"));
    expect(matchKey("Tom Reyes Jr")).toBe(matchKey("Tom Reyes"));
  });

  it("reads an accent as the letter underneath it", () => {
    /* The file exported from the scheduling system has the accent; the one the
       resident typed into Google does not, or the other way round. */
    expect(matchKey("José Álvarez")).toBe(matchKey("Jose Alvarez"));
  });

  it("reads a hyphenated surname as its parts", () => {
    expect(matchKey("Ama Boateng-Smith")).toBe(matchKey("Ama Boateng Smith"));
  });
});

describe("two people who are not the same person", () => {
  it("keeps different names apart", () => {
    expect(matchKey("Nadia Osei")).not.toBe(matchKey("Nadia Okafor"));
    expect(matchKey("Tom Reyes")).not.toBe(matchKey("Tom Reyess"));
    expect(matchKey("Sam Lee")).not.toBe(matchKey("Pam Lee"));
  });

  it("does not collapse a shared surname", () => {
    expect(matchKey("Tom Reyes")).not.toBe(matchKey("Ana Reyes"));
  });
});

describe("input that is not really a name", () => {
  it("produces an empty key rather than one that matches everything", () => {
    /* An empty key must never match: `claimHeldRows` guards on `match_key <> ''`
       precisely because a blank Resident cell in one row would otherwise hand
       that row to whoever enrolled next. */
    expect(matchKey("")).toBe("");
    expect(matchKey("   ")).toBe("");
    expect(matchKey("—")).toBe("");
    expect(matchKey("MD")).toBe("");
  });

  it("survives a single-word name rather than discarding it", () => {
    expect(matchKey("Prince")).toBe("prince");
  });
});
