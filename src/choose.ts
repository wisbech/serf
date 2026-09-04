import { readFileSync } from "node:fs";

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export async function choose<T>(question: string, choices: Choice<T>[]): Promise<T> {
  if (choices.length === 0) throw new Error("no choices");
  if (choices.length === 1) return choices[0].value;
  if (!process.stdin.isTTY) return choices[0].value;

  let selected = 0;

  const render = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`  ${question}\n\n`);
    choices.forEach((c, i) => {
      const marker = i === selected ? "\x1b[1;36m▶\x1b[0m" : "  ";
      const label = i === selected ? `\x1b[1;37m${c.label}\x1b[0m` : c.label;
      const hint = c.hint ? `  \x1b[90m${c.hint}\x1b[0m` : "";
      process.stdout.write(`  ${marker} ${label}${hint}\n`);
    });
    process.stdout.write(`\n  \x1b[90m↑/↓ to move, Enter to select\x1b[0m\n`);
  };

  return new Promise<T>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    render();

    const onData = (key: string) => {
      if (key === "\u001b[A") {
        selected = (selected - 1 + choices.length) % choices.length;
        render();
      } else if (key === "\u001b[B") {
        selected = (selected + 1) % choices.length;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(choices[selected].value);
      } else if (key === "\u0003") {
        cleanup();
        process.exit(0);
      }
    };

    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\x1b[2J\x1b[H");
    };

    stdin.on("data", onData);
  });
}
