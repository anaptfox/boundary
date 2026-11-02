import assert from "node:assert/strict";
import { Window } from "happy-dom";

function forms(html, pageUrl) {
  const window = new Window();
  try {
    window.document.body.innerHTML = html;
    return [...window.document.querySelectorAll("form")].map((form) => ({
      text: form.textContent ?? "",
      target: new URL(form.getAttribute("action") || "", pageUrl),
      fields: [...form.querySelectorAll("input,textarea,select")]
        .map((
          field,
        ) => [field.getAttribute("name"), field.getAttribute("value") ?? ""])
        .filter(([name]) => name),
    }));
  } finally {
    window.close();
  }
}
function formFor(page, label) {
  const form = forms(page.html, page.url).find((value) =>
    value.text.includes(label)
  );
  assert(form, `missing form: ${label}`);
  return form;
}
function formInCandidate(page, candidateName, label) {
  const window = new Window();
  try {
    window.document.body.innerHTML = page.html;
    const article = [...window.document.querySelectorAll("article")].find((
      value,
    ) => value.textContent?.includes(candidateName));
    assert(article, `missing candidate: ${candidateName}`);
    const form = [...article.querySelectorAll("form")].find((value) =>
      value.textContent?.includes(label)
    );
    assert(form, `missing candidate form: ${label}`);
    return {
      text: form.textContent ?? "",
      target: new URL(form.getAttribute("action") || "", page.url),
      fields: [...form.querySelectorAll("input,textarea,select")]
        .map((
          field,
        ) => [field.getAttribute("name"), field.getAttribute("value") ?? ""])
        .filter(([name]) => name),
    };
  } finally {
    window.close();
  }
}
function candidateArticleText(page, candidateName) {
  const window = new Window();
  try {
    window.document.body.innerHTML = page.html;
    const article = [...window.document.querySelectorAll("article")].find((
      value,
    ) => value.textContent?.includes(candidateName));
    assert(article, `missing candidate: ${candidateName}`);
    return article.textContent ?? "";
  } finally {
    window.close();
  }
}
function cookie(response) {
  return response.headers.getSetCookie?.().map((value) =>
    value.split(";", 1)[0]
  ).join("; ") ?? response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}
async function page(base, headers, path) {
  const response = await fetch(new URL(path, base), { headers });
  assert(response.ok, `${path} returned ${response.status}`);
  return { html: await response.text(), url: response.url };
}
async function submit(form, headers, values = {}) {
  const body = new FormData();
  for (const [name, value] of form.fields) body.set(name, value);
  for (const [name, value] of Object.entries(values)) body.set(name, value);
  return fetch(form.target, {
    method: "POST",
    headers: { ...headers, origin: form.target.origin },
    body,
    redirect: "manual",
  });
}

/** Run against an already-built, isolated production Next server. */
export async function smoke(baseUrl) {
  const base = new URL(baseUrl);
  let triage = await page(base, {}, "/triage");
  const selected = await submit(formFor(triage, "Open Acme triage"), {}, {
    tenant: "acme",
  });
  assert.equal(selected.status, 303);
  const headers = { cookie: cookie(selected) };
  assert(headers.cookie, "tenant selection did not set a cookie");
  triage = await page(base, headers, "/triage");
  const title = `HTTP triage ${Date.now()}`;
  assert.equal(
    (await submit(formFor(triage, "Create ticket through Boundary"), headers, {
      title,
      customer: "Smoke customer",
    })).status,
    303,
  );
  triage = await page(base, headers, "/triage");
  assert(triage.html.includes(title), "created ticket was not persisted");
  assert.equal(
    (await submit(formFor(triage, "Delegate investigation"), headers, {
      agent: "runbook-reader",
    })).status,
    303,
  );
  triage = await page(base, headers, "/triage");
  assert(
    triage.html.includes("runbook-reader"),
    "bounded local investigator evidence was not rendered",
  );
  assert.equal(
    (await submit(formFor(triage, "Record exact review"), headers, {
      resolution:
        "Reviewed consequence: notify the customer and close this exact ticket.",
    })).status,
    303,
  );
  triage = await page(base, headers, "/triage");
  assert.equal(
    (await submit(formFor(triage, "Resolve from stored review"), headers))
      .status,
    303,
  );
  triage = await page(base, headers, "/triage");
  assert(
    triage.html.includes("Reviewed consequence"),
    "resolution did not consume stored review content",
  );
  let studio = await page(base, {}, "/studio");
  const candidate = `HTTP candidate ${Date.now()}`;
  assert.equal(
    (await submit(formFor(studio, "Create candidate through Boundary"), {}, {
      name: candidate,
      direction:
        "A clear persisted creative direction for this production HTTP smoke.",
    })).status,
    303,
  );
  studio = await page(base, {}, "/studio");
  assert(studio.html.includes(candidate), "candidate was not persisted");
  const editForm = formInCandidate(studio, candidate, "Save draft edit");
  const candidateId = editForm.fields.find(([name]) => name === "id")?.[1];
  assert(candidateId, "created candidate did not render its stored ID");
  const editedDirection =
    "An edited, persisted direction with a concrete comparison signal.";
  assert.equal(
    (await submit(editForm, {}, {
      direction: editedDirection,
    })).status,
    303,
  );
  studio = await page(base, {}, "/studio");
  assert(
    studio.html.includes(editedDirection),
    "candidate edit was not persisted",
  );
  const comparison = await page(
    base,
    {},
    `/studio?left=${encodeURIComponent(candidateId)}&right=candidate-current`,
  );
  assert(
    comparison.html.includes(`${candidate} emphasizes`) &&
      comparison.html.includes(editedDirection.slice(0, 54)),
    "compare interaction did not render this candidate's returned contrast",
  );
  assert.equal(
    (await submit(
      formInCandidate(studio, candidate, "Choose with local reviewer fixture"),
      {},
    )).status,
    303,
  );
  studio = await page(base, {}, "/studio");
  assert(
    candidateArticleText(studio, candidate).includes("chosen"),
    "created candidate choice was not persisted",
  );
}

const self = process.argv[1] &&
  new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (self) {
  const index = process.argv.indexOf("--base");
  if (index < 0) {
    throw new Error("usage: node tests/process/document-workspace-domains.mjs --base URL");
  }
  await smoke(process.argv[index + 1]);
}
