/**
 * Package-private helpers shared by Boundary's own modules through the
 * `#program/internal` import. Not exported to consumers: their behavior is an
 * implementation detail, not portable law.
 */
export { compareUtf8 } from "./json";
export { exactObject, snapshotJson } from "./snapshot";
export { compileSchema } from "./schema";
