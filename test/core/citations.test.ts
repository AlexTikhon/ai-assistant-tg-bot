import { describe, expect, it } from "vitest";
import { groundCitations } from "../../src/core/citations.js";

describe("groundCitations", () => {
  it("accepts references to sources that exist", () => {
    expect(groundCitations("Restart the feeder [1]. Check the logs [2][3].", 3)).toEqual({
      text: "Restart the feeder [1]. Check the logs [2][3].",
      cited: [1, 2, 3],
      unknown: [],
    });
  });

  it("removes a reference to a source that was never in the context", () => {
    const result = groundCitations("The limit is 10 requests [99].", 3);

    expect(result.text).toBe("The limit is 10 requests.");
    expect(result.cited).toEqual([]);
    expect(result.unknown).toEqual([99]);
  });

  it("keeps the valid part of a combined reference", () => {
    const result = groundCitations("See [1, 99] and [7; 2].", 3);

    expect(result.text).toBe("See [1] and [2].");
    expect(result.cited).toEqual([1, 2]);
    expect(result.unknown).toEqual([7, 99]);
  });

  it("treats [0] and every reference as unknown when there are no sources", () => {
    expect(groundCitations("Maybe [0] or [1].", 0)).toEqual({ text: "Maybe or.", cited: [], unknown: [0, 1] });
  });

  it("reports repeated references once and leaves them in the text", () => {
    const result = groundCitations("A [2]. B [2]. C [1][2].", 2);

    expect(result.cited).toEqual([1, 2]);
    expect(result.text).toBe("A [2]. B [2]. C [1][2].");
  });

  it("does not touch brackets that are not citations", () => {
    const text = "Use arr[5] and matrix[1][2]; the year [2024] and [text] and [] stay as they are.";

    expect(groundCitations(text, 2)).toEqual({ text, cited: [], unknown: [] });
  });

  it("copes with malformed or odd input without throwing", () => {
    for (const text of ["", "[", "]]][[[", "[1", "1]", "[ 1 ]", "[1,]", "[,1]", "[١]", "[1][", "[".repeat(5000)]) {
      expect(() => groundCitations(text, 2)).not.toThrow();
    }
    expect(groundCitations("[1,]", 2).text).toBe("[1,]");
  });
});
