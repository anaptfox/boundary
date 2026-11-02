import { Suspense } from "react";
import { cookies } from "next/headers";
import { SaveForm } from "./save-form";
import { demoContextFromCookie } from "../lib/context";
import { documentCaller } from "../lib/boundary";
import { Brand } from "./workspace-parts";
import { Icon } from "./icons";

export default function Page() {
  return <Suspense fallback={<main aria-busy="true"><Brand /><p>Opening the document room…</p></main>}><DocumentWorkspace /></Suspense>;
}

async function DocumentWorkspace() {
  const cookie = (await cookies()).get("boundary_demo_session")?.value ?? null;
  if (!cookie) {
    return (
      <main className="welcome">
        <div className="welcome-story"><Brand /><div className="welcome-copy"><div className="eyebrow">YOUR IDEAS, WITH ROOM TO GROW</div><h1>A good idea<br />starts with<br /><em>a little space.</em></h1><p>A considered place to write, revise, and see how the same document meets different people.</p><div className="welcome-stamp"><Icon name="document" /> ONE DOCUMENT. CLEAR BOUNDARIES.</div></div><span className="welcome-foot">BUILT WITH NEXT.JS, TIPTAP & BOUNDARY</span></div>
        <section className="welcome-entry"><div className="eyebrow">WELCOME TO FOLIO</div><h2>Take a seat.</h2><p>One shared document. Choose a perspective.<br />You can switch at any time.</p>
          <form action="/demo-session" method="post"><button className="session-card" name="session" value="alice"><span className="avatar alice">A</span><span><strong>Continue as Alice</strong><small>Write, format, and save revisions</small></span><span className="badge">Editor</span><Icon name="arrow" /></button></form>
          <form action="/demo-session" method="post"><button className="session-card" name="session" value="bob"><span className="avatar bob">B</span><span><strong>Look around as Bob</strong><small>Read the document, without changing it</small></span><span className="badge">Reader</span><Icon name="arrow" /></button></form>
          <div className="welcome-disclaimer"><Icon name="lock" /><p>These are local demo sessions—not production sign-in. Permission checks happen on the server, not just in the interface.</p></div>
        </section>
      </main>
    );
  }
  const context = demoContextFromCookie(`boundary_demo_session=${cookie}`);
  const boundary = documentCaller(() => context);
  const document = await boundary.read.get({ id: "doc-1" });
  const publicationView = await boundary.read.publicationStatus({ id: "doc-1" });
  return <SaveForm document={document} canEdit={context.canEdit} session={context.session} publicationView={publicationView} />;
}
