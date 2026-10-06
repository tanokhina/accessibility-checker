# Accessibility checker

A Figma plugin that finds accessibility problems in a design, suggests fixes, and marks the problems on the canvas for the rest of the team.

It checks two things: the colour contrast of text, and the size of buttons and other tappable elements. It works entirely inside Figma and never connects to the internet.

## Features

### Contrast

- Checks every text layer in the selection against WCAG 2.1 contrast levels.
- Lets you choose the target: **AA** (4.5:1, or 3:1 for large text) or **AAA** (7:1, or 4.5:1 for large text).
- Suggests the closest colour that passes, keeping the same hue, and applies it with one click.
- **Fix all** fixes every failing layer at once.
- A colour picker with a live contrast ratio, where a striped area marks the colours that fail.
- Handles text that mixes several colours or sizes, and reports the part that is furthest from passing.

### Touch targets

- Finds buttons and other tappable layers that are too small.
- A layer counts as tappable if it has a prototype link, or a name such as "Button", "Tab", "Close" or "More".
- Lets you choose the minimum size: 44 × 44 (iOS), 48 × 48 (Android) or 24 × 24 (WCAG 2.2 AA).
- Says how much wider and taller each failing layer needs to be.

### Annotations

- Places numbered markers on the canvas next to every failing item, and a legend below the screen that explains each one.
- Each screen keeps its own markers and legend, so several screens can be annotated side by side.
- Markers sit on top of the design in a separate locked layer. The design itself is not changed.

### Working with results

- **Ignore** hides an item that does not need fixing, such as a logo or a disabled state. The choice is saved on the layer, so it is remembered for everyone who opens the file.
- The lists refresh automatically when the design changes.
- Clicking a result selects that layer and zooms to it.
- Follows Figma's light and dark themes.

## How backgrounds are worked out

The plugin needs the colour behind each text to calculate contrast.

- **Plain backgrounds** (frames, rectangles, circles) are read directly from the layers. Semi-transparent layers are blended.
- **Shapes the layers can't explain** (icons and other vectors, outlined elements with no fill, combined shapes, gradients) are measured from a rendered image of the screen. On a gradient, the text is judged at its worst spot.
- **Photos and other image fills are not measured.** Text on a photo is listed as "check manually".

## Limits

- Text on a photo is not checked. You need to judge it by eye.
- Text whose own fill is a gradient or an image is listed as "check manually".
- Measured backgrounds are sampled just around the text. Another element within 2px of the text can affect the result.
- Touch targets are found by prototype links and layer names. A tappable layer with neither is not found.
- Only local colours are used. Contrast of icons and shapes (non-text contrast) is not checked yet.

## Install for development

You need the [Figma desktop app](https://www.figma.com/downloads/) and [Node.js](https://nodejs.org/).

1. Download or clone this repository.
2. In a terminal, go to the folder and install the tools:
   ```
   npm install
   ```
3. Build the plugin. This turns `code.ts` into `code.js`, which is the file Figma runs:
   ```
   npm run build
   ```
4. In Figma, open **Plugins → Development → Import plugin from manifest…** and choose `manifest.json` from the folder.
5. Run it from **Plugins → Development → Accessibility checker**.

While working on the code, run `npm run watch` instead of `npm run build`. It rebuilds `code.js` every time `code.ts` is saved. Close and reopen the plugin in Figma to load the new build.

## How to use it

1. Select a screen, or any layers, in Figma.
2. Run the plugin.
3. Open the **Contrast** tab to see failing text first. Use **Apply** or **Fix all**, or pick your own colour.
4. Open the **Touch targets** tab to see tappable layers that are too small.
5. Click **Annotate** to mark the remaining problems on the canvas. Use **Update markers** after making fixes, or **Clear** to remove them.

## Project files

| File | What it is |
|---|---|
| `manifest.json` | Tells Figma the plugin's name, files and permissions |
| `code.ts` | The plugin logic: reads the design, runs the checks, applies fixes, draws annotations |
| `ui.html` | The plugin window: tabs, result cards, colour picker |
| `code.js` | Built from `code.ts`. Not stored in the repository |

## Privacy

The plugin has no network access. Nothing from your file leaves Figma.
