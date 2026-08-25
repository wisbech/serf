import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSerfDir, ensureDir } from "./paths";
import type { Card } from "./board";

export function prdDir(): string {
  return join(getSerfDir(), "prds");
}

export function ensurePrdDir(): void {
  ensureDir(prdDir());
}

export function prdPath(cardId: string): string {
  return join(prdDir(), `${cardId}.md`);
}

export function prdExists(cardId: string): boolean {
  return existsSync(prdPath(cardId));
}

export function writePrd(cardId: string, content: string): void {
  ensurePrdDir();
  writeFileSync(prdPath(cardId), content);
}

export function readPrd(cardId: string): string | null {
  try {
    return readFileSync(prdPath(cardId), "utf-8");
  } catch {
    return null;
  }
}

export function createPrdStub(card: Card): string {
  const now = new Date().toISOString();
  const content = `---
card: ${card.id}
title: ${card.title}
phase: observe
progress: 0/0
started: ${now}
updated: ${now}
---

## Context

${card.context ?? ""}

## Criteria

${card.acceptance.map(a => `- [ ] ${a}`).join("\n")}

## Decisions

## Verification
`;
  writePrd(card.id, content);
  return content;
}

export function syncDecisionsToCard(card: Card, decisions: string[]): Card {
  card.decisions = decisions;
  card.updatedAt = new Date().toISOString();
  return card;
}

export function syncVerificationToCard(card: Card, verification: string[]): Card {
  card.verification = verification;
  card.updatedAt = new Date().toISOString();
  return card;
}