# Real-device checklist

**A green CI run is not "mobile works".**

Every mobile rail in this repo runs in an emulated Chromium on a desktop. That
emulation is good enough to make real geometric claims — `tools/mobile.js` gives
it a phone's viewport, pixel ratio, user agent and touch input, and
`tools/verify-mobile-invariants.js` asserts the five invariants against it — but
there is a specific, knowable list of things it *cannot* see. This is that list.

Each item names **the code path it covers**, so a failure on a real device lands
somewhere rather than becoming "mobile feels wrong". Run it on one iOS device and
one Android device before shipping anything that touches the mobile shell.

---

### 1. The real notch, and the real home indicator

**Covers:** `app/lib/safeArea.ts`, the `--safe-t` family of tokens and the derived
`--chrome-top` / `--chrome-bottom` in `app/globals.scss`.

`verify-safe-area.js` hands Chromium a synthetic 47/34 inset over CDP, which
makes `env()` resolve for real — but only for the one device shape we chose.
Real insets differ per model, change on rotation, and change again when the
browser's own chrome appears.

- [ ] Rotate to landscape on a notched phone: no control under the cutout on
      either side.
- [ ] The bottom bar clears the home indicator with the app in a browser tab
      **and** installed to the home screen — they differ.

### 2. The URL bar collapsing as you scroll

**Covers:** `height: 100svh` in `app/components/Editor.module.scss`.

This one is invisible to emulation *by measurement, not by assumption*:
`verify-viewport.js` records that desktop Chromium resolves `vh`, `svh`, `lvh`
and `dvh` to the same number, and that neither `Emulation.setVisibleSize` nor a
clipped device-metrics override makes them diverge. Reverting `100svh` to
`100vh` would leave every emulated check green.

- [ ] With the URL bar showing, the bottom bar is fully visible and tappable —
      not sliding under the browser's own chrome.
- [ ] Nothing in the shell moves when the URL bar retracts.

### 3. The real virtual keyboard

**Covers:** `app/lib/useVisualViewport.ts` — the `--kb-inset` and `--vv-h`
custom properties.

CDP can shrink the visual viewport, and `verify-viewport.js` uses that. It
cannot reproduce iOS's accessory bar, the predictive-text strip, the way Safari
scrolls a focused field into view on its own, or a third-party keyboard's
height.

- [ ] Tap a number field in a tall dialog: the field stays visible and the
      primary button is still reachable.
- [ ] Dismiss the keyboard: the layout returns exactly, with no dead band left
      at the bottom.

### 4. Real performance, and heat

**Covers:** `app/lib/budgets.ts` (`BY_CLASS`), and `DRAFT_MAX_PIXELS` in
`app/lib/paint.ts`.

`tools/mobile.js` throttles the CPU 4×, which slows *script* only. It does not
model a slower GPU, lower memory bandwidth, or a thermal ceiling — so it
understates the gap, which is the safe direction to be wrong in, but it is still
wrong. Measured locally: cold boot 254 ms unthrottled, 714 ms at 4×.

- [ ] Paint continuously for two minutes on a mid-range Android and check the
      stroke does not fall behind the finger as the device warms.
- [ ] A live filter preview on a 12 MP photo stays interactive.

### 5. How much memory the device really has

**Covers:** `readDeviceHints()` in `app/lib/budgets.ts`.

Under emulation `navigator.deviceMemory` and `hardwareConcurrency` report the
**host** — an emulated phone here claims 32 GB and 32 cores. That is why the
device *class* leads and the hardware hints may only shrink a budget. On iOS
`deviceMemory` does not exist at all.

- [ ] On a 3–4 GB Android phone, confirm the cache budget lands at the phone
      tier rather than the desktop one.

### 6. iOS's canvas ceiling and its tab killer

**Covers:** `app/lib/canvas-ceiling.ts`, and `checkAllocation` in
`app/lib/paint.ts`.

Desktop Chromium's ceiling is far higher than iOS Safari's, and only a real
device reproduces the failure this code exists for: an over-limit canvas that
allocates *silently*, reads back as zeros, and logs nothing. iOS also discards
backgrounded tabs under memory pressure, which no harness can stage.

- [ ] Open a 100 MP image on an iPhone: it is refused with a message, not a
      blank canvas.
- [ ] Background the tab for five minutes with unsaved work, return, and confirm
      the document is recovered (`app/lib/autosave.ts`, `app/lib/crash.ts`).

### 7. Installing to the home screen

**Covers:** the pre-paint install capture in `app/layout.tsx` and
`app/lib/space.ts`.

Playwright contexts are incognito, and `beforeinstallprompt` never fires in one
— measured, after mistaking it for a property of the app. iOS has no such event
at all and installs through the Share sheet instead.

- [ ] Android/Chrome: the install offer appears and installing works.
- [ ] iOS/Safari: Add to Home Screen produces a standalone window with the
      correct icon and no browser chrome.

### 8. Real fingers, palms and styluses

**Covers:** `palmDown`, `rejectsPointer` and `effectivePressure` in
`app/lib/pointer.ts`.

Emulated touches carry whatever radius and force the harness invents — always
`force: 1`, a fixed radius. Palm rejection is a judgement about real contact
geometry, and pen pressure is real hardware.

- [ ] Rest a palm on the glass while drawing with a finger: the stroke is not
      interrupted and the palm leaves no mark.
- [ ] With a stylus, light and heavy pressure give visibly different strokes.

### 9. Parked surfaces, with a real keyboard or switch control

**Covers:** the `parked` prop on `app/components/Toolbar.tsx` and
`app/components/RightDock.tsx`, which sets `inert`.

Emulation *can* see this one and now does — a tab sweep found 46 of 59 stops
were controls no finger could reach — but assistive tech is its own stack.

- [ ] With a Bluetooth keyboard attached, Tab never lands on a shut drawer.
- [ ] With VoiceOver / TalkBack on, swiping through the page never announces a
      control from a closed drawer.

---

## What emulation *does* cover, so it is not repeated above

`tools/verify-mobile-invariants.js` (11 checks) asserts the five invariants: the
44px floor in every shell state and inside all 43 dialogs, hit-testability by
`elementFromPoint`, no page scroll even when shoved, shell height equal to
`visualViewport.height`, no control under a simulated notch, and every dialog's
primary button touchable where it sits. Behind it sit `verify-hit-targets`,
`verify-touch-targets`, `verify-safe-area`, `verify-viewport` and
`verify-dialog-sheets` — 104 further checks.
