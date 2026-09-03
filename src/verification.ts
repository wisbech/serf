export interface VerificationResult {
  present: boolean;
  command?: string;
  exitCode?: number;
  output?: string;
  filesChanged?: string[];
}

export function parseVerification(output: string): VerificationResult {
  const result: VerificationResult = { present: false };

  const cmdMatch = output.match(/VERIFICATION_COMMAND:\s*(.+)/i);
  if (cmdMatch) result.command = cmdMatch[1].trim();

  const exitMatch = output.match(/VERIFICATION_EXIT_CODE:\s*(\d+)/i);
  if (exitMatch) result.exitCode = parseInt(exitMatch[1], 10);

  const outMatch = output.match(/VERIFICATION_OUTPUT:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (outMatch) result.output = outMatch[1].trim();

  const filesMatch = output.match(/FILES_CHANGED:\s*([\s\S]*?)(?=\n[A-Z_]+:|\nSERF_TASK_DONE|$)/i);
  if (filesMatch) {
    result.filesChanged = filesMatch[1]
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  }

  result.present = result.command !== undefined || result.exitCode !== undefined;
  return result;
}

export function isVerificationGreen(v: VerificationResult): boolean {
  return v.present && v.exitCode === 0;
}

export function formatVerificationFeedback(v: VerificationResult): string {
  if (!v.present) {
    return "No verification was reported. You must run a verification command (test, build, lint, or typecheck) and report its result.";
  }
  const lines: string[] = [];
  if (v.command) lines.push(`Verification command: ${v.command}`);
  if (v.exitCode !== undefined) lines.push(`Exit code: ${v.exitCode}`);
  if (v.output) lines.push(`Output:\n${v.output.slice(0, 1000)}`);
  return lines.join("\n");
}
