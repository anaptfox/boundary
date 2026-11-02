import "./helpers/folio-environment";
import { expect, it, vi } from "vitest";
import { DocumentRoom } from "../../examples/apps/typescript/document-workspace/lib/room-store";
import { documentRoomDriver } from "../../examples/apps/typescript/document-workspace/lib/room-driver";
import { localModels } from "../../examples/apps/typescript/document-workspace/lib/ollama";

vi.mock("../../examples/apps/typescript/document-workspace/lib/documents", async (original) => ({
  ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/documents")>(),
  readDocument: async () => ({ id: "doc-1", title: "Launch brief", revision: 10,
    body: "## AudienceInternal team## ObjectiveApprove the launch checklist.## Key Actions1. **Review API**: Check the API.2. **Approve**: Approve the checklist.## Next Steps- [ ] Review (Due: Oct 15)## Contact InfoLead: alice@example.com",
  }),
  saveDocument: () => { throw new Error("Live formatting proof must not save"); },
}));
vi.mock("../../examples/apps/typescript/document-workspace/lib/activity", async (original) => ({ ...await original<typeof import("../../examples/apps/typescript/document-workspace/lib/activity")>(), recordActivity: vi.fn(), recordObservation: vi.fn() }));

it.skipIf(process.env.BOUNDARY_MARKDOWN_LIVE !== "1")("prepares an editable formatting proposal through real Ollama without writing live data", async () => {
  const model = (await localModels()).defaultModel!;
  const room = await DocumentRoom.open({ read: async () => undefined, write: async () => {} });
  await room.submit({ session: "alice", canEdit: true, documentId: "doc-1" }, {
    id: "live-formatting", model, allowSave: false,
    text: "Editor, prepare a formatting-only repair of the current saved document. Preserve the title, every word, date, risk and contact. Restore headings, paragraphs and lists from the collapsed Markdown. Omit the duplicate title from the body. Preserve unchecked tasks as ordinary bullets containing a literal ☐. Put email addresses in inline code. No new content or decisions. Draft now for Scout to review and offer Apply; do not save.",
  });
  const driver = documentRoomDriver(() => { throw new Error("Must not save"); });
  let failure: unknown;
  await room.work(async (turn) => { try { await driver(turn); } catch (error) { failure = error; throw error; } });
  if (failure) throw failure;
  const proposal = room.snapshot().messages.findLast((message) => message.draft)?.draft;
  expect(proposal?.richText).toContain('"type":"heading"');
  // Review can ask for direction; model judgment is not an approval guarantee.
  const question = room.snapshot().messages.findLast((message) => message.question?.state === "pending")?.question;
  expect(question?.work.draft?.id).toBe(proposal?.id);
}, 120000);
