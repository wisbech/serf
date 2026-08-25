import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export function collectStyleGuides(filePath: string, projectRoot?: string): string[] {
  const guides: string[] = [];
  const root = projectRoot ? resolve(projectRoot) : process.cwd();
  let dir = dirname(resolve(filePath));

  const collected: { dir: string; content: string }[] = [];
  while (dir.startsWith(root) || dir === root) {
    const stylePath = join(dir, "STYLE.md");
    if (existsSync(stylePath)) {
      try {
        const content = readFileSync(stylePath, "utf-8").trim();
        if (content.length > 0) {
          const relDir = dir === root ? "." : dir.replace(root + "/", "");
          collected.push({ dir: relDir, content });
        }
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  collected.reverse();
  for (const { dir, content } of collected) {
    guides.push(`# Style (${dir})\n${content}`);
  }

  return guides;
}

export function formatStyleBlock(guides: string[]): string {
  if (guides.length === 0) return "";
  return `\nSTYLE GUIDE (evaluate output against these in addition to acceptance criteria):\n${guides.join("\n\n")}\n\nIf the output violates the style guide, note the specific violation in your reasoning.\n`;
}

export function collectStyleGuidesForOutput(output: string, projectRoot?: string): string[] {
  const fileMatch = output.match(/(?:Files? changed|Modified|Created|Edited)[:\s]+([^\n]+)/i);
  if (!fileMatch) return [];
  const filePath = fileMatch[1].trim().split(/\s+/)[0].replace(/['"`]/g, "");
  if (!filePath) return [];
  const resolved = filePath.startsWith("/") ? filePath : join(projectRoot ?? process.cwd(), filePath);
  return collectStyleGuides(resolved, projectRoot);
}