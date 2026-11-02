---
title: "Interaction-first programming"
description: "See what stays fixed when callers and implementations change."
---

# Interaction-first programming

What should stay the same when we change how an application is used or where
its work happens?

Start with a small image editor. A person chooses a photograph, sets a maximum
width, and presses **Make thumbnail**.

```text
button ──> make thumbnail ──> small photograph
```

An ordinary function can do this well. It receives an image ID and a maximum
width, then returns a thumbnail ID and its dimensions.

## Change the caller

A nightly script now needs thumbnails for recently uploaded photographs.

```text
button ──┐
         ├──> make thumbnail ──> small photograph
script ──┘
```

Does the script need a second implementation? No. Both callers can use the
same function. Shared functions already solve this part of the problem.

## Move the work

Large images make processing expensive, so the application moves the work to a
worker. Keep the callers in place; move the implementation.

```text
button ──┐                       worker
         ├──> make thumbnail ──> [ implementation ]
script ──┘
```

The callers and worker can now change on different schedules. They need an
agreement that can be inspected separately from the code on either side:

```text
images.makeThumbnail

input:   image ID + maximum width
output:  thumbnail ID + width + height
reads:   images
changes: images
```

This named, declared application action is an **interaction**. The application
owns what it means and how it works. Boundary records its portable contract,
including input, output, declared errors, and reads and changes.

Moving execution still requires the application's transport and deployment
work. Declaring an interaction does not create a worker or route calls to it.

## Predict the mismatch

A replacement worker accepts the same input but returns a job ID. The image
will be ready later.

Before connecting it, ask: can the existing button display the promised
thumbnail from that response?

| The button expects | The worker returns |
| --- | --- |
| thumbnail ID, width, height | job ID |

It cannot. Matching the name `images.makeThumbnail` is not enough. The output
contract no longer satisfies the caller's expectation.

Boundary checks the declared agreement when connecting a caller surface to an
installation. An incompatible surface produces an `unrealized` report instead
of a partially connected caller. The application can deliberately change its
interface to support jobs, or provide an implementation that fulfills the
existing contract. Boundary does not invent that migration.

## Name the pieces we have found

The editor also knows how to inspect and delete images. The nightly script
needs only thumbnail creation.

```text
editor: [ inspect, makeThumbnail, delete ]
script: [          makeThumbnail         ]
                         |
                  checked connection
                         |
worker: [ inspect, makeThumbnail, delete ]
```

A **Program** holds the portable interaction declarations and their derived
identities. A **Surface** selects the interactions and modes a caller needs;
it can exist before any implementation is available.

An **Installation** supplies live implementations. A **Binding** records a
successful check of the entire Surface against one Installation. Its
**Caller** invokes that selected surface.

Try one more prediction: a caller requires both inspection and thumbnail
creation, but the installation provides only inspection. Should it receive an
inspection-only Caller?

```text
caller requires       installation provides
inspect          ───> inspect                 match
makeThumbnail    ───> [ missing ]              missing
                         |
                         v
                 unrealized report
                 no partial Caller
```

Binding is atomic over the selected surface. A caller can deliberately select
a smaller surface, but binding does not make that product decision for it.

Each Binding pins its checked mapping. It does not follow a replacement
installation automatically. The host still decides whether to admit each
invocation; selecting an interaction does not grant permission to execute it.

## Know what the check cannot tell you

Suppose the worker returns a valid thumbnail ID and dimensions, but the image
is blurry. Its output may satisfy the schema while failing the application's
quality requirements.

Contract checks establish declared agreement. They do not prove image quality,
business correctness, or equivalent behavior between implementations. Those
need application tests and evidence.

Use interactions at boundaries where callers and implementations need an
explicit agreement. Keep private helpers as ordinary functions.

## Now add an agent

An agent needs to prepare thumbnails for an article. Which parts of the model
must change?

The application can select inspection and thumbnail creation for it:

```text
editor: [ inspect, makeThumbnail, delete ]
script: [          makeThumbnail         ]
agent:  [ inspect, makeThumbnail         ]
                         |
                  checked connections
                         |
worker: [ inspect, makeThumbnail, delete ]
```

The agent uses the existing interactions through its own selected surface and
host admission. Deleting originals remains outside that surface. Tool
presentation can describe the available actions without defining a second
execution model.

The next step is to [build and break the thumbnail example](../guides/getting-started.md).
For ownership boundaries, read [what Boundary provides](./boundary.md); for exact limits,
read [guarantees](./guarantees.md).
