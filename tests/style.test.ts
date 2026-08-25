import { test, expect, describe, afterAll } from "bun:test";
import { collectStyleGuides, formatStyleBlock, collectStyleGuidesForOutput } from "../src/style";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = join(tmpdir(), `serf-style-test-${Date.now()}`);

describe("Style Guide Cascading", () => {
  test("collectStyleGuides returns empty when no STYLE.md exists", () => {
    mkdirSync(join(TEST_ROOT, "src"), { recursive: true });
    const guides = collectStyleGuides(join(TEST_ROOT, "src", "file.ts"), TEST_ROOT);
    expect(guides.length).toBe(0);
  });

  test("collectStyleGuides finds root STYLE.md", () => {
    writeFileSync(join(TEST_ROOT, "STYLE.md"), "Dark UI only. Monospace.");
    const guides = collectStyleGuides(join(TEST_ROOT, "src", "file.ts"), TEST_ROOT);
    expect(guides.length).toBe(1);
    expect(guides[0]).toContain("Dark UI only");
  });

  test("collectStyleGuides cascades from root to specific", () => {
    mkdirSync(join(TEST_ROOT, "src", "components"), { recursive: true });
    writeFileSync(join(TEST_ROOT, "STYLE.md"), "Root: dark UI.");
    writeFileSync(join(TEST_ROOT, "src", "STYLE.md"), "Src: no default exports.");
    writeFileSync(join(TEST_ROOT, "src", "components", "STYLE.md"), "Components: props over slots.");

    const guides = collectStyleGuides(join(TEST_ROOT, "src", "components", "Button.tsx"), TEST_ROOT);
    expect(guides.length).toBe(3);
    expect(guides[0]).toContain("Root: dark UI");
    expect(guides[1]).toContain("Src: no default exports");
    expect(guides[2]).toContain("Components: props over slots");
  });

  test("formatStyleBlock returns empty string for no guides", () => {
    expect(formatStyleBlock([])).toBe("");
  });

  test("formatStyleBlock includes style header when guides exist", () => {
    const block = formatStyleBlock(["# Style (.)\nDark UI."]);
    expect(block).toContain("STYLE GUIDE");
    expect(block).toContain("Dark UI.");
  });

  test("collectStyleGuidesForOutput extracts file path from output", () => {
    mkdirSync(join(TEST_ROOT, "src", "api"), { recursive: true });
    writeFileSync(join(TEST_ROOT, "src", "api", "STYLE.md"), "API: RESTful only.");
    const guides = collectStyleGuidesForOutput("Files changed: src/api/handler.ts\nDid the work.", TEST_ROOT);
    expect(guides.length).toBe(3);
    expect(guides[0]).toContain("Root: dark UI");
    expect(guides[2]).toContain("API: RESTful only");
  });

  test("collectStyleGuidesForOutput returns empty when no file path in output", () => {
    const guides = collectStyleGuidesForOutput("I did the work but didn't mention files.");
    expect(guides.length).toBe(0);
  });

  afterAll(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });
});