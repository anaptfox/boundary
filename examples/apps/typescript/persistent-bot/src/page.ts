import type { Snapshot } from "./storage";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

export function page(snapshot: Snapshot, notice = "") {
  const jobs = snapshot.tasks.map(task => {
    const canInterrupt = task.state === "queued" || task.state === "running";
    return `<article>
      <h3>${escape(task.goal)}</h3>
      <p>Status: <strong>${task.state}</strong>${task.effectState ? ` · Effect: ${task.effectState}` : ""}</p>
      ${canInterrupt ? `<form method="post" action="/tasks/${task.id}/interrupt"><button>Interrupt</button></form>` : ""}
      ${task.state === "uncertain" ? `<form method="post" action="/tasks/${task.id}/reconcile"><button>Reconcile saved result</button></form>` : ""}
      ${snapshot.progress.filter(item => item.taskId === task.id).map(item => `<p>${escape(item.body)}</p>`).join("")}
    </article>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Planner — persistent bot</title>
<style>
  body { font: 16px/1.5 system-ui; max-width: 850px; margin: 2rem auto; padding: 0 1rem; color: #172033; }
  section, article { border: 1px solid #ccd5e1; border-radius: 12px; padding: 1rem; margin: 1rem 0; overflow-wrap: anywhere; }
  button, input { font: inherit; padding: .45rem .7rem; }
  input { width: 100%; box-sizing: border-box; margin-bottom: .5rem; }
  form { display: inline; } .notice { background: #eef4ff; padding: 1rem; }
</style></head><body>
<h1>${escape(snapshot.bot.name)}</h1>
<p>Delegate one saved task draft. Planner continues while this host is running, even after you close the page.</p>
${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ""}
<section><h2>Delegate one bounded job</h2>
<form method="post" action="/delegate">
  <label for="goal">Task title</label><input id="goal" name="goal" maxlength="240" required>
  <input type="hidden" name="requestId" value="${crypto.randomUUID()}">
  <button>Delegate</button>
</form>
<p>One job creates one local draft. The queue starts after a short interruption window.</p></section>
<p><a href="/">Refresh saved progress</a> · Reconnecting never resubmits a job.</p>
<section><h2>Saved work</h2>${jobs || "<p>No delegations yet.</p>"}</section>
<section><h2>Human review</h2>
${snapshot.reviews.map(review => `<p>${escape(snapshot.tasks.find(task => task.id === review.taskId)?.goal ?? review.taskId)}: ${escape(review.body)}</p>`).join("") || "<p>No review is ready.</p>"}
<h3>Actual application drafts</h3>
${snapshot.applicationTasks.map(task => `<p>${escape(task.title)} <small>(${escape(task.id)})</small></p>`).join("") || "<p>None.</p>"}
</section>
<section><h2>Saved conversation</h2>${snapshot.conversations.map(message => `<p>${escape(message.body)}</p>`).join("") || "<p>No messages yet.</p>"}</section>
</body></html>`;
}
