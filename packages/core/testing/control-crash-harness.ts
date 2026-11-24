import type { MemoryJournal, TestClock } from "@foxworth/boundary/control/testing";

export type ControlCrashPoint = "after-attempt" | "after-apply" | "after-verify";
export type ControlCrashCaseReport = Readonly<{ point: ControlCrashPoint; recovered: boolean; sideEffects: number; terminal: boolean; message?: string }>;
export type ControlCrashMatrixReport = Readonly<{ ok: boolean; cases: readonly ControlCrashCaseReport[] }>;

/** Adapter seam keeps the crash contract testable with the caller's real Control setup. */
export async function verifyControlCrashRecovery(options: {
  journal: MemoryJournal; clock: TestClock; points?: readonly ControlCrashPoint[];
  run: (point: ControlCrashPoint, crash: () => never, clock: TestClock, journal: MemoryJournal) => Promise<{ reconcile(): Promise<unknown>; sideEffects(): number; terminal(): Promise<boolean> }>;
  leaseMilliseconds?: number;
}): Promise<ControlCrashMatrixReport> {
  const cases: ControlCrashCaseReport[] = [];
  for (const point of options.points ?? ["after-attempt", "after-apply", "after-verify"]) {
    const crash = (): never => { throw new Error(`injected control crash: ${point}`); };
    try {
      const setup = await options.run(point, crash, options.clock, options.journal);
      // The setup owns the precise boundary at which it invokes `crash`.
      // It catches that injected interruption and returns its recovery handle.
      options.clock.advance(options.leaseMilliseconds ?? 60_000);
      await setup.reconcile();
      const terminal = await setup.terminal();
      cases.push(Object.freeze({ point, recovered: true, sideEffects: setup.sideEffects(), terminal }));
    } catch (error) {
      cases.push(Object.freeze({ point, recovered: false, sideEffects: 0, terminal: false, message: error instanceof Error ? error.message : "recovery failed" }));
    }
  }
  return Object.freeze({ ok: cases.length > 0 && cases.every((x) => x.recovered && x.terminal && x.sideEffects <= 1), cases: Object.freeze(cases) });
}
