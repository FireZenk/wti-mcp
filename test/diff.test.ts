import { describe, expect, it } from "vitest";
import { compareLines } from "../src/diff.js";

describe("compareLines", () => {
  it("reports lines only on each side, with their line numbers", () => {
    const wti = ["<resources>", '  <string name="a">A</string>', '  <string name="b">Old</string>', "</resources>"].join("\n");
    const local = ["<resources>", '  <string name="a">A</string>', '  <string name="b">New</string>', '  <string name="c">C</string>', "</resources>"].join("\n");

    expect(compareLines(wti, local)).toEqual({
      onlyBefore: [{ line: 3, text: '<string name="b">Old</string>' }],
      onlyAfter: [
        { line: 3, text: '<string name="b">New</string>' },
        { line: 4, text: '<string name="c">C</string>' },
      ],
    });
  });

  it("ignores order, indentation, blank lines, CRLF and a BOM", () => {
    const wti = "﻿a: 1\r\nb: 2\r\n\r\n";
    const local = "  b: 2\n\n\na: 1   \n";
    expect(compareLines(wti, local)).toEqual({ onlyBefore: [], onlyAfter: [] });
  });

  it("matches repeated lines one to one", () => {
    expect(compareLines("x\nx\ny", "x\ny\ny")).toEqual({
      onlyBefore: [{ line: 2, text: "x" }],
      onlyAfter: [{ line: 3, text: "y" }],
    });
  });

  it("treats an empty side as having no lines", () => {
    expect(compareLines("", "a\nb").onlyAfter).toHaveLength(2);
    expect(compareLines("a", "").onlyBefore).toEqual([{ line: 1, text: "a" }]);
  });
});
