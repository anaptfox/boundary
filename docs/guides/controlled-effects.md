---
title: "Controlled effects"
description: "Separate proposing an action from executing it—and handle uncertain outcomes honestly when networks or processes fail."
---

# Controlled effects

For most actions, calling a function and getting a value back is enough. Keep those on Boundary's direct path.

Now think about publishing a release, charging a card, or deleting customer data. Two things break on the direct path:
1. **You want someone (or an AI assistant) to *propose* the action without the authority to *execute* it.**
2. **A network drop mid-execution leaves you in the dark:**

```text
apply starts ──▶ external system changes ──▶ connection disappears
                                                  │
                                         did it happen or not?
```

Reporting **failure** invites someone to click retry and charge twice. Reporting **success** invents evidence you don't have. **Control** solves both by separating *request* from *execution* and giving uncertainty a first-class durable state:

```text
request ──▶ approve ──▶ grant ──▶ attempt ──▶ apply ──▶ verify ──▶ receipt
                                                 │
                                             uncertain ──▶ reconcile
```

*(Control lives in `@foxworth/boundary/control` and its host bridge `@foxworth/boundary/control/host`. Direct-only apps never import it.)*

## 1. Expose `request` mode without execution authority

Select `"request"` mode on a caller's Projection—even before any Control implementation is installed:

```ts
const operatorProjection = compiled.project({
  publish: {
    interaction: compiled.handles.publish,
    modes: ["request"],
  },
});
```

Install the request capability through `@foxworth/boundary/control/host` alongside any direct realizations:

```ts
import { installInteractions, realizeDirect, realizeRequest } from "@foxworth/boundary";
import { contributeControlRequests } from "@foxworth/boundary/control/host";

const publishRequest = contributeControlRequests(compiled, controlRequester, {
  publish: {
    interaction: compiled.handles.publish,
    control: publishControl,
    executionRealizationId: publishExecutionRealizationId,
    actor: (context) => context.actor,
  },
});

const { installation, controller: installationController } = installInteractions(compiled, {
  installationId,
  realizations: {
    publish: {
      direct: realizeDirect(directPublishHandler, publishDirectRealizationId),
      request: realizeRequest(publishRequest, publishRequestRealizationId),
    },
  },
});
```

This bridge can **only** create proposals—it has no power to approve, grant, execute, verify, or reconcile. If a Projection asks for `"request"` mode and the Installation lacks it, `bindProjection` fails atomically as `unrealized`.

Calling `request` validates, runs admission, plans a public preview, checks Control request policy, and persists a proposal—never executing the side effect:

```ts
const caller = binding.connect();
const proposal = await caller.request(
  operatorProjection.handles.publish,
  { releaseId },
  requestContext,
);
```

```text
validate ──▶ admission ──▶ plan ──▶ Control request policy ──▶ persist proposal
```

## 2. Supply four honest application hooks

Your application owns the domain work behind four hooks on each controlled target:

- **`plan`** — derive subject, baseline, declared effects, private recovery state, and a safe public preview *without* performing the effect.
- **`apply`** — perform the reviewed work while holding an exclusive attempt lease.
- **`verify`** — check configured application evidence to establish completion.
- **`reconcile`** — inspect reality after an `uncertain` outcome *without* rerunning `apply`.

Boundary hashes these contracts together with your packaged `realizationDigest` into `controlDigest` (never hashing function source). Keep raw inputs, baselines, and recovery state private; only designated subjects, summaries, and previews cross the review seam.

## 3. Keep observation and administration separate

Control splits capabilities cleanly so no single caller gets unchecked power:

- **Request-capable Caller:** creates proposals only.
- **`ControlReader`:** inspects proposals, status, and receipts—cannot approve or execute.
- **`ControlAdmin`:** approves, grants, executes, and reconciles—does not implicitly grant broad read access.

```ts
const reader: ControlReader = controlReader;
const admin: ControlAdmin<Actor, ExecutionContext> = controlAdmin;

await admin.approve(proposal, reviewer);
const grant = await admin.grant(proposal, owner);
const result = await admin.execute(grant, executor, executionContext);
```

Your application supplies the durable journal (with atomic creation and compare-and-swap attempts), clock, policy, and lease storage. The `MemoryJournal` in `@foxworth/boundary/testing` is for tests only. Ephemeral contexts (`requestContext`, `executionContext`) are never persisted into proposals, grants, attempts, or receipts.

### Delegation is not a grant

Letting an AI agent edit drafts inside a workspace is task-level host policy, not a blanket grant to publish or delete. Keep the agent executor and human delegator distinct in your trusted server context. Even if a UI offers one **"Approve and publish"** button, the server still executes distinct `approve` → `grant` → `execute` steps—never shipping `ControlAdmin` to the browser or agent. See [Humans and agents](./humans-and-agents.md).

## 4. Handle all three durable outcomes

```ts
switch (result.status) {
  case "completed":
    return result.value;
  case "not-applied":
    return explain(result.reason);
  case "uncertain":
    return queueReconciliation(result.attempt);
}
```

- **`completed`:** `apply` returned, output validated, `verify` passed, and a receipt persisted.
- **`not-applied`:** proven not to have happened.
- **`uncertain`:** the effect may have started; **never** disguise it as failure or blindly retry.

Once the attempt lease expires, reconcile against reality without rerunning `apply`:

```ts
if (result.status === "uncertain") {
  const recovered = await admin.reconcile(
    result.attempt,
    executor,
    executionContext,
  );
  if (recovered.status === "completed") return recovered.value;
}
```

In TypeScript, `AttemptRef<Output>` preserves the grant's exact output type across repeated reconciliations (if you serialize only a raw attempt ID to disk, validate the recovered output again on reload).

---

**Next:** Read the [Control foundation reference](../reference/control.md) for record formats and state-machine laws.
