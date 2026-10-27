import { describe, expect, it } from "vitest";
import { runTestset } from "../src/testset.ts";

describe("synthetic test set (content/halden/testset)", () => {
  it("every case agrees with the composed rulebook: check statuses, submittability and routing", async () => {
    const { results, passed, total } = await runTestset();
    const failing = results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.mismatches.map((m) => `${m.ruleId} expected ${m.expected} got ${m.actual}`).join("; ")} submittable ${r.submittable.actual}/${r.submittable.expected} group ${r.reviewingGroup.actual}/${r.reviewingGroup.expected}`);
    expect(failing).toEqual([]);
    expect(total).toBe(46);
    expect(passed).toBe(46);
  });
});
