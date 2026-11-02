import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { normalizePublicProposal } from "@foxworth/boundary/control";
import { contributeControlRequests } from "@foxworth/boundary/control/host";
import { bindSurface, compileInteractions, implementInteractions, installInteractions, type InteractionInstallation, projectInteractions } from "@foxworth/boundary/pipeline";
import { defineInteraction } from "@foxworth/boundary";
import {
  createPublicationControl,
  Published,
  PublishInput,
} from "../../../examples/apps/typescript/document-workspace/lib/publication";
import type { DemoContext } from "../../../examples/apps/typescript/document-workspace/lib/context";

export const alice: DemoContext = {
  session: "alice",
  documentId: "doc-1",
  canEdit: true,
};
export const editor: DemoContext = {
  session: "alice",
  documentId: "doc-1",
  canEdit: true,
  assistantAgent: "editor",
};
export const foreignWorkspace: DemoContext = {
  session: "alice",
  documentId: "doc-1",
  canEdit: true,
  delegation: {
    executor: "editor",
    delegator: "alice",
    workspace: "elsewhere",
    mayDraft: true,
  },
};

type Document = z.infer<typeof Published> & { id: "doc-1" };
export const publishedPreview = Object.freeze({
  revision: 7,
  title: "Durable review",
  body: "A saved draft.",
  richText:
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A saved draft."}]}]}',
});
const initialDocument: Document = { id: "doc-1", ...publishedPreview };
const definitions = {
  publish: defineInteraction({
    id: "documents.publish",
    input: PublishInput,
    output: Published,
    reads: ["documents"],
    changes: ["publications"],
    description:
      "Request an exact human review; direct publication is unavailable.",
  }),
} as const;

export type PublicationFixture = Awaited<
  ReturnType<typeof createPublicationFixture>
>;

export async function createPublicationFixture(options: {
  database?: string;
  document?: Document;
  now?: () => number;
  afterEffect?: () => void;
} = {}) {
  const directory = options.database
    ? undefined
    : mkdtempSync(join(tmpdir(), "boundary-next-publication-"));
  const database = options.database ?? join(directory!, "publication.sqlite");
  let document = options.document ?? initialDocument;
  const compiled = await compileInteractions(definitions);
  let installation: InteractionInstallation<DemoContext>;
  const publication = await createPublicationControl({
    interaction: compiled.handles.publish,
    installation: () => installation,
    readDocument: async () => document,
    database,
    sourceRoot: resolve("examples/apps/typescript/document-workspace"),
    now: options.now,
    afterEffect: options.afterEffect,
  });
  const implementations = implementInteractions<typeof definitions, DemoContext>(
    definitions,
    {
      publish() {
        throw new Error("publication has no direct realization");
      },
    },
  );
  const installed = await installInteractions<typeof definitions, DemoContext>(
    compiled,
    {
      installationId: "next-publication-sidecar:v1",
      implementations,
      requests: contributeControlRequests(compiled, publication.requester, {
        publish: {
          interaction: compiled.handles.publish,
          control: publication.control,
          executionRealizationId: "folio:publish:execute:1",
          actor: (context) => ({
            id: context.assistantAgent
              ? `${context.assistantAgent}:for:${context.session}`
              : context.session,
            human: context.session === "alice" && !context.assistantAgent &&
              !context.delegation,
            workspace: context.delegation?.workspace ?? "folio",
          }),
        },
      }),
      realizationIds: {
        publish: {
          direct: "folio:publish:disabled",
          request: "folio:publish:request:1",
        },
      },
    },
  );
  installation = installed.installation;
  const projection = await projectInteractions(compiled, {
    publish: { interaction: compiled.handles.publish, modes: ["request"] },
  });
  const bound = await bindSurface(projection, installation, {
    admit: ({ context }) =>
      context.delegation?.workspace && context.delegation.workspace !== "folio"
        ? {
          decision: "deny",
          reason: "document is outside delegated workspace",
        }
        : { decision: "allow" },
  });
  if (bound.status !== "bound") {
    throw new Error("publication sidecar binding did not realize");
  }
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    publication.close();
  };
  return {
    database,
    compiled,
    installation,
    publication,
    document: () => document,
    replaceDocument(value: Document) {
      document = value;
    },
    async request(context: DemoContext, expectedRevision = document.revision) {
      const proposed = await bound.binding.connect().request(
        projection.handles.publish,
        { id: "doc-1", expectedRevision },
        context,
      );
      return normalizePublicProposal(
        proposed,
        "next-publication fixture proposal",
      );
    },
    release,
    close() {
      release();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}
