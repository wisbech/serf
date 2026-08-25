import { test, expect, describe } from "bun:test";
import {
  createCardBudget,
  trackPhaseUsage,
  isPhaseOverBudget,
  getPhaseRemaining,
  getTotalUsage,
  getTotalRemaining,
  formatBudget,
  assertPhaseBudget,
} from "../src/budget";

describe("Budget", () => {
  test("creates phase budgets with default split", () => {
    const b = createCardBudget(10000);
    expect(b.totalLimit).toBe(10000);
    expect(b.phases.triage.limit).toBe(500);
    expect(b.phases.plan.limit).toBe(1500);
    expect(b.phases.execution.limit).toBe(6000);
    expect(b.phases.critic.limit).toBe(2000);
  });

  test("tracks phase usage", () => {
    const b = createCardBudget(10000);
    trackPhaseUsage(b, "triage", 300);
    expect(b.phases.triage.used).toBe(300);
    expect(getPhaseRemaining(b, "triage")).toBe(200);
  });

  test("detects phase over budget", () => {
    const b = createCardBudget(10000);
    trackPhaseUsage(b, "triage", 600);
    expect(isPhaseOverBudget(b, "triage")).toBe(true);
  });

  test("total usage sums all phases", () => {
    const b = createCardBudget(10000);
    trackPhaseUsage(b, "triage", 100);
    trackPhaseUsage(b, "plan", 200);
    trackPhaseUsage(b, "execution", 300);
    expect(getTotalUsage(b)).toBe(600);
    expect(getTotalRemaining(b)).toBe(9400);
  });

  test("assertPhaseBudget rejects overruns", () => {
    const b = createCardBudget(10000);
    trackPhaseUsage(b, "triage", 500);
    const check = assertPhaseBudget(b, "triage", 1);
    expect(check.ok).toBe(false);
  });

  test("formatBudget renders all phases", () => {
    const b = createCardBudget(10000);
    trackPhaseUsage(b, "triage", 100);
    const text = formatBudget(b);
    expect(text).toContain("triage");
    expect(text).toContain("100");
    expect(text).toContain("total");
  });
});
