import * as Automerge from "@automerge/automerge";
import * as Y from "yjs";
import { captureAutomerge } from "@foxworth/boundary/automerge";
import { captureYjs } from "@foxworth/boundary/yjs";

const yDoc = new Y.Doc();
const yCapture = captureYjs(yDoc);
const yProjection = yCapture.read((doc) => ({
  size: doc.getArray("items").length,
  title: String(doc.getMap("scene").get("title") ?? ""),
}));
void yProjection.then((projection) => {
  const size: number = projection.size;
  const title: unknown = projection.title;
  // @ts-expect-error projection keys come from the projector
  projection.missing;
  void size;
  void title;
});

const automergeDoc = Automerge.from({ items: [{ id: "orb", label: "Orb" }] });
const automergeCapture = captureAutomerge(automergeDoc);
const automergeProjection = automergeCapture.read((doc) => ({
  itemId: doc.items[0]!.id,
  label: doc.items[0]!.label,
}));
void automergeProjection.then((projection) => {
  const id: string = projection.itemId;
  const label: string = projection.label;
  // @ts-expect-error projection keys come from the projector
  projection.missing;
  void id;
  void label;
});

const encoded: Uint8Array = yCapture.encode();
const heads: readonly string[] = automergeCapture.heads;
// @ts-expect-error Automerge heads are an immutable capture marker
automergeCapture.heads.push("mutable");
void encoded;
void heads;
