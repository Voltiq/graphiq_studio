# Graphiq Studio — Pro Feature Roadmap (Claude Code prompt pack)

This pack contains **self-contained implementation specs** written to be handed to Claude Code (Opus 4.8) one at a time. Each numbered `.md` is a complete prompt: paste the whole file as the first message of a fresh Claude Code session and it can begin coding immediately.

## What this pack covers

Graphiq Studio already has a strong **destructive** editor (18 tools, 19 blend modes, selections, live sessions, linear history, colour management, Blur Gallery). The largest gap versus Photoshop/Affinity is **non-destructive editing** plus the **engine architecture** that lets non-destructive features scale. These seven specs install that, each reusing systems you already built rather than replacing them.

| # | Spec | What it adds | Reuses | Hard dependency |
|---|------|--------------|--------|-----------------|
| 01 | **Layer Masks** | Per-layer raster masks (reveal/hide) | Selection mask, brush pipeline, compositor | — |
| 02 | **Adjustment Layers** | Non-destructive adjustment nodes affecting everything below | Existing adjustment math, masks (01) | 01 |
| 03 | **Layer Effects / Styles** | Drop shadow, stroke, glows, overlays, bevel | Compositor, Blur Gallery blur | — |
| 04 | **Curves & Levels** | Precision per-channel tone tools, as adjustment types | Adjustment system (02), Channels/histogram | 02 (for non-destructive form) |
| 05 | **Clipping Masks** | Clip a layer to the alpha of the one below | Compositor, the `clipped` flag from 02 | — |
| 06 | **Render Graph & Dirty-Region** | Node cache + dependency-versioned, region-scoped recompositing | The whole compositor (wraps it) | — (do after 01+02) |
| 07 | **Smart Filters** | Non-destructive per-layer filter stack; homes the placeholder filters | Blur Gallery, separable blur, live-session | — (best after 06) |

## Where the ChatGPT phase list landed (read this if you brought that list here)

The external "Phase 1–9" list was mostly sound — these are all real pro-editor features — but two things needed correcting: **Render Graph is not a "do-it-first" item**, and the **last three phases are research/prototype tracks, not things you spec**. Here is each phase mapped to this pack:

| ChatGPT phase | Verdict | Where it lives |
|---|---|---|
| 1 · Render Graph + Dirty Region | ✓ Makes sense — but framing/ordering corrected | **Spec 06** (do *after* 01+02, not first) |
| 2 · Layer Masks | ✓ | **Spec 01** |
| 3 · Clipping Masks | ✓ New spec — small, low-risk | **Spec 05** |
| 4 · Adjustment Layers | ✓ | **Spec 02** |
| 5 · Smart Filters | ✓ New spec — also implements your placeholder filters | **Spec 07** |
| 6 · Layer Effects | ✓ | **Spec 03** |
| 7 · WebGPU renderer | Legit long-term; **not spec-able yet** | *v2-engine horizon* (below) |
| 8 · 16-bit / 32-bit processing | Important; **deeper rewrite than GPU** | *v2-engine horizon* (below) |
| 9 · RAW development | Furthest horizon; needs phase 8 + a WASM decoder | *v2-engine horizon* (below) |

**On "Render Graph first."** The claim that "every edit recomposites from scratch" and that a render graph makes opacity "instant" oversells it: your paint path already uses dirty regions and scratch buffers, and a single layer's opacity change is already one `drawImage`. What the compositor genuinely lacks is **caching of stable subtrees** (so 1000+ layers and stacked adjustments don't redo work) and a **single caching seam** that every non-destructive feature — and any future GPU/high-bit backend — hangs off instead of each inventing its own cache. That is real value, but it is best built **after** masks and adjustment layers exist to stress it, as a **behaviour-preserving refactor** (Spec 06). Doing it first, before the features that need it, is premature optimization on a working app.

## Recommended order

Only two dependencies are **hard**: `01 → 02`, and `02 → 04` (for Curves/Levels' non-destructive form; the destructive form ships without it). Everything else is **soft** ordering you can rearrange.

```
        ┌──────────────────────┐
        │ 01 Layer Masks       │  ← foundation; unblocks 02 and the mask reuse in 05/07
        └──────────┬───────────┘
                   │ (hard)
        ┌──────────▼───────────┐
        │ 02 Adjustment Layers │  ← headline non-destructive feature
        └──────────┬───────────┘
                   │ (hard, for non-destructive form)
        ┌──────────▼───────────┐   ┌──────────────────────┐
        │ 04 Curves & Levels   │   │ 05 Clipping Masks    │ ← small, low-risk; shares
        └──────────┬───────────┘   └──────────┬───────────┘   the `clipped` flag with 02
                   └─────────────┬────────────┘
                                 │
        ┌────────────────────────▼─────────────────────────┐
        │ 06 Render Graph & Dirty-Region                    │ ← now that the above stress the
        │ (behaviour-preserving; consolidates all caches)   │   compositor, build the one seam
        └────────────────────────┬─────────────────────────┘
                                 │
        ┌────────────────────────▼──────────┐   ┌──────────────────────┐
        │ 07 Smart Filters                   │   │ 03 Layer Effects     │ ← independent; can be
        │ (best on top of 06's node cache)   │   │ (parallel, any time) │   built in parallel by a
        └────────────────────────────────────┘   └──────────────────────┘   separate session
```

- **01 → 02 → 04** is the critical non-destructive path. **05** slots in beside 04 (both small; 05 shares 02's `clipped` field and generalises it to all layer kinds).
- **06** is the highest-risk spec (it refactors the core compositor) — give it a single focused session, *after* 01/02 so its dependency model has real consumers (adjustment-layer "below" dependencies) to validate against. It is behaviour-preserving and ships a debug flag to A/B against the old path.
- **03 (Layer Effects)** shares nothing with the mask/adjustment work beyond `layers.ts` and the `.aproj` serializer, so it can be built **in parallel** at any point by a second session.
- **07 (Smart Filters)** is independent and also the place your placeholder menu items (Sharpen, Distort, Noise, Pixelate, Stylize) finally get implemented. Build it after 06 so its filter cache folds into the node cache instead of being a separate cache.

## How to use a spec

1. Open a fresh Claude Code session in the Graphiq Studio repo.
2. Paste the entire spec file as the first message.
3. The spec's final section instructs Claude to first **read the real source files** it integrates with (`app/lib/paint.ts`, `app/lib/layers.ts`, `app/lib/color.ts`, the history module, the `.aproj` serializer, and any prerequisite specs' code) to confirm exact signatures, then implement.
4. Review the diff against the spec's **Acceptance criteria** checklist.

> These specs describe your architecture from FEATURES.md. Where an exact existing signature matters, the spec tells Claude to discover it in-repo rather than assume — so the prompts stay correct even though they were written without direct code access. **If you have changed `paint.ts` or `layers.ts` since writing FEATURES.md, skim §3 of the relevant spec before handing it over.**

## Format-version coordination (read once)

Specs 01–05 and 07 all extend the `.aproj` project format (06 does not — it is a runtime cache only). To avoid clashes, one rule:

- Add a top-level `"version"` integer to `.aproj` if one does not already exist (treat absent as `1`).
- Each spec **only adds optional fields** and tolerates their absence on load (older files must still open). No spec removes or renames an existing field.
- Bump `version` once per spec landed, with a `loadProject` migration switch that fills defaults for missing fields.
- **Shared field, 02 ↔ 05:** the `clipped` boolean is introduced by Spec 02 (on adjustment layers) and **promoted to all layer kinds** by Spec 05. Whichever lands second must promote rather than duplicate it. Treat absent `clipped` as `false`.

## The v2-engine horizon (deliberately NOT specced)

ChatGPT's phases 7–9 are legitimate destinations, but each is a fundamental departure from the Canvas2D / 8-bit / no-libraries architecture this app is built on. They are **research/prototype tracks**, not "implement immediately" specs — writing detailed specs for them now would be fiction, because the right design depends on decisions you make while prototyping. They share one prerequisite: **Spec 06's render-graph seam**, which is what lets you retarget node rendering to a new backend without rewriting the app.

- **WebGPU renderer (phase 7).** Re-implements compositing, all 19 blend modes, and every filter/adjustment as WGSL shaders, with the Canvas2D path kept as a fallback and kept in sync. Enormous surface area; browser support still uneven. **Prerequisite:** Spec 06 (so nodes render through a swappable backend) and stable filter/effect abstractions (Specs 03/07). Approach it as a prototype that retargets `renderNode`, not a big-bang rewrite.
- **16-bit / 32-bit processing (phase 8).** Arguably a *deeper* change than the GPU move: Canvas2D `ImageData` is 8-bit, so high bit depth means holding `Uint16Array`/`Float32Array` pixel buffers, converting to 8-bit only for display, and hand-writing all 19 blend modes (you lose `globalCompositeOperation`). Naturally pairs with the GPU work (float textures). **Prerequisite:** the GPU/backend seam, because doing high-bit on the CPU in JS for a 4000×3000 doc is slow. This is "v2 engine," not a sprint.
- **RAW development (phase 9).** A whole sub-application (a Lightroom-style Develop module): demosaicing, white balance, highlight recovery, a separate non-destructive pipeline. It needs **16/32-bit (phase 8)** first (RAW is 12–14-bit linear) and a RAW decoder (libraw-via-WASM or similar), which breaks the "no image-processing libraries" rule — a conscious trade-off to make when you get there. Furthest out; likely its own mode/product.

Sequence when you reach it: **06 (seam) → WebGPU → 16/32-bit → RAW.**

## Other features worth a spec later (smaller, not in this pack)

- **Liquify** — forward-warp mesh tool (push/bloat/pucker/twirl) with a displacement-map session. (Distinct from Smart Filters; the Liquify menu placeholder.)
- **Healing / Content-Aware** — spot-healing brush and patch, building on the clone-stamp pipeline.
- **Smart Guides, Layer Comps, channel-based selections.**

Each can be specced in this same template when you are ready.
