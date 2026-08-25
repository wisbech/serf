import { test, expect, describe } from "bun:test";
import { appendEvent, subscribe, queryEvents, getLastEvent, type SerfEvent } from "../src/events";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
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