import { BusClient } from "@foxworth/boundary/bus";
import { createReachRecord } from "@foxworth/boundary/reach";

/** Register a Reach record. The bus is an address book, not a grant. */
export async function announce(socket: string, bindingDigest: string) {
  // #region reach-register
  const record = await createReachRecord(bindingDigest, "deploy:docs:1", [
    { kind: "http", url: "http://127.0.0.1:8080/boundary/v1" },
  ]);
  const bus = await BusClient.connect(socket);
  await bus.register(record);
  const listed = await bus.list();
  bus.close();
  return listed.length;
  // #endregion reach-register
}
