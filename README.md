## Nebula Photo Studio

Nebula Photo Studio is a fully featured browser photo editor built with Next.js 16, React 19, and Sass. It focuses on a dark, touch-friendly UI and provides the following capabilities:

- Layer system with visibility toggles, blend modes, opacity sliders, duplication, and bitmap import (`.png`, `.jpg`, etc.).
- Tooling strip for brush, eraser, fill, text, selection, move, crop, and a color picker. Brush + eraser support direct drawing on the canvas with undo/redo.
- Canvas management with live width/height inputs, zoom control, snapping grid, and history-aware background fills.
- Color management stack with dual color pickers, palette tracking, swap action, and precise tonal adjustments (exposure, temperature, tint, highlights, shadows, etc.).
- Plugin system (Soft Glow, Analog Film, Infrared Shift) that applies reusable looks on top of the current stack in a non-destructive way.
- Keyboard-friendly undo/redo controls backed by a snapshot history engine.

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to interact with the editor. Import an image via the Import button or draw directly with the Brush tool.

## Project structure

- `app/editor/state.tsx` – reducer-driven store, undo/redo history, plugin registry.
- `app/editor/components/*` – UI panels (Toolbar, LayerPanel, CanvasStage, AdjustmentsPanel, PluginPanel, StatusBar).
- `app/editor/plugins/defaultPlugins.ts` – baked-in plugin recipes.
- `app/globals.scss` & `app/editor/components/editor.module.scss` – dark mode styling and layout primitives.

## Future enhancements

- Mask layers and vector shapes
- Advanced brush settings (size, hardness, jitter)
- Export presets + shareable workspaces

Contributions are welcome—feel free to file an issue or open a PR with improvements.
