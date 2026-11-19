(function() {
  "use strict";
  figma.showUI(__html__, { width: 340, height: 560, themeColors: true });
  figma.ui.onmessage = async (msg) => {
    if (msg.type === "CANCEL") {
      figma.closePlugin();
      return;
    }
    if (msg.type === "CREATE_DESIGN") {
      try {
        await buildFromLayers(msg.layers, msg.imageMap, msg.pageTitle);
      } catch (err) {
        console.error(err);
        post({ type: "ERROR", error: (err == null ? void 0 : err.message) || String(err) });
      }
    }
  };
  function post(msg) {
    figma.ui.postMessage(msg);
  }
  let fontRegistry = null;
  const loadedFonts = /* @__PURE__ */ new Set();
  async function buildFontRegistry() {
    if (fontRegistry) return fontRegistry;
    const available = await figma.listAvailableFontsAsync();
    const reg = /* @__PURE__ */ new Map();
    for (const f of available) {
      const fam = normalizeFamily(f.fontName.family);
      let styles = reg.get(fam);
      if (!styles) {
        styles = /* @__PURE__ */ new Map();
        reg.set(fam, styles);
      }
      styles.set(normalizeStyleKey(f.fontName.style), f.fontName);
    }
    fontRegistry = reg;
    return reg;
  }
  function normalizeFamily(s) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function normalizeStyleKey(s) {
    return s.toLowerCase().replace(/[^a-z]/g, "");
  }
  const WEIGHT_NAMES = {
    100: ["thin", "hairline"],
    200: ["extralight", "ultralight"],
    300: ["light"],
    400: ["regular", "normal", "book"],
    500: ["medium"],
    600: ["semibold", "demibold"],
    700: ["bold"],
    800: ["extrabold", "ultrabold", "heavy"],
    900: ["black", "heavy"]
  };
  function desiredStyleKeys(weight, italic) {
    const w = Math.max(100, Math.min(900, Math.round(weight / 100) * 100));
    const names = WEIGHT_NAMES[w] || ["regular"];
    const keys = [];
    for (const n of names) {
      keys.push(italic ? n + "italic" : n);
      if (italic) keys.push(n);
    }
    if (italic) keys.push("italic");
    if (w === 400 && italic) keys.unshift("italic");
    return keys;
  }
  async function resolveFont(family, weight, italic) {
    const reg = await buildFontRegistry();
    const fallback = { family: "Inter", style: "Regular" };
    const tries = [family, "Inter", "Roboto", "Arial", "Helvetica"];
    for (const fam of tries) {
      const styles = reg.get(normalizeFamily(fam));
      if (!styles) continue;
      for (const key of desiredStyleKeys(weight, italic)) {
        const fn = styles.get(key);
        if (fn) return fn;
      }
      const reg400 = styles.get("regular") || styles.get("normal");
      if (reg400) return reg400;
      const any = styles.values().next().value;
      if (any) return any;
    }
    return fallback;
  }
  async function ensureLoaded(font) {
    const key = font.family + "|" + font.style;
    if (loadedFonts.has(key)) return font;
    try {
      await figma.loadFontAsync(font);
      loadedFonts.add(key);
      return font;
    } catch (e) {
      const fb = { family: "Inter", style: "Regular" };
      await figma.loadFontAsync(fb);
      loadedFonts.add("Inter|Regular");
      return fb;
    }
  }
  async function buildFromLayers(layers, imageMap, pageTitle) {
    var _a, _b, _c, _d;
    post({ type: "PROGRESS", step: "Loading fonts..." });
    await preloadFonts(layers);
    post({ type: "PROGRESS", step: "Uploading images..." });
    const imageHashes = await uploadImages(imageMap);
    post({ type: "PROGRESS", step: "Creating Figma layers..." });
    const childrenMap = /* @__PURE__ */ new Map();
    for (const l of layers) {
      const arr = (_a = childrenMap.get(l.parentId)) != null ? _a : [];
      arr.push(l);
      childrenMap.set(l.parentId, arr);
    }
    const roots = (_b = childrenMap.get(null)) != null ? _b : [];
    if (roots.length === 0) throw new Error("No root layer found");
    const createdRoots = [];
    for (const rootLayer of roots) {
      const node = await buildNode(rootLayer, childrenMap, imageHashes);
      if (node) {
        figma.currentPage.appendChild(node);
        createdRoots.push(node);
      }
    }
    let xOffset = figma.viewport.center.x;
    for (const root of createdRoots) {
      if ("x" in root) {
        root.x = xOffset;
        root.y = figma.viewport.center.y - 100;
        xOffset += (root.width || 0) + 80;
      }
    }
    figma.viewport.scrollAndZoomIntoView(createdRoots);
    figma.currentPage.selection = createdRoots;
    post({ type: "DONE", rootNodeId: (_d = (_c = createdRoots[0]) == null ? void 0 : _c.id) != null ? _d : "" });
    figma.notify(`Imported "${pageTitle}" (${layers.length} layers)`);
  }
  async function preloadFonts(layers) {
    var _a, _b, _c;
    const needed = /* @__PURE__ */ new Map();
    function addNeed(family, weight, italic) {
      const k = family + "|" + weight + "|" + italic;
      if (!needed.has(k)) needed.set(k, { family, weight, italic });
    }
    for (const l of layers) {
      if (l.type !== "TEXT") continue;
      addNeed(l.fontFamily, l.fontWeight, l.italic);
      if (l.styleRuns) {
        for (const r of l.styleRuns) {
          addNeed(
            (_a = r.fontFamily) != null ? _a : l.fontFamily,
            (_b = r.fontWeight) != null ? _b : l.fontWeight,
            (_c = r.italic) != null ? _c : l.italic
          );
        }
      }
    }
    addNeed("Inter", 400, false);
    const fonts = await Promise.all(
      [...needed.values()].map((n) => resolveFont(n.family, n.weight, n.italic))
    );
    const uniq = /* @__PURE__ */ new Map();
    for (const f of fonts) uniq.set(f.family + "|" + f.style, f);
    await Promise.all(
      [...uniq.values()].map(
        (f) => figma.loadFontAsync(f).then(() => {
          loadedFonts.add(f.family + "|" + f.style);
        }).catch(() => {
        })
      )
    );
  }
  async function uploadImages(imageMap) {
    const hashes = /* @__PURE__ */ new Map();
    for (const url of Object.keys(imageMap)) {
      try {
        const image = figma.createImage(new Uint8Array(imageMap[url]));
        hashes.set(url, image.hash);
      } catch (e) {
      }
    }
    return hashes;
  }
  async function buildNode(layer, childrenMap, imageHashes) {
    var _a;
    let node;
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
        node = buildFrame(layer, imageHashes);
        break;
    }
    node.name = layer.name;
    if ("opacity" in node) node.opacity = layer.opacity;
    if ("visible" in node) node.visible = layer.visible;
    if ("rotation" in node && layer.rotation) {
      try {
        node.rotation = -layer.rotation;
      } catch (e) {
      }
    }
    setPositionAndSize(node, layer);
    if (layer.type === "FRAME") {
      const frameLayer = layer;
      const kids = (_a = childrenMap.get(layer.id)) != null ? _a : [];
      const al = frameLayer.autoLayout;
      const useAL = !!al && kids.length > 0 && kidsFitAutoLayout(kids, al);
      if (useAL) {
        kids.sort(
          (a, b) => al.direction === "VERTICAL" ? a.y - b.y : a.x - b.x
        );
      } else {
        kids.sort((a, b) => a.zIndex - b.zIndex);
      }
      const frameNode = node;
      for (const child of kids) {
        const childNode = await buildNode(child, childrenMap, imageHashes);
        if (!childNode) continue;
        frameNode.appendChild(childNode);
        if ("x" in childNode) {
          childNode.x = child.x - layer.x;
          childNode.y = child.y - layer.y;
        }
      }
      if (useAL) {
        try {
          applyAutoLayout(frameNode, al);
        } catch (e) {
          console.warn("applyAutoLayout failed:", layer.name, e);
        }
      }
    }
    return node;
  }
  function setPositionAndSize(node, layer) {
    if ("x" in node) {
      node.x = layer.x;
      node.y = layer.y;
    }
    if ("resize" in node && typeof node.resize === "function") {
      const w = Math.max(1, layer.width);
      const h = Math.max(1, layer.height);
      try {
        node.resize(w, h);
      } catch (e) {
      }
    }
  }
  function kidsFitAutoLayout(kids, al, parent) {
    if (kids.length < 2) return true;
    const sorted = [...kids].sort(
      (a, b) => al.direction === "VERTICAL" ? a.y - b.y : a.x - b.x
    );
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
  function buildFrame(layer, imageHashes) {
    const frame = figma.createFrame();
    applyFills(frame, layer.fills, imageHashes);
    applyStrokes(frame, layer.strokes);
    applyEffects(frame, layer.effects);
    applyCornerRadius(frame, layer.cornerRadius);
    frame.clipsContent = layer.clipsContent;
    if (layer.fills.length === 0) frame.fills = [];
    return frame;
  }
  function applyAutoLayout(frame, al) {
    frame.layoutMode = al.direction;
    frame.itemSpacing = Math.max(0, al.itemSpacing);
    frame.paddingTop = al.paddingTop;
    frame.paddingRight = al.paddingRight;
    frame.paddingBottom = al.paddingBottom;
    frame.paddingLeft = al.paddingLeft;
    frame.primaryAxisAlignItems = al.primaryAxisAlign;
    frame.counterAxisAlignItems = al.counterAxisAlign;
    frame.primaryAxisSizingMode = "FIXED";
    frame.counterAxisSizingMode = "FIXED";
    if (al.wrap) {
      try {
        frame.layoutWrap = "WRAP";
      } catch (e) {
      }
    }
  }
  function buildRectangle(layer, imageHashes) {
    const rect = figma.createRectangle();
    applyFills(rect, layer.fills, imageHashes);
    applyStrokes(rect, layer.strokes);
    applyEffects(rect, layer.effects);
    applyCornerRadius(rect, layer.cornerRadius);
    return rect;
  }
  async function buildText(layer) {
    const text = figma.createText();
    const baseFont = await ensureLoaded(
      await resolveFont(layer.fontFamily, layer.fontWeight, layer.italic)
    );
    text.fontName = baseFont;
    text.fontSize = Math.max(1, layer.fontSize);
    text.characters = layer.characters || " ";
    if (layer.lineHeight.unit === "PIXELS" && isFinite(layer.lineHeight.value) && layer.lineHeight.value > 0) {
      text.lineHeight = { unit: "PIXELS", value: layer.lineHeight.value };
    } else {
      text.lineHeight = { unit: "AUTO" };
    }
    if (layer.letterSpacing) {
      text.letterSpacing = { unit: "PIXELS", value: layer.letterSpacing };
    }
    text.textAlignHorizontal = layer.textAlignHorizontal;
    text.textAlignVertical = layer.textAlignVertical;
    text.textCase = layer.textCase;
    text.textDecoration = layer.textDecoration === "NONE" ? "NONE" : layer.textDecoration;
    text.fills = [{
      type: "SOLID",
      color: { r: layer.color.r, g: layer.color.g, b: layer.color.b },
      opacity: layer.color.a
    }];
    if (layer.styleRuns && layer.styleRuns.length) {
      await applyStyleRuns(text, layer, layer.styleRuns);
    }
    if (layer.singleLine) {
      text.textAutoResize = "WIDTH_AND_HEIGHT";
    } else {
      try {
        text.resize(Math.max(1, layer.width), Math.max(1, layer.height));
      } catch (e) {
      }
      text.textAutoResize = "HEIGHT";
    }
    return text;
  }
  async function applyStyleRuns(text, layer, runs) {
    var _a, _b, _c;
    const len = text.characters.length;
    for (const run of runs) {
      const s = Math.max(0, Math.min(len, run.start));
      const e = Math.max(s, Math.min(len, run.end));
      if (s >= e) continue;
      const family = (_a = run.fontFamily) != null ? _a : layer.fontFamily;
      const weight = (_b = run.fontWeight) != null ? _b : layer.fontWeight;
      const italic = (_c = run.italic) != null ? _c : layer.italic;
      const font = await ensureLoaded(await resolveFont(family, weight, italic));
      try {
        text.setRangeFontName(s, e, font);
      } catch (e2) {
      }
      if (run.fontSize && run.fontSize > 0) {
        try {
          text.setRangeFontSize(s, e, run.fontSize);
        } catch (e2) {
        }
      }
      if (run.color) {
        try {
          text.setRangeFills(s, e, [{
            type: "SOLID",
            color: { r: run.color.r, g: run.color.g, b: run.color.b },
            opacity: run.color.a
          }]);
        } catch (e2) {
        }
      }
      if (run.textDecoration && run.textDecoration !== "NONE") {
        try {
          text.setRangeTextDecoration(s, e, run.textDecoration);
        } catch (e2) {
        }
      }
      if (typeof run.letterSpacing === "number") {
        try {
          text.setRangeLetterSpacing(s, e, { unit: "PIXELS", value: run.letterSpacing });
        } catch (e2) {
        }
      }
    }
  }
  function buildSvg(layer) {
    try {
      return figma.createNodeFromSvg(layer.svg);
    } catch (e) {
      const r = figma.createRectangle();
      r.fills = [];
      return r;
    }
  }
  function buildImage(layer, imageHashes) {
    const rect = figma.createRectangle();
    const hash = imageHashes.get(layer.imageUrl);
    if (hash) {
      rect.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: layer.scaleMode }];
    } else {
      rect.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
    }
    applyCornerRadius(rect, layer.cornerRadius);
    return rect;
  }
  function applyFills(node, fills, imageHashes) {
    const out = [];
    for (const f of fills) {
      if (f.type === "SOLID") {
        out.push({
          type: "SOLID",
          color: { r: f.color.r, g: f.color.g, b: f.color.b },
          opacity: f.opacity
        });
      } else if (f.type === "IMAGE") {
        const hash = imageHashes.get(f.imageUrl);
        if (hash) {
          out.push({ type: "IMAGE", imageHash: hash, scaleMode: f.scaleMode });
        }
      } else if (f.type === "GRADIENT_LINEAR") {
        out.push(linearGradientToFigma(f.angle, f.stops));
      }
    }
    if (out.length) node.fills = out;
  }
  function linearGradientToFigma(angleDeg, stops) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const t = [
      [cos, sin, (1 - cos - sin) / 2],
      [-sin, cos, (1 + sin - cos) / 2]
    ];
    const clean = stops.map((s) => ({
      position: Math.max(0, Math.min(1, isFinite(s.position) ? s.position : 0)),
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a }
    })).sort((a, b) => a.position - b.position);
    for (let i = 1; i < clean.length; i++) {
      if (clean[i].position <= clean[i - 1].position) {
        clean[i].position = Math.min(1, clean[i - 1].position + 1e-4);
      }
    }
    if (clean.length < 2) clean.push({ position: 1, color: { r: 0, g: 0, b: 0, a: 0 } });
    return { type: "GRADIENT_LINEAR", gradientTransform: t, gradientStops: clean };
  }
  function applyStrokes(node, strokes) {
    if (!strokes || !strokes.length) return;
    const s = strokes[0];
    node.strokes = [{
      type: "SOLID",
      color: { r: s.color.r, g: s.color.g, b: s.color.b },
      opacity: s.color.a
    }];
    node.strokeWeight = Math.max(0.5, s.width);
    node.strokeAlign = "INSIDE";
    if (s.style === "DASHED") node.dashPattern = [4, 2];
    else if (s.style === "DOTTED") node.dashPattern = [1, 2];
    if ("strokeTopWeight" in node && s.sides) {
      const { top, right, bottom, left } = s.sides;
      const sameAll = top === right && right === bottom && bottom === left;
      if (!sameAll) {
        try {
          node.strokeTopWeight = Math.max(0, top);
          node.strokeRightWeight = Math.max(0, right);
          node.strokeBottomWeight = Math.max(0, bottom);
          node.strokeLeftWeight = Math.max(0, left);
        } catch (e) {
        }
      }
    }
  }
  function applyEffects(node, effects) {
    if (!effects || !effects.length) return;
    const out = [];
    for (const e of effects) {
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        out.push({
          type: e.type,
          color: e.color ? { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a } : { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: e.offsetX || 0, y: e.offsetY || 0 },
          radius: e.radius,
          spread: e.spread || 0,
          visible: true,
          blendMode: "NORMAL"
        });
      } else if (e.type === "LAYER_BLUR") {
        out.push({ type: "LAYER_BLUR", radius: e.radius, visible: true });
      }
    }
    node.effects = out;
  }
  function applyCornerRadius(node, cornerRadius) {
    if (typeof cornerRadius === "number") {
      if (cornerRadius > 0) node.cornerRadius = cornerRadius;
    } else if (Array.isArray(cornerRadius)) {
      node.topLeftRadius = cornerRadius[0] || 0;
      node.topRightRadius = cornerRadius[1] || 0;
      node.bottomRightRadius = cornerRadius[2] || 0;
      node.bottomLeftRadius = cornerRadius[3] || 0;
    }
  }
})();
