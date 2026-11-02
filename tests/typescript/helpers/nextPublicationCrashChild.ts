import { createPublicationFixture, alice } from "./nextPublicationFixture";

const [database, proposalId, proposalDigest] = process.argv.slice(2);
if (!database || !proposalId || !proposalDigest) throw new Error("expected database, proposal id, and digest");
const fixture = await createPublicationFixture({
  database,
  now: () => 100,
  afterEffect() { process.kill(process.pid, "SIGKILL"); },
});
try {
  await fixture.publication.review(proposalId, proposalDigest, alice);
} finally {
  fixture.publication.close();
}
