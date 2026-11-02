// Disposable subprocess fixture. No barrier or fault controls are reachable over HTTP.
import { startServer } from "./src/server";

const [database, mode, cli] = process.argv.slice(2);
if (!database) throw new Error("A disposable database path is required");

async function barrier(stage: string, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      process.off("message", message);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const message = (value: unknown) => { if (value === "release") finish(); };
    const abort = () => finish(new Error("Host stopped"));
    const timer = setTimeout(() => finish(new Error("Fixture barrier timed out")), 10_000);
    process.on("message", message);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else process.send?.({ type: "boundary", stage });
  });
}

const host = await startServer({
  database,
  port: 0,
  allowOriginlessCli: cli === "allow-cli",
  bot: {
    startDelayMs: 0,
    async beforeEffect(signal) {
      if (mode === "before") await barrier("before", signal);
      if (mode === "throw-before") throw new Error("Fixture preparation failure");
    },
    async afterEffect(signal) {
      if (mode === "after") await barrier("after", signal);
      if (mode === "throw-after") throw new Error("Fixture lost effect response");
      if (mode === "crash") process.kill(process.pid, "SIGKILL");
    },
  },
});
process.send?.({ type: "ready", origin: host.origin });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0), error => {
      console.error(error);
      process.exit(1);
    });
  });
}
