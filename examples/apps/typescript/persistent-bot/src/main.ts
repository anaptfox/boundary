import { startServer } from "./server";

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const host = await startServer({
  port: Number(argument("--port", "4319")),
  database: argument("--db", "./data/persistent-bot.sqlite"),
  allowOriginlessCli: process.argv.includes("--allow-originless-cli"),
  bot: process.argv.includes("--crash-after-apply") ? {
    async afterEffect() { process.kill(process.pid, "SIGKILL"); },
  } : undefined,
});
console.log(`persistent-bot listening on ${host.origin}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0), error => {
      console.error("Host cleanup failed", error);
      process.exit(1);
    });
  });
}
