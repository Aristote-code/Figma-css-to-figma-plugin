import type {
  Layer,
  FrameLayer,
  RectangleLayer,
  TextLayer,
  SvgLayer,
  ImageLayer,
  Paint as PaintDTO,
  TextStyleRun,
  UIToPluginMessage,
  PluginToUIMessage,
} from "../../../shared/types";

figma.showUI(__html__, { width: 340, height: 560, themeColors: true });

figma.ui.onmessage = async (msg: UIToPluginMessage) => {
  if (msg.type === "CANCEL") {
    figma.closePlugin();
    return;
  }
  if (msg.type === "CREATE_DESIGN") {
    try {
      await buildFromLayers(msg.layers, msg.imageMap, msg.pageTitle);
    } catch (err: any) {
      console.error(err);
      post({ type: "ERROR", error: err?.message || String(err) });
    }
  }
};

function post(msg: PluginToUIMessage) {
  figma.ui.postMessage(msg);
}

// ------------------------------------------------------------------
// Font matching
// ------------------------------------------------------------------

// Cached font registry: family (lowercased, normalized) → Map<styleKey, FontName>
type FontRegistry = Map<string, Map<string, FontName>>;
let fontRegistry: FontRegistry | null = null;
const loadedFonts = new Set<string>(); // "family|style"

async function buildFontRegistry(): Promise<FontRegistry> {
  if (fontRegistry) return fontRegistry;
  const available = await figma.listAvailableFontsAsync();
  const reg: FontRegistry = new Map();
  for (const f of available) {
    const fam = normalizeFamily(f.fontName.family);
    let styles = reg.get(fam);
    if (!styles) { styles = new Map(); reg.set(fam, styles); }
    styles.set(normalizeStyleKey(f.fontName.style), f.fontName);
  }
  fontRegistry = reg;
  return reg;
}

function normalizeFamily(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function normalizeStyleKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

const WEIGHT_NAMES: { [k: number]: string[] } = {
  100: ["thin", "hairline"],
  200: ["extralight", "ultralight"],
  300: ["light"],
  400: ["regular", "normal", "book"],
  500: ["medium"],
  600: ["semibold", "demibold"],
  700: ["bold"],
  800: ["extrabold", "ultrabold", "heavy"],
  900: ["black", "heavy"],
};

function desiredStyleKeys(weight: number, italic: boolean): string[] {
  // Snap weight to nearest 100
  const w = Math.max(100, Math.min(900, Math.round(weight / 100) * 100));
  const names = WEIGHT_NAMES[w] || ["regular"];
  const keys: string[] = [];
  for (const n of names) {
    keys.push(italic ? n + "italic" : n);
    if (italic) keys.push(n); // italic fallback to non-italic
  }
  if (italic) keys.push("italic"); // plain "Italic" style
  if (w === 400 && italic) keys.unshift("italic");
  return keys;
}

async function resolveFont(family: string, weight: number, italic: boolean): Promise<FontName> {
  const reg = await buildFontRegistry();
  const fallback: FontName = { family: "Inter", style: "Regular" };

  // Try requested family first, then Inter, then Roboto, then Arial
  const tries = [family, "Inter", "Roboto", "Arial", "Helvetica"];
  for (const fam of tries) {
    const styles = reg.get(normalizeFamily(fam));
    if (!styles) continue;
    for (const key of desiredStyleKeys(weight, italic)) {
      const fn = styles.get(key);
      if (fn) return fn;
    }
    // Any regular style of that family as last resort
    const reg400 = styles.get("regular") || styles.get("normal");
    if (reg400) return reg400;
    // Or literally any style
    const any = styles.values().next().value as FontName | undefined;
    if (any) return any;
  }
  return fallback;
}

async function ensureLoaded(font: FontName): Promise<FontName> {
  const key = font.family + "|" + font.style;
  if (loadedFonts.has(key)) return font;
  try {
    await figma.loadFontAsync(font);
    loadedFonts.add(key);
    return font;
  } catch {
    const fb: FontName = { family: "Inter", style: "Regular" };
    await figma.loadFontAsync(fb);
    loadedFonts.add("Inter|Regular");
    return fb;
  }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function buildFromLayers(
  layers: Layer[],
  imageMap: Record<string, number[]>,
  pageTitle: string
) {
  post({ type: "PROGRESS", step: "Loading fonts..." });
  await preloadFonts(layers);

  post({ type: "PROGRESS", step: "Uploading images..." });
  const imageHashes = await uploadImages(imageMap);

  post({ type: "PROGRESS", step: "Creating Figma layers..." });

  const childrenMap = new Map<string | null, Layer[]>();
  for (const l of layers) {
    const arr = childrenMap.get(l.parentId) ?? [];
    arr.push(l);
    childrenMap.set(l.parentId, arr);
  }

  const roots = childrenMap.get(null) ?? [];
  if (roots.length === 0) throw new Error("No root layer found");

  const createdRoots: SceneNode[] = [];
  for (const rootLayer of roots) {
    const node = await buildNode(rootLayer, childrenMap, imageHashes);
    if (node) {
      figma.currentPage.appendChild(node);
      createdRoots.push(node);
    }
  }

  // Position roots side-by-side next to the current viewport
  let xOffset = figma.viewport.center.x;
  for (const root of createdRoots) {
    if ("x" in root) {
      (root as any).x = xOffset;
      (root as any).y = figma.viewport.center.y - 100;
      xOffset += ((root as any).width || 0) + 80;
    }
  }

  figma.viewport.scrollAndZoomIntoView(createdRoots);
  figma.currentPage.selection = createdRoots;

  post({ type: "DONE", rootNodeId: createdRoots[0]?.id ?? "" });
  figma.notify(`Imported "${pageTitle}" (${layers.length} layers)`);
}

// ------------------------------------------------------------------
// Preload fonts
// ------------------------------------------------------------------

async function preloadFonts(layers: Layer[]) {
  const needed = new Map<string, { family: string; weight: number; italic: boolean }>();
  function addNeed(family: string, weight: number, italic: boolean) {
    const k = family + "|" + weight + "|" + italic;
    if (!needed.has(k)) needed.set(k, { family, weight, italic });
  }
  for (const l of layers) {
    if (l.type !== "TEXT") continue;
    addNeed(l.fontFamily, l.fontWeight, l.italic);
    if (l.styleRuns) {
      for (const r of l.styleRuns) {
        addNeed(
          r.fontFamily ?? l.fontFamily,
          r.fontWeight ?? l.fontWeight,
          r.italic ?? l.italic
        );
      }
    }
  }
  // Always include the ultimate fallback
  addNeed("Inter", 400, false);

  const fonts = await Promise.all(
    [...needed.values()].map((n) => resolveFont(n.family, n.weight, n.italic))
  );
  const uniq = new Map<string, FontName>();
  for (const f of fonts) uniq.set(f.family + "|" + f.style, f);
  await Promise.all(
    [...uniq.values()].map((f) =>
      figma.loadFontAsync(f).then(() => {
        loadedFonts.add(f.family + "|" + f.style);
      }).catch(() => {})
    )
  );
}

// ------------------------------------------------------------------
// Image upload
// ------------------------------------------------------------------

async function uploadImages(
  imageMap: Record<string, number[]>
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const url of Object.keys(imageMap)) {
    try {
      const image = figma.createImage(new Uint8Array(imageMap[url]));
      hashes.set(url, image.hash);
    } catch {}
  }
  return hashes;
}

// ------------------------------------------------------------------
// Node builder
// ------------------------------------------------------------------

async function buildNode(
  layer: Layer,
  childrenMap: Map<string | null, Layer[]>,
  imageHashes: Map<string, string>
): Promise<SceneNode | null> {
  let node: SceneNode;

  switch (layer.type) {
    case "TEXT":
      node = await buildText(layer);
      break;
    case "IMAGE":
      node = buildImage(layer, imageHashes);
      break;
    case "SVG":
      node = buildSvg(layer);
      break;
    case "RECTANGLE":
      node = buildRectangle(layer, imageHashes);
      break;
    case "FRAME":
    default:
      node = buildFrame(layer as FrameLayer, imageHashes);
      break;
  }

  node.name = layer.name;
  if ("opacity" in node) (node as any).opacity = layer.opacity;
  if ("visible" in node) (node as any).visible = layer.visible;
  if ("rotation" in node && layer.rotation) {
    try { (node as any).rotation = -layer.rotation; } catch {}
  }
  setPositionAndSize(node, layer);

  if (layer.type === "FRAME") {
    const frameLayer = layer as FrameLayer;
    const kids = childrenMap.get(layer.id) ?? [];

    // Decide auto-layout viability
    const al = frameLayer.autoLayout;
    const useAL = !!al && kids.length > 0 && kidsFitAutoLayout(kids, al, frameLayer);

    // Sort: for AL, by main-axis position; otherwise keep zIndex order (stacking).
    if (useAL) {
      kids.sort((a, b) =>
        al!.direction === "VERTICAL" ? a.y - b.y : a.x - b.x
      );
    } else {
      kids.sort((a, b) => a.zIndex - b.zIndex);
    }

    const frameNode = node as FrameNode;
    for (const child of kids) {
      const childNode = await buildNode(child, childrenMap, imageHashes);
      if (!childNode) continue;
      frameNode.appendChild(childNode);
      if ("x" in childNode) {
        (childNode as any).x = child.x - layer.x;
        (childNode as any).y = child.y - layer.y;
      }
    }

    if (useAL) {
      try {
        applyAutoLayout(frameNode, al!);
      } catch (e) {
        console.warn("applyAutoLayout failed:", layer.name, e);
      }
    }
  }

  return node;
}

function setPositionAndSize(node: SceneNode, layer: Layer) {
  if ("x" in node) {
    (node as any).x = layer.x;
    (node as any).y = layer.y;
  }
  if ("resize" in node && typeof (node as any).resize === "function") {
    const w = Math.max(1, layer.width);
    const h = Math.max(1, layer.height);
    try { (node as any).resize(w, h); } catch {}
  }
}

// Check whether kids can be expressed by Auto Layout without distortion:
// - All must roughly align on the counter-axis (same row for horizontal, same column for vertical)
// - None can overlap
function kidsFitAutoLayout(kids: Layer[], al: NonNullable<FrameLayer["autoLayout"]>, parent: FrameLayer): boolean {
  if (kids.length < 2) return true;
  const sorted = [...kids].sort((a, b) =>
    al.direction === "VERTICAL" ? a.y - b.y : a.x - b.x
  );
  // Check no main-axis overlap > small epsilon
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (al.direction === "VERTICAL") {
      if (a.y + a.height > b.y + 4) return false;
    } else {
      if (a.x + a.width > b.x + 4) return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------
// Frame / Rectangle
// ------------------------------------------------------------------

function buildFrame(layer: FrameLayer, imageHashes: Map<string, string>): FrameNode {
  const frame = figma.createFrame();
  applyFills(frame, layer.fills, imageHashes);
  applyStrokes(frame, layer.strokes);
  applyEffects(frame, layer.effects);
  applyCornerRadius(frame, layer.cornerRadius);
  frame.clipsContent = layer.clipsContent;
  if (layer.fills.length === 0) frame.fills = [];
  return frame;
}

function applyAutoLayout(frame: FrameNode, al: NonNullable<FrameLayer["autoLayout"]>) {
  frame.layoutMode = al.direction;
  frame.itemSpacing = Math.max(0, al.itemSpacing);
  frame.paddingTop = al.paddingTop;
  frame.paddingRight = al.paddingRight;
  frame.paddingBottom = al.paddingBottom;
  frame.paddingLeft = al.paddingLeft;
  frame.primaryAxisAlignItems = al.primaryAxisAlign as any;
  frame.counterAxisAlignItems = al.counterAxisAlign as any;
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  if (al.wrap) {
    try { (frame as any).layoutWrap = "WRAP"; } catch {}
  }
}

function buildRectangle(layer: RectangleLayer, imageHashes: Map<string, string>): RectangleNode {
  const rect = figma.createRectangle();
  applyFills(rect, layer.fills, imageHashes);
  applyStrokes(rect, layer.strokes);
  applyEffects(rect, layer.effects);
  applyCornerRadius(rect, layer.cornerRadius);
  return rect;
}

// ------------------------------------------------------------------
// Text
// ------------------------------------------------------------------

async function buildText(layer: TextLayer): Promise<TextNode> {
  const text = figma.createText();

  // Base font
  const baseFont = await ensureLoaded(
    await resolveFont(layer.fontFamily, layer.fontWeight, layer.italic)
  );
  text.fontName = baseFont;
  text.fontSize = Math.max(1, layer.fontSize);
  text.characters = layer.characters || " ";

  // Line height
  if (layer.lineHeight.unit === "PIXELS" && isFinite(layer.lineHeight.value) && layer.lineHeight.value > 0) {
    text.lineHeight = { unit: "PIXELS", value: layer.lineHeight.value };
  } else {
    text.lineHeight = { unit: "AUTO" };
  }

  if (layer.letterSpacing) {
    text.letterSpacing = { unit: "PIXELS", value: layer.letterSpacing };
  }

  text.textAlignHorizontal = layer.textAlignHorizontal as any;
  text.textAlignVertical = layer.textAlignVertical as any;
  text.textCase = layer.textCase as any;
  text.textDecoration = (layer.textDecoration === "NONE" ? "NONE" : layer.textDecoration) as any;

  text.fills = [{
    type: "SOLID",
    color: { r: layer.color.r, g: layer.color.g, b: layer.color.b },
    opacity: layer.color.a,
  }];

  // Apply per-range style overrides (bold words, colored links, etc.)
  if (layer.styleRuns && layer.styleRuns.length) {
    await applyStyleRuns(text, layer, layer.styleRuns);
  }

  // Adaptive auto-resize: single-line = grow naturally; wrapped = fixed width, grow height.
  if (layer.singleLine) {
    text.textAutoResize = "WIDTH_AND_HEIGHT";
  } else {
    try {
      text.resize(Math.max(1, layer.width), Math.max(1, layer.height));
    } catch {}
    text.textAutoResize = "HEIGHT";
  }

  return text;
}

async function applyStyleRuns(text: TextNode, layer: TextLayer, runs: TextStyleRun[]) {
  const len = text.characters.length;
  for (const run of runs) {
    const s = Math.max(0, Math.min(len, run.start));
    const e = Math.max(s, Math.min(len, run.end));
    if (s >= e) continue;

    const family = run.fontFamily ?? layer.fontFamily;
    const weight = run.fontWeight ?? layer.fontWeight;
    const italic = run.italic ?? layer.italic;
    const font = await ensureLoaded(await resolveFont(family, weight, italic));
    try { text.setRangeFontName(s, e, font); } catch {}

    if (run.fontSize && run.fontSize > 0) {
      try { text.setRangeFontSize(s, e, run.fontSize); } catch {}
    }
    if (run.color) {
      try {
        text.setRangeFills(s, e, [{
          type: "SOLID",
          color: { r: run.color.r, g: run.color.g, b: run.color.b },
          opacity: run.color.a,
        }]);
      } catch {}
    }
    if (run.textDecoration && run.textDecoration !== "NONE") {
      try { text.setRangeTextDecoration(s, e, run.textDecoration as any); } catch {}
    }
    if (typeof run.letterSpacing === "number") {
      try { text.setRangeLetterSpacing(s, e, { unit: "PIXELS", value: run.letterSpacing }); } catch {}
    }
  }
}

// ------------------------------------------------------------------
// SVG / Image
// ------------------------------------------------------------------

function buildSvg(layer: SvgLayer): SceneNode {
  try {
    return figma.createNodeFromSvg(layer.svg);
  } catch {
    const r = figma.createRectangle();
    r.fills = [];
    return r;
  }
}

function buildImage(layer: ImageLayer, imageHashes: Map<string, string>): RectangleNode {
  const rect = figma.createRectangle();
  const hash = imageHashes.get(layer.imageUrl);
  if (hash) {
    rect.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: layer.scaleMode as any }];
  } else {
    rect.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
  }
  applyCornerRadius(rect, layer.cornerRadius);
  return rect;
}

// ------------------------------------------------------------------
// Fills / Strokes / Effects / Radii
// ------------------------------------------------------------------

function applyFills(
  node: FrameNode | RectangleNode,
  fills: PaintDTO[],
  imageHashes: Map<string, string>
) {
  const out: Paint[] = [];
  for (const f of fills) {
    if (f.type === "SOLID") {
      out.push({
        type: "SOLID",
        color: { r: f.color.r, g: f.color.g, b: f.color.b },
        opacity: f.opacity,
      });
    } else if (f.type === "IMAGE") {
      const hash = imageHashes.get(f.imageUrl);
      if (hash) {
        out.push({ type: "IMAGE", imageHash: hash, scaleMode: f.scaleMode as any });
      }
    } else if (f.type === "GRADIENT_LINEAR") {
      out.push(linearGradientToFigma(f.angle, f.stops));
    }
  }
  if (out.length) node.fills = out;
}

function linearGradientToFigma(
  angleDeg: number,
  stops: { position: number; color: { r: number; g: number; b: number; a: number } }[]
): GradientPaint {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const t: Transform = [
    [cos, sin, (1 - cos - sin) / 2],
    [-sin, cos, (1 + sin - cos) / 2],
  ];
  const clean = stops
    .map((s) => ({
      position: Math.max(0, Math.min(1, isFinite(s.position) ? s.position : 0)),
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    }))
    .sort((a, b) => a.position - b.position);
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].position <= clean[i - 1].position) {
      clean[i].position = Math.min(1, clean[i - 1].position + 0.0001);
    }
  }
  if (clean.length < 2) clean.push({ position: 1, color: { r: 0, g: 0, b: 0, a: 0 } });
  return { type: "GRADIENT_LINEAR", gradientTransform: t, gradientStops: clean };
}

function applyStrokes(
  node: FrameNode | RectangleNode,
  strokes: { color: { r: number; g: number; b: number; a: number }; width: number; style: string; sides: any }[]
) {
  if (!strokes || !strokes.length) return;
  const s = strokes[0];
  node.strokes = [{
    type: "SOLID",
    color: { r: s.color.r, g: s.color.g, b: s.color.b },
    opacity: s.color.a,
  }];
  node.strokeWeight = Math.max(0.5, s.width);
  node.strokeAlign = "INSIDE";
  if (s.style === "DASHED") node.dashPattern = [4, 2];
  else if (s.style === "DOTTED") node.dashPattern = [1, 2];

  // Asymmetric borders: if one side is 0 but others aren't, use individual side widths
  if ("strokeTopWeight" in node && s.sides) {
    const { top, right, bottom, left } = s.sides;
    const sameAll = top === right && right === bottom && bottom === left;
    if (!sameAll) {
      try {
        (node as any).strokeTopWeight = Math.max(0, top);
        (node as any).strokeRightWeight = Math.max(0, right);
        (node as any).strokeBottomWeight = Math.max(0, bottom);
        (node as any).strokeLeftWeight = Math.max(0, left);
      } catch {}
    }
  }
}

function applyEffects(
  node: FrameNode | RectangleNode,
  effects: {
    type: string;
    color?: { r: number; g: number; b: number; a: number };
    offsetX?: number;
    offsetY?: number;
    radius: number;
    spread?: number;
  }[]
) {
  if (!effects || !effects.length) return;
  const out: Effect[] = [];
  for (const e of effects) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      out.push({
        type: e.type as "DROP_SHADOW" | "INNER_SHADOW",
        color: e.color
          ? { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a }
          : { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: e.offsetX || 0, y: e.offsetY || 0 },
        radius: e.radius,
        spread: e.spread || 0,
        visible: true,
        blendMode: "NORMAL",
      });
    } else if (e.type === "LAYER_BLUR") {
      out.push({ type: "LAYER_BLUR", radius: e.radius, visible: true });
    }
  }
  node.effects = out;
}

function applyCornerRadius(
  node: FrameNode | RectangleNode,
  cornerRadius: number | [number, number, number, number]
) {
  if (typeof cornerRadius === "number") {
    if (cornerRadius > 0) node.cornerRadius = cornerRadius;
  } else if (Array.isArray(cornerRadius)) {
    node.topLeftRadius = cornerRadius[0] || 0;
    node.topRightRadius = cornerRadius[1] || 0;
    node.bottomRightRadius = cornerRadius[2] || 0;
    node.bottomLeftRadius = cornerRadius[3] || 0;
  }
}
