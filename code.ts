// Accessibility checker
// 1. Contrast: checks text colour contrast (WCAG 2.1) and suggests a passing colour.
// 2. Touch targets: finds buttons and other tappable layers that are too small.
// 3. Annotations: puts numbered markers and a legend on the canvas for the team.
// Items can be ignored (saved on the layer), and fix colours can be picked by hand.
// The checks run again automatically whenever the design changes.

figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

const WHITE: RGB = { r: 1, g: 1, b: 1 };
const MAX_NODES = 500;

// "Ignore" is saved on the layer itself, so it is remembered next time and for teammates
const IGNORE_KEYS: { [kind: string]: string } = {
  contrast: 'a11yIgnoreContrast',
  target: 'a11yIgnoreTarget',
};

// Which WCAG level counts as passing: AA (4.5:1) or the stricter AAA (7:1)
type Level = 'AA' | 'AAA';
let contrastLevel: Level = 'AA';

function neededRatio(isLarge: boolean, level: Level): number {
  if (level === 'AAA') return isLarge ? 4.5 : 7;
  return isLarge ? 3 : 4.5;
}

type Layer = { color: RGB; opacity: number };
type PaintResult = { layer: Layer } | { complex: true } | null;

type Result = {
  id: string;
  name: string;
  text: string;
  ratio: number | null;
  textHex: string;
  bgHex: string;
  fontSize: number;
  isLarge: boolean;
  aa: boolean;
  aaa: boolean;
  needed: number;
  ignored: boolean;
  status: 'fail' | 'check' | 'pass';
  note?: string;
  suggestHex?: string;
  suggestRatio?: number;
  noFix?: boolean;
  detachesStyle?: boolean;
};

type SegmentCheck = {
  start: number;
  end: number;
  textColor: RGB;
  ratio: number;
  fontSize: number;
  isLarge: boolean;
  needed: number;
};

// ---------- Colour maths ----------

function luminance(c: RGB): number {
  const ch = (v: number) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrast(a: RGB, b: RGB): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function blend(top: RGB, alpha: number, bottom: RGB): RGB {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  };
}

function round8(c: RGB): RGB {
  const r = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;
  return { r: r(c.r), g: r(c.g), b: r(c.b) };
}

function parseHex(hex: string): RGB | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function toHex(c: RGB): string {
  const h = (v: number) => ('0' + Math.round(v * 255).toString(16)).slice(-2);
  return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}

function rgbToHsl(c: RGB): { h: number; s: number; l: number } {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6 : 0);
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return { r: l, g: l, b: l };
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3),
    g: hue2rgb(p, q, h),
    b: hue2rgb(p, q, h - 1 / 3),
  };
}

// Finds the colour closest to the original (same hue and saturation,
// only lighter or darker) that reaches the target contrast.
function suggestColor(text: RGB, bg: RGB, target: number): RGB | null {
  const goal = target + 0.05; // small safety margin for rounding
  const { h, s, l } = rgbToHsl(text);
  let best: RGB | null = null;
  let bestDistance = Infinity;

  for (const end of [0, 1]) {
    // Skip a direction if even pure black / white of this hue can't pass
    if (contrast(round8(hslToRgb(h, s, end)), bg) < goal) continue;
    let fail = l;
    let pass = end;
    for (let i = 0; i < 24; i++) {
      const mid = (fail + pass) / 2;
      if (contrast(round8(hslToRgb(h, s, mid)), bg) >= goal) pass = mid;
      else fail = mid;
    }
    const distance = Math.abs(pass - l);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = round8(hslToRgb(h, s, pass));
    }
  }
  return best;
}

// ---------- Reading fills ----------

function topVisiblePaint(
  fills: ReadonlyArray<Paint> | PluginAPI['mixed']
): PaintResult {
  if (fills === figma.mixed) return { complex: true };
  const list = fills as ReadonlyArray<Paint>;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      return { layer: { color: p.color, opacity: p.opacity ?? 1 } };
    }
    return { complex: true };
  }
  return null;
}

function centerInside(inner: Rect, outer: Rect): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height
  );
}

// Does a shape really sit behind the middle of the text?
// "misses": no (outside it, or in the hole of a ring). "unsure": irregular shape, can't tell.
function coverage(shape: SceneNode, textBox: Rect): 'covers' | 'misses' | 'unsure' {
  const b = shape.absoluteBoundingBox;
  if (!b || b.width === 0 || b.height === 0 || !centerInside(textBox, b)) return 'misses';

  if (shape.type === 'ELLIPSE') {
    // Distance of the text centre from the ellipse centre: 0 = centre, 1 = edge
    const nx = (textBox.x + textBox.width / 2 - (b.x + b.width / 2)) / (b.width / 2);
    const ny = (textBox.y + textBox.height / 2 - (b.y + b.height / 2)) / (b.height / 2);
    const distance = Math.sqrt(nx * nx + ny * ny);
    if (distance > 1) return 'misses';
    const arc = shape.arcData;
    if (distance < arc.innerRadius) return 'misses'; // text sits in the hole of a ring
    const sweep = Math.abs(arc.endingAngle - arc.startingAngle);
    return sweep >= Math.PI * 2 - 0.01 ? 'covers' : 'unsure';
  }
  if (
    shape.type === 'VECTOR' ||
    shape.type === 'STAR' ||
    shape.type === 'POLYGON' ||
    shape.type === 'LINE' ||
    shape.type === 'BOOLEAN_OPERATION'
  ) {
    return 'unsure';
  }
  return 'covers';
}

function composite(layers: Layer[], base: RGB): RGB {
  let c = base;
  for (let i = layers.length - 1; i >= 0; i--) {
    c = blend(layers[i].color, layers[i].opacity, c);
  }
  return c;
}

function findBackground(node: SceneNode): { color: RGB } | { note: string } {
  const box = node.absoluteBoundingBox;
  const layers: Layer[] = [];
  const complexNote = {
    note: 'Background is an image, gradient or mixed fill — check manually',
  };

  const consider = (target: SceneNode): 'opaque' | 'complex' | 'continue' => {
    if (!('fills' in target)) return 'continue';
    const r = topVisiblePaint(target.fills);
    if (!r) return 'continue';
    if ('complex' in r) return 'complex';
    const nodeOpacity = 'opacity' in target ? target.opacity : 1;
    const alpha = r.layer.opacity * nodeOpacity;
    layers.push({ color: r.layer.color, opacity: alpha });
    return alpha >= 0.999 ? 'opaque' : 'continue';
  };

  let current: BaseNode = node;
  while (
    current.parent &&
    current.parent.type !== 'PAGE' &&
    current.parent.type !== 'DOCUMENT'
  ) {
    const parent = current.parent as SceneNode & ChildrenMixin;
    const index = parent.children.indexOf(current as SceneNode);

    for (let i = index - 1; i >= 0; i--) {
      const sib = parent.children[i];
      if (!sib.visible || sib.type === 'TEXT' || !box) continue;
      const cover = coverage(sib, box);
      if (cover === 'misses') continue;
      if (cover === 'unsure') {
        // An irregular shape only matters if it is filled with something
        if ('fills' in sib && topVisiblePaint(sib.fills)) {
          return { note: 'Text sits on an irregular shape — check manually' };
        }
        continue;
      }
      const s = consider(sib);
      if (s === 'complex') return complexNote;
      if (s === 'opaque') return { color: composite(layers, WHITE) };
    }

    const s = consider(parent);
    if (s === 'complex') return complexNote;
    if (s === 'opaque') return { color: composite(layers, WHITE) };

    current = parent;
  }

  const pageBg = topVisiblePaint(figma.currentPage.backgrounds);
  const base = pageBg && 'layer' in pageBg ? pageBg.layer.color : WHITE;
  return { color: composite(layers, base) };
}

// ---------- Checking text ----------

// Checks every part of a text layer (it can mix colours and sizes)
function analyzeSegments(
  node: TextNode,
  bg: RGB
): SegmentCheck[] | { note: string } {
  const checks: SegmentCheck[] = [];
  const segments = node.getStyledTextSegments(['fills', 'fontSize', 'fontWeight']);
  for (const seg of segments) {
    if (seg.characters.trim() === '') continue;
    const paint = topVisiblePaint(seg.fills);
    if (!paint) continue;
    if ('complex' in paint) {
      return { note: 'Text uses a gradient or image fill — check manually' };
    }
    const textColor = blend(
      paint.layer.color,
      paint.layer.opacity * node.opacity,
      bg
    );
    // WCAG "large text": 18pt (24px) or 14pt (18.66px) bold
    const isLarge =
      seg.fontSize >= 24 || (seg.fontSize >= 18.66 && seg.fontWeight >= 700);
    checks.push({
      start: seg.start,
      end: seg.end,
      textColor,
      ratio: contrast(textColor, bg),
      fontSize: seg.fontSize,
      isLarge,
      needed: neededRatio(isLarge, contrastLevel),
    });
  }
  return checks;
}

function usesColorStyle(node: TextNode): boolean {
  if (node.fillStyleId !== '') return true;
  const bound = node.boundVariables as { fills?: unknown } | undefined;
  return !!(bound && bound.fills);
}

function checkText(node: TextNode): Result {
  const result: Result = {
    id: node.id,
    name: node.name,
    text: node.characters.slice(0, 80),
    ratio: null,
    textHex: '',
    bgHex: '',
    fontSize: 0,
    isLarge: false,
    aa: false,
    aaa: false,
    needed: 0,
    ignored: node.getPluginData(IGNORE_KEYS.contrast) === '1',
    status: 'check',
  };

  const bg = findBackground(node);
  if ('note' in bg) {
    result.note = bg.note;
    return result;
  }
  result.bgHex = toHex(bg.color);

  const checks = analyzeSegments(node, bg.color);
  if ('note' in checks) {
    result.note = checks.note;
    return result;
  }
  if (checks.length === 0) {
    result.note = 'No visible text colour';
    return result;
  }

  // Report the part of the text that is furthest from passing
  let worst = checks[0];
  for (const c of checks) {
    if (c.ratio / c.needed < worst.ratio / worst.needed) worst = c;
  }

  result.ratio = Math.round(worst.ratio * 100) / 100;
  result.textHex = toHex(worst.textColor);
  result.fontSize = Math.round(worst.fontSize * 10) / 10;
  result.isLarge = worst.isLarge;
  result.needed = worst.needed;
  result.aa = worst.ratio >= neededRatio(worst.isLarge, 'AA');
  result.aaa = worst.ratio >= neededRatio(worst.isLarge, 'AAA');
  result.status = worst.ratio >= worst.needed ? 'pass' : 'fail';

  if (result.status === 'fail') {
    const suggestion = suggestColor(worst.textColor, bg.color, worst.needed);
    if (suggestion) {
      result.suggestHex = toHex(suggestion);
      result.suggestRatio = Math.round(contrast(suggestion, bg.color) * 100) / 100;
      result.detachesStyle = usesColorStyle(node);
    } else {
      result.noFix = true;
    }
  }
  return result;
}

// ---------- Applying fixes ----------

// "custom" is a colour picked by hand; without it the suggested colour is used
async function applyFix(id: string, custom?: RGB): Promise<boolean> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type !== 'TEXT') return false;

  const bg = findBackground(node);
  if ('note' in bg) return false;
  const checks = analyzeSegments(node, bg.color);
  if ('note' in checks) return false;

  const failing = checks.filter((c) => c.ratio < c.needed);
  if (failing.length === 0) return false;

  if (node.hasMissingFont) {
    figma.notify(`"${node.name}" uses a font that isn't installed — skipped`);
    return false;
  }
  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));

  let changed = false;
  for (const c of failing) {
    const color = custom ?? suggestColor(c.textColor, bg.color, c.needed);
    if (!color) continue;
    node.setRangeFills(c.start, c.end, [{ type: 'SOLID', color }]);
    changed = true;
  }
  // If the layer itself was semi-transparent, make it fully visible
  if (changed && node.opacity < 1) node.opacity = 1;
  return changed;
}

// ---------- Collecting layers ----------

function isVisible(node: SceneNode): boolean {
  let n: BaseNode | null = node;
  while (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
    if ('visible' in n && !n.visible) return false;
    n = n.parent;
  }
  return true;
}

function collectTextNodes(): TextNode[] {
  const out: TextNode[] = [];
  for (const n of figma.currentPage.selection) {
    if (isAnnotation(n)) continue; // don't check our own markers and legend
    if (n.type === 'TEXT') {
      if (isVisible(n)) out.push(n);
    } else if ('findAllWithCriteria' in n) {
      const found = n.findAllWithCriteria({ types: ['TEXT'] });
      for (const t of found) if (isVisible(t)) out.push(t);
    }
  }
  return out;
}

// ---------- Touch targets ----------

type TargetResult = {
  id: string;
  name: string;
  width: number;
  height: number;
  status: 'fail' | 'pass';
  reason: string;
  hint?: string;
  ignored: boolean;
};

// Layer names that usually mean "you can tap this"
const TARGET_WORDS =
  /\b(button|btn|cta|fab|link|tab|chip|toggle|switch|checkbox|radio|close|menu|more|back|dropdown|select|input|stepper)\b/;
// Layer names that usually mean "this only holds other things"
const CONTAINER_WORDS =
  /\b(bar|group|list|container|row|section|nav|navigation|wrapper|header|footer|screen|page|card)\b/;

let targetSize = 44;

// "IconButton/Close_small" -> "icon button close small"
function nameWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_/.]+/g, ' ')
    .toLowerCase();
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function checkTarget(node: SceneNode, reason: string): TargetResult {
  const width = round1(node.width);
  const height = round1(node.height);
  const missingW = Math.max(0, round1(targetSize - width));
  const missingH = Math.max(0, round1(targetSize - height));
  const result: TargetResult = {
    id: node.id,
    name: node.name,
    width,
    height,
    status: missingW > 0 || missingH > 0 ? 'fail' : 'pass',
    reason,
    ignored: node.getPluginData(IGNORE_KEYS.target) === '1',
  };
  if (result.status === 'fail') {
    const parts: string[] = [];
    if (missingW > 0) parts.push(missingW + 'px wider');
    if (missingH > 0) parts.push(missingH + 'px taller');
    result.hint = 'Make it ' + parts.join(' and ') + ' (padding counts)';
  }
  return result;
}

function collectTargets(): TargetResult[] {
  const out: TargetResult[] = [];

  const visit = (node: SceneNode) => {
    if (!node.visible || out.length >= MAX_NODES) return;

    const hasLink = 'reactions' in node && node.reactions.length > 0;
    // A text layer's name is usually its own text, so only trust prototype links there
    const words = node.type === 'TEXT' ? '' : nameWords(node.name);
    const named = TARGET_WORDS.test(words) && !CONTAINER_WORDS.test(words);

    if (hasLink || named) {
      out.push(checkTarget(node, hasLink ? 'Has a prototype link' : 'Named like a control'));
    }
    // A layer named like a button is one target: don't also report its inner icon.
    // A linked layer (for example a whole card) can still hold smaller buttons.
    if (named) return;

    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
  };

  for (const node of figma.currentPage.selection) {
    if (!isAnnotation(node)) visit(node);
  }
  return out;
}

// ---------- Annotations on canvas ----------
// Places numbered markers next to every failing item, and a legend below each
// screen, so other people can see the problems without running the plugin.
// Every screen keeps its own markers and legend, tagged with that screen's id.

const TAG = 'a11yAnnotation';
const MAX_ANNOTATIONS = 99;
const REGULAR: FontName = { family: 'Inter', style: 'Regular' };
const BOLD: FontName = { family: 'Inter', style: 'Bold' };
const RED: RGB = { r: 0.85, g: 0.19, b: 0.15 };
const PURPLE: RGB = { r: 0.44, g: 0.33, b: 0.93 };
const INK: RGB = { r: 0.1, g: 0.1, b: 0.1 };
const GREY: RGB = { r: 0.42, g: 0.44, b: 0.46 };
const LINE: RGB = { r: 0.89, g: 0.9, b: 0.91 };

type Issue = {
  id: string;
  kind: 'contrast' | 'target';
  title: string;
  detail: string;
};

function solid(color: RGB, opacity = 1): SolidPaint {
  return { type: 'SOLID', color, opacity };
}

// True for the markers and legend this plugin created (and anything inside them)
function isAnnotation(node: BaseNode): boolean {
  let n: BaseNode | null = node;
  while (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
    if (n.getPluginData(TAG) !== '') return true;
    n = n.parent;
  }
  return false;
}

// A "screen" is the outermost frame a layer sits in (directly on the page or in a section)
function screenOf(node: SceneNode): SceneNode {
  let top = node;
  while (
    top.parent &&
    top.parent.type !== 'PAGE' &&
    top.parent.type !== 'DOCUMENT' &&
    top.parent.type !== 'SECTION'
  ) {
    top = top.parent as SceneNode;
  }
  return top;
}

function selectedScreenIds(): Set<string> {
  const ids = new Set<string>();
  for (const node of figma.currentPage.selection) {
    if (!isAnnotation(node)) ids.add(screenOf(node).id);
  }
  return ids;
}

// All annotations on the page, or only the ones that belong to the given screens
function existingAnnotations(screenIds?: Set<string>): SceneNode[] {
  return figma.currentPage.children.filter((n) => {
    const owner = n.getPluginData(TAG);
    return owner !== '' && (!screenIds || screenIds.has(owner));
  });
}

function clearAnnotations(screenIds?: Set<string>): number {
  const old = existingAnnotations(screenIds);
  for (const node of old) node.remove();
  return old.length;
}

function annotationState() {
  const ids = selectedScreenIds();
  return {
    annotated: existingAnnotations().length > 0,
    annotatedSelection: ids.size > 0 && existingAnnotations(ids).length > 0,
  };
}

function makeText(characters: string, size: number, font: FontName, color: RGB): TextNode {
  const text = figma.createText();
  text.fontName = font;
  text.fontSize = size;
  text.characters = characters;
  text.fills = [solid(color)];
  return text;
}

// A small round badge with a number in it
function makeBadge(number: number, color: RGB): FrameNode {
  const badge = figma.createFrame();
  badge.name = 'Marker ' + number;
  badge.layoutMode = 'HORIZONTAL';
  badge.primaryAxisAlignItems = 'CENTER';
  badge.counterAxisAlignItems = 'CENTER';
  badge.paddingLeft = 6;
  badge.paddingRight = 6;
  badge.resize(20, 20);
  badge.primaryAxisSizingMode = 'AUTO';
  badge.counterAxisSizingMode = 'FIXED';
  badge.minWidth = 20;
  badge.cornerRadius = 10;
  badge.fills = [solid(color)];
  badge.strokes = [solid(WHITE)];
  badge.strokeWeight = 1.5;
  badge.strokeAlign = 'OUTSIDE';
  badge.appendChild(makeText(String(number), 11, BOLD, WHITE));
  return badge;
}

function makeOutline(box: Rect, color: RGB): RectangleNode {
  const outline = figma.createRectangle();
  outline.name = 'Outline';
  outline.x = box.x - 3;
  outline.y = box.y - 3;
  outline.resize(box.width + 6, box.height + 6);
  outline.cornerRadius = 4;
  outline.fills = [];
  outline.strokes = [solid(color)];
  outline.strokeWeight = 1.5;
  return outline;
}

// Dashed box that shows how big a touch target should be
function makeNeededSize(box: Rect, color: RGB): RectangleNode {
  const width = Math.max(targetSize, box.width);
  const height = Math.max(targetSize, box.height);
  const needed = figma.createRectangle();
  needed.name = 'Needed size';
  needed.x = box.x + box.width / 2 - width / 2;
  needed.y = box.y + box.height / 2 - height / 2;
  needed.resize(width, height);
  needed.cornerRadius = 4;
  needed.fills = [solid(color, 0.08)];
  needed.strokes = [solid(color)];
  needed.strokeWeight = 1;
  needed.dashPattern = [3, 3];
  return needed;
}

function collectIssues(): Issue[] {
  const issues: Issue[] = [];
  for (const r of lastResults) {
    if (r.status !== 'fail' || r.ignored) continue;
    issues.push({
      id: r.id,
      kind: 'contrast',
      title: r.text.trim() || r.name,
      detail:
        `Contrast ${(r.ratio ?? 0).toFixed(2)}:1 — needs ${r.needed}:1 (${contrastLevel}). ` +
        (r.suggestHex ? `Try ${r.suggestHex}.` : 'Change the background.'),
    });
  }
  for (const t of lastTargets) {
    if (t.status !== 'fail' || t.ignored) continue;
    issues.push({
      id: t.id,
      kind: 'target',
      title: t.name,
      detail: `Touch target ${t.width} × ${t.height} — needs ${targetSize} × ${targetSize}.`,
    });
  }
  return issues;
}

function addLegendRow(legend: FrameNode, number: number, issue: Issue, color: RGB) {
  const row = figma.createFrame();
  row.name = 'Issue ' + number;
  row.layoutMode = 'HORIZONTAL';
  row.itemSpacing = 10;
  row.fills = [];
  row.clipsContent = false;
  legend.appendChild(row);
  row.layoutSizingHorizontal = 'FILL';
  row.layoutSizingVertical = 'HUG';

  row.appendChild(makeBadge(number, color));

  const column = figma.createFrame();
  column.name = 'Text';
  column.layoutMode = 'VERTICAL';
  column.itemSpacing = 2;
  column.fills = [];
  column.clipsContent = false;
  row.appendChild(column);
  column.layoutSizingHorizontal = 'FILL';
  column.layoutSizingVertical = 'HUG';

  const title = issue.title.length > 48 ? issue.title.slice(0, 47) + '…' : issue.title;
  for (const text of [makeText(title, 12, BOLD, INK), makeText(issue.detail, 11, REGULAR, GREY)]) {
    column.appendChild(text);
    text.textAutoResize = 'HEIGHT';
    text.layoutSizingHorizontal = 'FILL';
  }
}

// The legend sits below its screen, so it never covers a screen placed to the right
function makeLegend(screen: SceneNode, box: Rect): FrameNode {
  const legend = figma.createFrame();
  legend.name = 'Accessibility issues — ' + screen.name;
  legend.setPluginData(TAG, screen.id);
  legend.layoutMode = 'VERTICAL';
  legend.resize(Math.min(400, Math.max(280, box.width)), 100);
  legend.counterAxisSizingMode = 'FIXED';
  legend.primaryAxisSizingMode = 'AUTO';
  legend.paddingTop = legend.paddingBottom = 16;
  legend.paddingLeft = legend.paddingRight = 16;
  legend.itemSpacing = 12;
  legend.cornerRadius = 12;
  legend.fills = [solid(WHITE)];
  legend.strokes = [solid(LINE)];
  legend.x = box.x;
  legend.y = box.y + box.height + 40;
  legend.appendChild(makeText('Accessibility issues', 14, BOLD, INK));
  return legend;
}

async function annotate(): Promise<{ markers: number; screens: number }> {
  // Start fresh for the selected screens only. Other screens keep their annotations.
  clearAnnotations(selectedScreenIds());

  const issues = collectIssues();
  if (issues.length === 0) return { markers: 0, screens: 0 };
  await Promise.all([figma.loadFontAsync(REGULAR), figma.loadFontAsync(BOLD)]);

  // Sort the issues by the screen they are on
  type Placed = { issue: Issue; box: Rect };
  const byScreen = new Map<string, { screen: SceneNode; items: Placed[] }>();
  for (const issue of issues) {
    const node = await figma.getNodeByIdAsync(issue.id);
    if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') continue;
    const box = node.absoluteBoundingBox;
    if (!box) continue;
    const screen = screenOf(node);
    let entry = byScreen.get(screen.id);
    if (!entry) {
      entry = { screen, items: [] };
      byScreen.set(screen.id, entry);
    }
    entry.items.push({ issue, box });
  }

  const created: SceneNode[] = [];
  let markers = 0;

  byScreen.forEach(({ screen, items }) => {
    const legend = makeLegend(screen, screen.absoluteBoundingBox ?? items[0].box);
    const nodes: SceneNode[] = [];
    const shown = items.slice(0, MAX_ANNOTATIONS);

    // Numbers start at 1 on every screen
    shown.forEach(({ issue, box }, index) => {
      const color = issue.kind === 'contrast' ? RED : PURPLE;
      if (issue.kind === 'target') nodes.push(makeNeededSize(box, color));
      nodes.push(makeOutline(box, color));
      const badge = makeBadge(index + 1, color);
      badge.x = box.x - 13;
      badge.y = box.y - 13;
      nodes.push(badge);
      addLegendRow(legend, index + 1, issue, color);
    });
    if (items.length > shown.length) {
      legend.appendChild(
        makeText(`+ ${items.length - shown.length} more not shown`, 11, REGULAR, GREY)
      );
    }

    // Markers sit on top of the design, so lock them: clicks still reach the design.
    const group = figma.group(nodes, figma.currentPage);
    group.name = 'Accessibility markers — ' + screen.name;
    group.setPluginData(TAG, screen.id);
    group.locked = true;

    created.push(group, legend);
    markers += shown.length;
  });

  if (created.length > 0) figma.viewport.scrollAndZoomIntoView(created);
  return { markers, screens: byScreen.size };
}

// ---------- Running ----------

const ORDER = { fail: 0, check: 1, pass: 2 };
let ignoreNextSelection = false;
let lastResults: Result[] = [];
let lastTargets: TargetResult[] = [];

// "auto" marks a re-check started by a change on the canvas rather than by the user
function run(auto = false) {
  if (figma.currentPage.selection.length === 0) {
    lastResults = [];
    lastTargets = [];
    figma.ui.postMessage({
      type: 'empty',
      auto,
      targetSize,
      level: contrastLevel,
      ...annotationState(),
    });
    return;
  }
  const nodes = collectTextNodes();
  const results = nodes.slice(0, MAX_NODES).map(checkText);
  results.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] || (a.ratio ?? 0) - (b.ratio ?? 0)
  );
  lastResults = results;

  const targets = collectTargets();
  targets.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      Math.min(a.width, a.height) - Math.min(b.width, b.height)
  );
  lastTargets = targets;

  figma.ui.postMessage({
    type: 'results',
    auto,
    results,
    total: nodes.length,
    targets,
    targetSize,
    level: contrastLevel,
    ...annotationState(),
  });
}

figma.on('selectionchange', () => {
  if (ignoreNextSelection) {
    ignoreNextSelection = false;
    return;
  }
  run();
});

figma.ui.onmessage = async (msg: {
  type: string;
  id?: string;
  size?: number;
  level?: Level;
  scope?: string;
  hex?: string;
  kind?: string;
}) => {
  if (msg.type === 'recheck') run();

  if (msg.type === 'select' && msg.id) {
    const node = await figma.getNodeByIdAsync(msg.id);
    if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
      ignoreNextSelection = true;
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
  }

  if (msg.type === 'set-target' && msg.size) {
    targetSize = msg.size;
    await figma.clientStorage.setAsync('targetSize', targetSize);
    run();
  }

  if (msg.type === 'set-level' && (msg.level === 'AA' || msg.level === 'AAA')) {
    contrastLevel = msg.level;
    await figma.clientStorage.setAsync('contrastLevel', contrastLevel);
    run();
  }

  if ((msg.type === 'ignore' || msg.type === 'restore') && msg.id && msg.kind) {
    const key = IGNORE_KEYS[msg.kind];
    const node = await figma.getNodeByIdAsync(msg.id);
    if (key && node) node.setPluginData(key, msg.type === 'ignore' ? '1' : '');
    run();
  }

  if (msg.type === 'annotate') {
    try {
      const { markers, screens } = await annotate();
      figma.commitUndo();
      figma.notify(
        markers > 0
          ? `Added ${markers} ${markers === 1 ? 'marker' : 'markers'} on ${screens} ${screens === 1 ? 'screen' : 'screens'} ✓  (Cmd+Z to undo)`
          : 'Nothing is failing, so there is nothing to annotate'
      );
    } catch (error) {
      figma.notify('Could not annotate: ' + (error instanceof Error ? error.message : String(error)), {
        error: true,
      });
    }
    run();
  }

  if (msg.type === 'clear-annotations') {
    // "selection" clears only the selected screens; anything else clears the whole page
    const removed =
      msg.scope === 'selection' ? clearAnnotations(selectedScreenIds()) : clearAnnotations();
    figma.commitUndo();
    figma.notify(removed > 0 ? 'Annotations removed' : 'No annotations on this page');
    run();
  }

  if (msg.type === 'apply' && msg.id) {
    const custom = msg.hex ? parseHex(msg.hex) : null;
    const ok = await applyFix(msg.id, custom ?? undefined);
    figma.commitUndo();
    figma.notify(ok ? 'Colour fixed ✓  (Cmd+Z to undo)' : 'Could not fix this layer');
    run();
  }

  if (msg.type === 'fix-all') {
    const ids = lastResults
      .filter((r) => r.status === 'fail' && r.suggestHex && !r.ignored)
      .map((r) => r.id);
    let fixed = 0;
    for (const id of ids) {
      if (await applyFix(id)) fixed++;
    }
    figma.commitUndo();
    figma.notify(`Fixed ${fixed} of ${ids.length} layers ✓  (Cmd+Z to undo)`);
    run();
  }
};

// ---------- Automatic re-check ----------
// When anything on the page changes (a colour, a size, a name, a prototype link),
// wait until the changes stop for a moment, then check again.

let recheckTimer: number | undefined;

function scheduleRecheck() {
  if (recheckTimer !== undefined) clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => {
    recheckTimer = undefined;
    run(true);
  }, 400);
}

let watchedPage: PageNode | null = null;

function watchCurrentPage() {
  if (watchedPage) {
    try {
      watchedPage.off('nodechange', scheduleRecheck);
    } catch (error) {
      // The old page may no longer be loaded; nothing to stop watching then
    }
  }
  watchedPage = figma.currentPage;
  watchedPage.on('nodechange', scheduleRecheck);
}

figma.on('currentpagechange', () => {
  watchCurrentPage();
  run();
});
watchCurrentPage();

// Remember the settings chosen last time, then run the first check
Promise.all([
  figma.clientStorage.getAsync('targetSize'),
  figma.clientStorage.getAsync('contrastLevel'),
]).then(
  ([size, level]) => {
    if (size === 24 || size === 44 || size === 48) targetSize = size;
    if (level === 'AA' || level === 'AAA') contrastLevel = level;
    run();
  },
  () => run()
);
