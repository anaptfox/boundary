import { localModel } from "./agent";
import { startRoomServer } from "./server";
const server = await startRoomServer({ model: localModel() });
console.log(`Todo room: http://127.0.0.1:${server.port} (${process.env.BOUNDARY_ROOM_MODEL ?? "deterministic fixture"})`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
