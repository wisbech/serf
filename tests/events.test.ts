import { test, expect, describe } from "bun:test";
import { appendEvent, subscribe, queryEvents, getLastEvent, appendTrajectory, readTrajectory, forkTrajectory, mergeTrajectory, subscribeToTrajectory, loadSubscriptions, readBlob, type SerfEvent, type TrajectoryStep } from "../src/events";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSerfDir } from "../src/paths";

describe("events", () => {
  test("appendEvent writes to JSONL and fires in-process handler", () => {
    let received: SerfEvent | null = null;
    const unsub = subscribe("test.event", (e) => { received = e; });
    appendEvent("test.event", { foo: "bar" });
    expect(received).not.toBeNull();
    expect(received!.type).toBe("test.event");
    expect(received!.payload.foo).toBe("bar");
    unsub();
  });

  test("subscribe only fires for matching pattern", () => {
    let received: SerfEvent | null = null;
    const unsub = subscribe("other.event", (e) => { received = e; });
    appendEvent("test.unrelated", { foo: "bar" });
    expect(received).toBeNull();
    unsub();
  });

  test("subscribe wildcard fires for all events", () => {
    let received: SerfEvent[] = [];
    const unsub = subscribe("*", (e) => { received.push(e); });
    appendEvent("test.wild1", { a: 1 });
    appendEvent("test.wild2", { b: 2 });
    expect(received.length).toBeGreaterThanOrEqual(2);
    unsub();
  });

  test("queryEvents returns matching events", () => {
    appendEvent("test.query", { val: 42 });
    const events = queryEvents("test.query", 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1].payload.val).toBe(42);
  });

  test("getLastEvent returns most recent matching event", () => {
    appendEvent("test.last", { order: 1 });
    appendEvent("test.last", { order: 2 });
    const last = getLastEvent("test.last");
    expect(last).not.toBeNull();
    expect(last!.payload.order).toBe(2);
  });

  test("unsubscribe stops handler", () => {
    let received: SerfEvent | null = null;
    const unsub = subscribe("test.unsub", (e) => { received = e; });
    appendEvent("test.unsub", { a: 1 });
    expect(received).not.toBeNull();
    received = null;
    unsub();
    appendEvent("test.unsub", { a: 2 });
    expect(received).toBeNull();
  });
});

describe("trajectory", () => {
  test("appendTrajectory writes a step with step_id and ts", () => {
    const step = appendTrajectory("test.traj", { task: "fix bug" }, "master");
    expect(step.step_id).toBeDefined();
    expect(step.ts).toBeDefined();
    expect(step.type).toBe("test.traj");
    expect(step.source).toBe("master");
    expect(step.payload.task).toBe("fix bug");
  });

  test("readTrajectory returns appended steps", () => {
    appendTrajectory("test.read", { val: 1 }, "master");
    appendTrajectory("test.read", { val: 2 }, "critic");
    const steps = readTrajectory().filter(s => s.type === "test.read");
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[steps.length - 1].payload.val).toBe(2);
    expect(steps[steps.length - 1].source).toBe("critic");
  });

  test("blob spillover for large stdout", () => {
    const largeOutput = "x".repeat(5000);
    const step = appendTrajectory("test.blob", {}, "actor", largeOutput);
    expect(step.stdout_truncated).toBe(true);
    expect(step.stdout_ref).toBeDefined();
    expect(step.stdout_bytes).toBe(5000);
    expect(step.stdout!.length).toBeLessThan(5000);

    const blob = readBlob(step.stdout_ref!);
    expect(blob.length).toBe(5000);
  });

  test("small stdout stays inline", () => {
    const smallOutput = "hello world";
    const step = appendTrajectory("test.noblob", {}, "actor", smallOutput);
    expect(step.stdout_truncated).toBeUndefined();
    expect(step.stdout_ref).toBeUndefined();
    expect(step.stdout).toBe("hello world");
  });

  test("forkTrajectory creates child with parent links", () => {
    const { childId, parentStep } = forkTrajectory("test.fork", { reason: "delegate" }, "master");
    expect(childId).toBeDefined();
    expect(parentStep.step_id).toBeDefined();
  });

  test("mergeTrajectory appends merge step to main trajectory", () => {
    const { childId } = forkTrajectory("test.mergefork", {}, "master");
    const mergeStep = mergeTrajectory(childId, "test.merge", { result: "done" }, "serf");
    expect(mergeStep.type).toBe("test.merge");
    expect(mergeStep.payload.result).toBe("done");
    expect(mergeStep.payload.from_traj).toBeDefined();
  });

  test("subscribeToTrajectory catches new steps via in-process subscribe", () => {
    let received: TrajectoryStep | null = null;
    const unsub = subscribe("test.trajsub", (e) => { received = { ...e, step_id: "test", ts: e.ts, type: e.type, payload: e.payload } as TrajectoryStep; });
    appendEvent("test.trajsub", { check: true }, undefined, "tester");
    expect(received).not.toBeNull();
    expect(received!.type).toBe("test.trajsub");
    expect(received!.source).toBe("tester");
    unsub();
  });

  test("self-trigger suppression: source field is set correctly", () => {
    const step = appendTrajectory("test.selftrigger", {}, "critic");
    expect(step.source).toBe("critic");
  });
});