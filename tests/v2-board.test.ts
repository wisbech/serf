import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { addTask, readCard, moveCard, listCards, writeCard, setFeedback, deleteCard } from "../src/v2/board";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), `serf-test-${Date.now()}`);

beforeEach(() => {
  process.env.SERF_HOME = TMP;
  mkdirSync(join(TMP, "board", "backlog"), { recursive: true });
  mkdirSync(join(TMP, "board", "in-progress"), { recursive: true });
  mkdirSync(join(TMP, "board", "review"), { recursive: true });
  mkdirSync(join(TMP, "board", "done"), { recursive: true });
});

afterEach(() => {
  delete process.env.SERF_HOME;
  rmSync(TMP, { recursive: true, force: true });
});

describe("Board", () => {
  test("addTask creates a card in backlog", () => {
    const card = addTask("Test task", "Do something", ["quality check"]);
    expect(card.column).toBe("backlog");
    expect(card.title).toBe("Test task");
    expect(card.task).toBe("Do something");
    expect(card.acceptance).toContain("quality check");

    const read = readCard(card.id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Test task");
  });

  test("moveCard moves between columns", () => {
    const card = addTask("Move test");
    expect(card.column).toBe("backlog");

    const moved = moveCard(card.id, "in-progress");
    expect(moved).not.toBeNull();
    expect(moved!.column).toBe("in-progress");

    const read = readCard(card.id);
    expect(read!.column).toBe("in-progress");
  });

  test("listCards returns all cards", () => {
    addTask("List test 1");
    addTask("List test 2");

    const all = listCards();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("listCards filters by column", () => {
    const c1 = addTask("Filter test 1");
    const c2 = addTask("Filter test 2");
    moveCard(c1.id, "in-progress");

    const inProgress = listCards("in-progress");
    expect(inProgress.some(c => c.id === c1.id)).toBe(true);
    expect(inProgress.some(c => c.id === c2.id)).toBe(false);
  });

  test("writeCard updates context and quality", () => {
    const card = addTask("Update test");
    card.context = "some context from previous work";
    card.quality = 0.85;
    writeCard(card);

    const read = readCard(card.id);
    expect(read!.context).toBe("some context from previous work");
    expect(read!.quality).toBe(0.85);
  });

  test("setFeedback records accept/refine", () => {
    const card = addTask("Feedback test");
    moveCard(card.id, "done");
    const updated = setFeedback(card.id, "accept");
    expect(updated!.feedback).toBe("accept");
  });

  test("deleteCard removes the card", () => {
    const card = addTask("Delete test");
    expect(deleteCard(card.id)).toBe(true);
    expect(readCard(card.id)).toBeNull();
  });

  test("readCard returns null for unknown id", () => {
    expect(readCard("nonexistent")).toBeNull();
  });

  test("moveCard returns null for unknown id", () => {
    expect(moveCard("nonexistent", "done")).toBeNull();
  });
});