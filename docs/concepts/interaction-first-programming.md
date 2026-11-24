---
title: "Interaction-first programming"
description: "Why separating what an action promises from the code that runs it unlocks checked interfaces, plans, and safe agents."
---

# Interaction-first programming

What should stay fixed when how an application is used—or where its work runs—changes?

Start with something tiny: an image editor. A person picks a photo, chooses a maximum width, and clicks **Make thumbnail**.

```text
button ──▶ makeThumbnail(imageId, maxWidth) ──▶ thumbnail
```

An ordinary function handles this effortlessly. It takes an image ID and a width, resizes the image, and returns the thumbnail ID and dimensions.

## Step 1: Add a second caller

A nightly script also needs thumbnails for new uploads:

```text
button ──┐
         ├──▶ makeThumbnail ──▶ thumbnail
script ──┘
```

Does the script need a new library or programming model? No. A shared function already solves this. **When callers and implementations live in one place and change together, plain functions are the right tool.**

## Step 2: Separate the caller from the work

Large images get slow, so you move thumbnail generation to a worker (or a plugin, or a separate service). Keep the callers in place; move the implementation:

```text
button ──┐                       worker
         ├──▶ makeThumbnail ──▶ [ implementation ]
script ──┘
```

Now the callers and the worker change on different schedules. And notice a subtle problem: an ordinary function is **opaque**. You can *run* it, and that is all you can do with it. You cannot ask a function what it reads, what it mutates, whether a caller should only be allowed to propose it, or whether a replacement worker still honors the same contract—not without running it and hoping.

So make **one move**: lift the description of the action out of the function and represent it as data:

```text
images.makeThumbnail
  input:   { imageId, maxWidth }
  output:  { imageId, width, height }
  reads:   ["images"]
  changes: ["images"]
```

This named, inspectable description is an **Interaction**. Your application still owns what it means and writes the code that performs it. Boundary turns that description into a canonical, content-addressed contract—without pulling in your store, worker, or transport.

*(If you like analogies: this is the same leap as moving from arithmetic to algebra. Once a concrete calculation becomes an explicit symbol with known rules, you can check equivalence, transform expressions, and build algorithms on top of it—before plugging in concrete numbers.)*

## Step 3: Predict the mismatch before running anything

Suppose someone deploys a new worker. It takes the exact same input (`imageId`, `maxWidth`), but instead of returning a finished thumbnail, it enqueues work and returns `{ jobId }`.

Before connecting anything, pause and ask: **can the existing button display a thumbnail from that response?**

| What the button expects | What the worker offers |
| --- | --- |
| `{ imageId, width, height }` | `{ jobId }` |

No. Sharing the name `images.makeThumbnail` is not enough—the contract changed.

Because both sides are inspectable values, Boundary checks their compatibility **before a single handler executes**. Instead of letting the button crash at runtime (or connecting half an interface), connecting them produces an exhaustive `unrealized` report explaining *which* contract disagreed and *why*. You can then deliberately update the caller for async jobs or fix the worker. Boundary never guesses or silently migrates a contract for you.

## Step 4: Earn the five names

Now expand the editor slightly: it can `inspect`, `makeThumbnail`, and `delete`. The nightly script only needs `makeThumbnail`.

```text
editor: [ inspect, makeThumbnail, delete ]
script: [          makeThumbnail         ]
                         │
                  atomic check
                         │
worker: [ inspect, makeThumbnail, delete ]
```

Every piece we just needed has a crisp name in Boundary:

1. **Program** — the canonical set of declared interactions and their digests. Pure data; no handlers.
2. **Projection** — the exact slice of interactions and modes (`direct` or `request`) a caller needs. Slice them like sets (`pick`, `omit`, `union`, `intersect`) before any implementation exists.
3. **Installation** — a live snapshot of your application's implementations, each paired with an explicit realization ID.
4. **Binding** — the atomic, checked connection pairing one Projection to one Installation plus your per-call admission rule.
5. **Caller** — the stateless interface obtained from a Binding (`call`, `direct.*`, or typed-outcome `try.*`).

Test your intuition with one more prediction: suppose a caller asks for `[inspect, makeThumbnail]`, and an installation only implements `[inspect]`. Should Boundary hand back an `inspect`-only Caller?

```text
caller requires        installation provides
inspect          ───▶  inspect                  match
makeThumbnail    ───▶  [ missing ]              missing
                          │
                          ▼
                   unrealized report
                   (no partial Caller)
```

No. Binding is **all-or-nothing** over the Projection. If a caller wants a smaller interface, it chooses a smaller Projection explicitly; Boundary never silently degrades a caller's contract. And a Binding stays pinned to its Installation—replacing an implementation never moves live callers behind your back (when you *want* live upgrades, swap atomically with `createBindingSlot`).

## Step 5: See what else falls out for free

Once interactions declare `reads` and `changes`, two more capabilities emerge without inventing a new model:

- **Live view refresh:** Any UI view reading `"images"` knows to refresh when an observed interaction changes `"images"` (or `"image:{input.id}"` for per-record precision).
- **Handler-free `Plan`s:** A multi-step workflow is just a static DAG over interactions. Before step 1 runs, Boundary can derive its minimal Projection, group independent steps into parallel waves (by disjoint footprints), and atomically preflight the whole sequence.

And when an action is too risky to execute immediately (like publishing or deleting), you expose it in **`request`** mode instead of `direct` mode: calling `request` prepares a reviewable proposal rather than running the effect, and any mid-flight network drop stays explicitly **`uncertain`** until reconciled.

## Step 6: Know what the check cannot tell you

Suppose the worker returns `{ imageId: "orig:w200", width: 200, height: 150 }`—matching the schema to the letter—but the resized image is upside-down and blurry.

Contract checks establish **declared agreement**, not visual quality, business correctness, or behavioral equivalence between two implementations. Those still belong to your tests (and `@foxworth/boundary/testing` helps verify handlers against their contracts).

## Step 7: Now add an AI agent

An agent needs to prepare thumbnails for an article. Ask yourself: **which definitions must change?**

None.

```text
editor: [ inspect, makeThumbnail, delete ]
script: [          makeThumbnail         ]
agent:  [ inspect, makeThumbnail         ]
                         │
                  checked bindings
                         │
worker: [ inspect, makeThumbnail, delete ]
```

The agent gets its own narrow Projection (`inspect` and `makeThumbnail`—never `delete`) and its own admission rule. MCP or WebMCP adapters present that exact Binding as tools without inventing a second execution model.

---

**Next:** [Build and break the thumbnail example in TypeScript →](../guides/getting-started.md)
For ownership lines, see [What Boundary provides](./boundary.md); for exact limits, see [Guarantees and counterexamples](./guarantees.md).
