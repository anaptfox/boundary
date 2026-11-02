import { SqliteJournal } from "../../../examples/concepts/typescript/control-durable/sqliteJournal";
import { documentHost } from "../../../examples/concepts/typescript/control-durable/documentHost";
const [path, boundary, grantId] = process.argv.slice(2);
const journal = new SqliteJournal(path!);
const crash = () => { process.kill(process.pid, "SIGKILL"); };
if (boundary === "attempt") {
  const create = journal.createAttempt.bind(journal);
  journal.createAttempt = async (record) => { const result = await create(record); crash(); return result; };
}
if (boundary === "receipt") {
  const create = journal.createReceipt.bind(journal);
  journal.createReceipt = async (record) => { const result = await create(record); crash(); return result; };
}
const host = documentHost(journal, () => 100, { afterEffect: boundary === "effect" ? crash : undefined });
await host.capabilities.admin.execute(grantId!, "executor", undefined);
throw new Error("configured crash boundary was not reached");
