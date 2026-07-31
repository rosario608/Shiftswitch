import { describe, expect, it } from "vitest";
import {
  isProbablyEmail,
  splitAddresses,
  toEntries,
} from "@/components/ui/email-input";

/**
 * The parsing behind the invite field.
 *
 * Every case here is something a program coordinator actually does: pasting a
 * column out of a spreadsheet, pasting from a mail client that wraps addresses
 * in angle brackets, typing a list with commas, or mistyping one address in
 * twenty.
 */

describe("splitting what somebody typed or pasted", () => {
  it("handles one address", () => {
    expect(splitAddresses("sarah@hospital.org")).toEqual(["sarah@hospital.org"]);
  });

  it("handles commas, semicolons, newlines, tabs and spaces", () => {
    const expected = ["a@h.org", "b@h.org", "c@h.org"];
    expect(splitAddresses("a@h.org, b@h.org, c@h.org")).toEqual(expected);
    expect(splitAddresses("a@h.org; b@h.org; c@h.org")).toEqual(expected);
    expect(splitAddresses("a@h.org\nb@h.org\nc@h.org")).toEqual(expected);
    expect(splitAddresses("a@h.org\tb@h.org\tc@h.org")).toEqual(expected);
    expect(splitAddresses("a@h.org b@h.org c@h.org")).toEqual(expected);
  });

  it("handles the mixture a real paste actually is", () => {
    expect(
      splitAddresses("a@h.org,  b@h.org;\n c@h.org\r\nd@h.org ,,, e@h.org"),
    ).toEqual(["a@h.org", "b@h.org", "c@h.org", "d@h.org", "e@h.org"]);
  });

  it("strips the punctuation mail clients wrap addresses in", () => {
    expect(splitAddresses("<sarah@hospital.org>")).toEqual(["sarah@hospital.org"]);
    expect(splitAddresses('"sarah@hospital.org",')).toEqual(["sarah@hospital.org"]);
    expect(splitAddresses("sarah@hospital.org.")).toEqual(["sarah@hospital.org"]);
  });

  it("produces nothing from nothing", () => {
    expect(splitAddresses("")).toEqual([]);
    expect(splitAddresses("   \n\t , ; ")).toEqual([]);
  });
});

describe("telling somebody an address is wrong", () => {
  it("accepts ordinary addresses, including the awkward ones", () => {
    for (const value of [
      "sarah@hospital.org",
      "sarah.j.okonkwo@med.hospital.org",
      "s+residency@hospital.co.uk",
      "s_o'brien@hospital.org",
      "SARAH@HOSPITAL.ORG",
    ]) {
      expect(isProbablyEmail(value), value).toBe(true);
    }
  });

  it("rejects the mistakes people actually make", () => {
    for (const value of [
      "sarah",
      "sarah@",
      "@hospital.org",
      "sarah@hospital",
      "sarah hospital.org",
      "sarah@@hospital.org",
      "",
    ]) {
      expect(isProbablyEmail(value), value).toBe(false);
    }
  });
});

describe("marking up a list", () => {
  it("flags invalid addresses individually, not the whole list", () => {
    const entries = toEntries(["good@h.org", "broken", "also.good@h.org"]);
    expect(entries.map((entry) => entry.valid)).toEqual([true, false, true]);
  });

  it("flags the second occurrence, leaving the first usable", () => {
    const entries = toEntries(["a@h.org", "b@h.org", "a@h.org"]);
    expect(entries.map((entry) => entry.duplicate)).toEqual([false, false, true]);
  });

  it("treats addresses differing only in case as the same person", () => {
    const entries = toEntries(["Sarah@Hospital.org", "sarah@hospital.org"]);
    expect(entries[1].duplicate).toBe(true);
  });

  it("keeps the order somebody entered them in", () => {
    const values = ["c@h.org", "a@h.org", "b@h.org"];
    expect(toEntries(values).map((entry) => entry.value)).toEqual(values);
  });
});
