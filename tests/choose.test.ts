import { test, expect, describe } from "bun:test";
import { choose } from "../src/choose";

describe("choose", () => {
  test("returns the only choice without prompting", async () => {
    const result = await choose("pick", [{ label: "only", value: 42 }]);
    expect(result).toBe(42);
  });

  test("returns first choice when stdin is not a TTY", async () => {
    const result = await choose("pick", [
      { label: "a", value: "a" },
      { label: "b", value: "b" },
    ]);
    expect(result).toBe("a");
  });

  test("throws on empty choices", async () => {
    await expect(choose("pick", [])).rejects.toThrow("no choices");
  });
});
