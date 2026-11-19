// This script is serialized and injected into the browser page via page.evaluate().
// It must be self-contained: no imports, no external references.
// Produces Layer[] matching shared/types.ts.

export const injectionScriptSource = `
(() => {
  const layers = [];
  let nextId = 0;
  const nid = (prefix) => (prefix || "n") + "_" + (++nextId);

  // ---------- Color / Style Parsers ----------

  function parseColor(css) {
    if (!css || css === "transparent" || css === "rgba(0, 0, 0, 0)") return null;
    const m = css.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return {
      r: parseFloat(m[1]) / 255,
      g: parseFloat(m[2]) / 255,
      b: parseFloat(m[3]) / 255,
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }

  function parseNumericList(str) {
    return (str.match(/-?[\\d.]+/g) || []).map(parseFloat);
  }

  // ---------- Border radius ----------

  function parseBorderRadius(style) {
    const tl = parseFloat(style.borderTopLeftRadius) || 0;
    const tr = parseFloat(style.borderTopRightRadius) || 0;
    const br = parseFloat(style.borderBottomRightRadius) || 0;
    const bl = parseFloat(style.borderBottomLeftRadius) || 0;
    if (tl === tr && tr === br && br === bl) return tl;
    return [tl, tr, br, bl];
  }

  // ---------- Box Shadow ----------

  function parseBoxShadow(css) {
    if (!css || css === "none") return [];
    const shadows = [];
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        parts.push(css.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(css.slice(start));

    for (const part of parts) {
      const s = part.trim();
      if (!s) continue;
      const colorMatch = s.match(/rgba?\\([^)]+\\)|#[0-9a-fA-F]+|[a-z]+/i);
      const color = colorMatch ? parseColor(colorMatch[0]) : { r: 0, g: 0, b: 0, a: 1 };
      if (!color) continue;
      const isInset = /inset/.test(s);
      const cleaned = s.replace(/rgba?\\([^)]+\\)|inset|#[0-9a-fA-F]+/gi, "").trim();
      const nums = parseNumericList(cleaned);
      if (nums.length < 2) continue;
      shadows.push({
        type: isInset ? "INNER_SHADOW" : "DROP_SHADOW",
        color,
        offsetX: nums[0] || 0,
        offsetY: nums[1] || 0,
        radius: nums[2] || 0,
        spread: nums[3] || 0,
      });
    }
    return shadows;
  }

  // ---------- Fills ----------

  function parseLinearGradient(css) {
    const m = css.match(/linear-gradient\\((.+)\\)$/);
    if (!m) return null;
    const inner = m[1];
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(inner.slice(start));

    let angle = 180;
    let stopParts = parts;
    const first = parts[0].trim();
    const angleMatch = first.match(/([-\\d.]+)deg/);
    if (angleMatch) {
      angle = parseFloat(angleMatch[1]);
      stopParts = parts.slice(1);
    } else if (first.startsWith("to ")) {
      const dir = first.slice(3).trim();
      const map = {
        "top": 0, "right": 90, "bottom": 180, "left": 270,
        "top right": 45, "right top": 45,
        "bottom right": 135, "right bottom": 135,
        "bottom left": 225, "left bottom": 225,
        "top left": 315, "left top": 315,
      };
      angle = map[dir] !== undefined ? map[dir] : 180;
      stopParts = parts.slice(1);
    }

    const stops = [];
    stopParts.forEach((p, i) => {
      const txt = p.trim();
      const colorMatch = txt.match(/rgba?\\([^)]+\\)|#[0-9a-fA-F]+|[a-z]+(?!\\w)/i);
      if (!colorMatch) return;
      const color = parseColor(colorMatch[0]);
      if (!color) return;
      const posMatch = txt.match(/([\\d.]+)%/);
      const position = posMatch
        ? parseFloat(posMatch[1]) / 100
        : i / Math.max(1, stopParts.length - 1);
      stops.push({ position, color });
    });
    if (stops.length < 2) return null;
    return { type: "GRADIENT_LINEAR", angle, stops };
  }

  function resolveUrl(rawUrl) {
    try { return new URL(rawUrl, document.baseURI).href; }
    catch (e) { return rawUrl; }
  }

  // Split "background-image" on top-level commas (multi-layer backgrounds).
  function splitTopLevelCommas(str) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        out.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(str.slice(start).trim());
    return out;
  }

  function getFills(el, style) {
    const fills = [];

    // Solid background
    const bg = parseColor(style.backgroundColor);
    if (bg && bg.a > 0) {
      fills.push({
        type: "SOLID",
        color: { r: bg.r, g: bg.g, b: bg.b },
        opacity: bg.a,
      });
    }

    const bgImage = style.backgroundImage;
    if (!bgImage || bgImage === "none") return fills;

    // Multi-layer background-image. CSS stacks top-first; Figma fills bottom-first.
    // We'll push in CSS order then reverse at the end.
    const layersCss = splitTopLevelCommas(bgImage);
    const layerFills = [];
    for (const layer of layersCss) {
      if (/gradient/.test(layer)) {
        if (/^linear-gradient/.test(layer)) {
          const grad = parseLinearGradient(layer);
          if (grad) layerFills.push(grad);
        }
        // radial / conic — unsupported, skipped
      } else {
        const urlMatch = layer.match(/url\\(["']?([^"')]+)["']?\\)/);
        if (urlMatch) {
          const scaleMode =
            style.backgroundSize === "contain" ? "FIT" :
            style.backgroundSize === "cover" ? "FILL" :
            style.backgroundRepeat === "repeat" ? "TILE" : "FILL";
          layerFills.push({
            type: "IMAGE",
            imageUrl: resolveUrl(urlMatch[1]),
            scaleMode,
          });
        }
      }
    }
    // CSS first layer = top; Figma last fill = top. Reverse.
    for (let i = layerFills.length - 1; i >= 0; i--) fills.push(layerFills[i]);
    return fills;
  }

  // ---------- Strokes ----------

  function getStrokes(style) {
    const sides = {
      top: parseFloat(style.borderTopWidth) || 0,
      right: parseFloat(style.borderRightWidth) || 0,
      bottom: parseFloat(style.borderBottomWidth) || 0,
      left: parseFloat(style.borderLeftWidth) || 0,
    };
    const maxSide = Math.max(sides.top, sides.right, sides.bottom, sides.left);
    if (maxSide === 0) return [];
    const color =
      parseColor(style.borderTopColor) ||
      parseColor(style.borderRightColor) ||
      parseColor(style.borderBottomColor) ||
      parseColor(style.borderLeftColor);
    if (!color || color.a === 0) return [];
    const styleStr = style.borderTopStyle;
    const strokeStyle =
      styleStr === "dashed" ? "DASHED" :
      styleStr === "dotted" ? "DOTTED" : "SOLID";
    return [{ color, width: maxSide, style: strokeStyle, sides }];
  }

  // ---------- Auto Layout detection ----------

  function detectAutoLayout(el, style) {
    const display = style.display;
    if (display !== "flex" && display !== "inline-flex") return null;

    // Skip when children can't be arranged by Auto Layout:
    // - wrap enabled but not our simple case
    // - a child with position:absolute/fixed or transform
    const children = Array.from(el.children);
    for (const c of children) {
      const cs = getComputedStyle(c);
      if (cs.position === "absolute" || cs.position === "fixed") return null;
      if (cs.transform && cs.transform !== "none") return null;
      if (cs.marginLeft === "auto" || cs.marginRight === "auto" ||
          cs.marginTop === "auto" || cs.marginBottom === "auto") return null;
    }

    const direction =
      style.flexDirection === "column" || style.flexDirection === "column-reverse"
        ? "VERTICAL"
        : "HORIZONTAL";
    const justify = style.justifyContent;
    const align = style.alignItems;
    const primaryAxisAlign =
      justify === "center" ? "CENTER" :
      justify === "flex-end" || justify === "end" ? "MAX" :
      justify === "space-between" || justify === "space-around" || justify === "space-evenly" ? "SPACE_BETWEEN" :
      "MIN";
    const counterAxisAlign =
      align === "center" ? "CENTER" :
      align === "flex-end" || align === "end" ? "MAX" :
      align === "stretch" ? "MIN" : "MIN";

    const gap =
      parseFloat(style.columnGap) ||
      parseFloat(style.rowGap) ||
      parseFloat(style.gap) || 0;

    return {
      direction,
      itemSpacing: gap,
      paddingTop: parseFloat(style.paddingTop) || 0,
      paddingRight: parseFloat(style.paddingRight) || 0,
      paddingBottom: parseFloat(style.paddingBottom) || 0,
      paddingLeft: parseFloat(style.paddingLeft) || 0,
      primaryAxisAlign,
      counterAxisAlign,
      wrap: style.flexWrap === "wrap",
    };
  }

  // ---------- Visibility / filtering ----------

  const SKIP_TAGS = { script:1, style:1, meta:1, link:1, noscript:1, template:1, head:1, title:1, base:1 };

  function isHiddenForAccessibility(el) {
    // Screen-reader-only patterns
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    if (el.tagName && el.tagName.toLowerCase() === "input" &&
        el.getAttribute && el.getAttribute("type") === "hidden") return true;
    return false;
  }

  function isVisible(el, style, rect) {
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (parseFloat(style.opacity) === 0) {
      // Only skip opacity:0 when it also has no interaction (hidden utility). Keep for now as skip
      return false;
    }
    if (rect.width < 1 || rect.height < 1) return false;
    // sr-only 1\xD71 pixel trick (position:absolute; width:1px; height:1px; overflow:hidden)
    if (rect.width <= 1 && rect.height <= 1) return false;
    // Off-screen: e.g. position:absolute;left:-9999px
    if (rect.right < -500 || rect.bottom < -500) return false;
    if (rect.left > document.documentElement.scrollWidth + 500) return false;
    // clip-path screen-reader trick
    const clipPath = style.clipPath;
    if (clipPath && /inset\\(50%\\)/.test(clipPath)) return false;
    // Legacy clip: rect(0,0,0,0) / rect(1px,1px,1px,1px) screen-reader trick
    const clip = style.clip;
    if (clip && clip !== "auto" && /rect\\(\\s*[01](?:px)?\\s*,\\s*[01](?:px)?\\s*,\\s*[01](?:px)?\\s*,\\s*[01](?:px)?\\s*\\)/.test(clip)) return false;
    return true;
  }

  // ---------- Text mapping ----------

  function mapTextCase(tt) {
    return tt === "uppercase" ? "UPPER" :
           tt === "lowercase" ? "LOWER" :
           tt === "capitalize" ? "TITLE" : "ORIGINAL";
  }

  function mapTextDecoration(td) {
    if (!td || td === "none") return "NONE";
    if (td.indexOf("underline") !== -1) return "UNDERLINE";
    if (td.indexOf("line-through") !== -1) return "STRIKETHROUGH";
    return "NONE";
  }

  function mapTextAlign(ta) {
    return ta === "center" ? "CENTER" :
           ta === "right" || ta === "end" ? "RIGHT" :
           ta === "justify" ? "JUSTIFIED" : "LEFT";
  }

  function parseRotation(transform) {
    if (!transform || transform === "none") return 0;
    const m = transform.match(/matrix\\(([^)]+)\\)/);
    if (!m) return 0;
    const vals = m[1].split(",").map(function(s){ return parseFloat(s.trim()); });
    if (vals.length < 4) return 0;
    return Math.atan2(vals[1], vals[0]) * (180 / Math.PI);
  }

  function getImageUrl(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "img") return el.currentSrc || el.src || null;
    if (tag === "video") return el.poster || null;
    return null;
  }

  function getSvgString(el) {
    try {
      const clone = el.cloneNode(true);
      // Strip <text> from icon-style SVGs. Figma's SVG parser renders SVG <text>
      // at broken dimensions (user-space units vs. CSS px mismatch). If the SVG
      // has any visual shapes, the text is almost always an accessibility label
      // duplicating what the shapes already convey.
      const hasShape = clone.querySelector("path,rect,circle,ellipse,polygon,polyline,line,use,image");
      if (hasShape) {
        const texts = clone.getElementsByTagName("text");
        for (let i = texts.length - 1; i >= 0; i--) {
          if (texts[i].parentNode) texts[i].parentNode.removeChild(texts[i]);
        }
      }
      if (!clone.getAttribute("xmlns")) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      return clone.outerHTML;
    } catch (e) { return null; }
  }

  function normalizeWeight(fw) {
    if (!fw) return 400;
    if (fw === "normal") return 400;
    if (fw === "bold") return 700;
    const n = parseInt(fw);
    return isNaN(n) ? 400 : n;
  }

  // ---------- Inline-text detection ----------
  // A "text block" is a container whose only content is text — possibly with inline
  // decorating tags (em, strong, a, span, ...). We emit one TEXT node per block and
  // capture inline styling as per-range overrides (styleRuns).

  const INLINE_TEXT_TAGS = {
    span:1, a:1, em:1, strong:1, b:1, i:1, u:1, small:1, mark:1,
    time:1, label:1, sub:1, sup:1, code:1, kbd:1, s:1, cite:1, q:1, abbr:1, br:1, wbr:1
  };

  function isTextBlock(el) {
    if (!el.children) return false;
    const text = (el.textContent || "").trim();
    if (!text.length) return false;
    // No elements → pure text leaf
    if (el.children.length === 0) return true;
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      const tag = child.tagName.toLowerCase();
      if (!INLINE_TEXT_TAGS[tag]) return false;
      // If inline wrapper contains block-like descendants, bail
      if (!isTextBlock(child) && child.children.length > 0) return false;
    }
    return true;
  }

  // Walk the text block and collect character runs with their inline style.
  function collectTextRuns(blockEl, blockStyle) {
    const runs = [];
    let chars = "";
    const baseColor = parseColor(blockStyle.color) || { r: 0, g: 0, b: 0, a: 1 };
    const baseWeight = normalizeWeight(blockStyle.fontWeight);
    const baseFamily = (blockStyle.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim() || "Inter";
    const baseSize = parseFloat(blockStyle.fontSize) || 16;
    const baseItalic = blockStyle.fontStyle === "italic";
    const baseDecoration = mapTextDecoration(blockStyle.textDecoration);

    function walk(node) {
      if (node.nodeType === 3) {
        // Text node — collapse whitespace similar to browser
        const rawText = node.textContent || "";
        if (!rawText) return;
        // Browser collapses runs of whitespace to a single space. Preserve the
        // original when the block's white-space is pre/pre-wrap.
        const ws = blockStyle.whiteSpace;
        const normalized = (ws === "pre" || ws === "pre-wrap" || ws === "pre-line")
          ? rawText
          : rawText.replace(/\\s+/g, " ");
        if (!normalized) return;
        const start = chars.length;
        chars += normalized;
        const end = chars.length;
        const parentStyle = getComputedStyle(node.parentElement);
        const color = parseColor(parentStyle.color) || baseColor;
        const weight = normalizeWeight(parentStyle.fontWeight);
        const family = (parentStyle.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim() || baseFamily;
        const size = parseFloat(parentStyle.fontSize) || baseSize;
        const italic = parentStyle.fontStyle === "italic";
        const decoration = mapTextDecoration(parentStyle.textDecoration);
        const ls = parseFloat(parentStyle.letterSpacing) || 0;

        const differs =
          family !== baseFamily ||
          weight !== baseWeight ||
          size !== baseSize ||
          italic !== baseItalic ||
          decoration !== baseDecoration ||
          color.r !== baseColor.r || color.g !== baseColor.g || color.b !== baseColor.b || color.a !== baseColor.a;

        if (differs) {
          runs.push({
            start, end,
            fontFamily: family,
            fontWeight: weight,
            fontSize: size,
            italic,
            color,
            textDecoration: decoration,
            letterSpacing: ls,
          });
        }
      } else if (node.nodeType === 1) {
        if (node.tagName.toLowerCase() === "br") { chars += "\\n"; return; }
        const kids = node.childNodes;
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
      }
    }

    const kids = blockEl.childNodes;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);

    // Trim leading/trailing whitespace
    const leading = chars.match(/^\\s+/);
    if (leading) {
      const shift = leading[0].length;
      chars = chars.slice(shift);
      for (const r of runs) { r.start = Math.max(0, r.start - shift); r.end = Math.max(0, r.end - shift); }
    }
    chars = chars.replace(/\\s+$/, "");
    // Clip runs to chars length
    for (const r of runs) { r.end = Math.min(r.end, chars.length); r.start = Math.min(r.start, chars.length); }

    return { characters: chars, runs };
  }

  // Single-line detection via Range.getClientRects()
  function isSingleLine(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = range.getClientRects();
      return rects.length <= 1;
    } catch (e) { return false; }
  }

  // ---------- Pseudo-elements (::before, ::after) ----------
  // Materialize simple text content from pseudo-elements so it's captured.
  // We only handle text content and simple url() images. We restore the DOM at the end.

  const pseudoInjections = []; // { el, injectedNodes: [] }

  function unquote(s) {
    if (!s) return "";
    const m = s.match(/^['"](.*)['"]$/s);
    return m ? m[1] : s;
  }

  function materializePseudos(root) {
    const all = root.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (SKIP_TAGS[el.tagName.toLowerCase()]) continue;
      for (const which of ["::before", "::after"]) {
        const ps = getComputedStyle(el, which);
        if (!ps) continue;
        const content = ps.content;
        if (!content || content === "none" || content === "normal" || content === '""' || content === "''") continue;

        // Text content: "Hello" → Hello
        const text = unquote(content).trim();
        if (!text) continue;
        // Skip counter/attr references (they start with counter( or attr(); cheap detect)
        if (/counter\\(|attr\\(|url\\(/.test(content)) continue;

        const span = document.createElement("span");
        span.setAttribute("data-h2f-pseudo", which);
        span.style.cssText = \`display:inline-block;
          color:\${ps.color || ""};
          font:\${ps.font || ""};
          line-height:\${ps.lineHeight || ""};
          padding:\${ps.padding || ""};
          margin:\${ps.margin || ""};
          background:\${ps.background || ""};\`;
        span.textContent = text;
        if (which === "::before") {
          el.insertBefore(span, el.firstChild);
        } else {
          el.appendChild(span);
        }
        pseudoInjections.push(span);
      }
    }
  }

  function cleanupPseudos() {
    for (const n of pseudoInjections) {
      if (n.parentNode) n.parentNode.removeChild(n);
    }
  }

  // ---------- Name ----------

  function getElementName(el) {
    const id = el.id ? "#" + el.id : "";
    const cls = el.className && typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return (el.tagName.toLowerCase() + id + cls).slice(0, 40);
  }

  // ---------- Layer builder ----------

  function buildLayerForElement(el, parentId, zIndex) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, style, rect)) return null;
    if (isHiddenForAccessibility(el)) return null;

    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS[tag]) return null;

    const base = {
      id: nid("el"),
      name: getElementName(el),
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      rotation: parseRotation(style.transform),
      opacity: parseFloat(style.opacity) || 1,
      visible: true,
      zIndex: zIndex,
      parentId,
    };

    // SVG: serialize whole subtree
    if (tag === "svg") {
      const svg = getSvgString(el);
      if (svg) return Object.assign({}, base, { type: "SVG", svg });
    }

    // Image
    const imgUrl = getImageUrl(el);
    if (imgUrl) {
      return Object.assign({}, base, {
        type: "IMAGE",
        imageUrl: resolveUrl(imgUrl),
        scaleMode: style.objectFit === "contain" ? "FIT" : "FILL",
        cornerRadius: parseBorderRadius(style),
      });
    }

    // Text block → TEXT with per-range styleRuns
    if (isTextBlock(el)) {
      const collected = collectTextRuns(el, style);
      if (!collected.characters.length) return null;
      const baseColor = parseColor(style.color) || { r: 0, g: 0, b: 0, a: 1 };
      const fontSize = parseFloat(style.fontSize) || 16;
      let lineHeightPx = parseFloat(style.lineHeight);
      const lineHeight = isNaN(lineHeightPx)
        ? { unit: "AUTO", value: 0 }
        : { unit: "PIXELS", value: lineHeightPx };
      return Object.assign({}, base, {
        type: "TEXT",
        characters: collected.characters,
        fontFamily: (style.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim() || "Inter",
        fontWeight: normalizeWeight(style.fontWeight),
        fontSize,
        lineHeight,
        letterSpacing: parseFloat(style.letterSpacing) || 0,
        textAlignHorizontal: mapTextAlign(style.textAlign),
        textAlignVertical: "TOP",
        textCase: mapTextCase(style.textTransform),
        textDecoration: mapTextDecoration(style.textDecoration),
        italic: style.fontStyle === "italic",
        color: baseColor,
        singleLine: isSingleLine(el),
        styleRuns: collected.runs,
      });
    }

    // Default: FRAME
    return Object.assign({}, base, {
      type: "FRAME",
      fills: getFills(el, style),
      strokes: getStrokes(style),
      effects: parseBoxShadow(style.boxShadow),
      cornerRadius: parseBorderRadius(style),
      clipsContent: style.overflow !== "visible",
      autoLayout: detectAutoLayout(el, style),
    });
  }

  // ---------- Stacking-aware children ----------

  // Sort children so they paint bottom-to-top in visual order.
  // Approximation of CSS stacking context rules.
  function sortStackingChildren(children) {
    // children: [{el, style}]
    const neg = [], zeroStatic = [], zeroPositioned = [], pos = [];
    children.forEach(function(c, i){
      const z = c.style.zIndex;
      const positioned = c.style.position !== "static";
      const n = z === "auto" ? null : parseInt(z);
      if (n != null && n < 0) neg.push({ c, i, n });
      else if (positioned) {
        if (n == null || n === 0) zeroPositioned.push({ c, i, n: 0 });
        else pos.push({ c, i, n });
      } else {
        zeroStatic.push({ c, i, n: 0 });
      }
    });
    const byN = function(a, b){ return a.n === b.n ? a.i - b.i : a.n - b.n; };
    neg.sort(byN);
    pos.sort(byN);
    // bucket order: neg, staticFlow, zeroPositioned, positiveZ
    return [].concat(neg, zeroStatic, zeroPositioned, pos).map(function(x){ return x.c; });
  }

  // ---------- Tree walker ----------

  function walk(el, parentId, depth) {
    if (depth > 40) return;
    if (!el || !el.tagName) return;
    if (SKIP_TAGS[el.tagName.toLowerCase()]) return;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, style, rect)) return;
    if (isHiddenForAccessibility(el)) return;

    const zIndex = style.zIndex === "auto" ? 0 : (parseInt(style.zIndex) || 0);
    const layer = buildLayerForElement(el, parentId, zIndex);
    if (!layer) return;
    layers.push(layer);

    // Don't descend into SVG, IMAGE, or TEXT leafs — their content is captured atomically.
    if (layer.type === "SVG" || layer.type === "IMAGE" || layer.type === "TEXT") return;

    // Collect real element children (not text nodes)
    const kids = [];
    const ec = el.children;
    for (let i = 0; i < ec.length; i++) {
      const c = ec[i];
      kids.push({ el: c, style: getComputedStyle(c) });
    }
    if (el.shadowRoot) {
      const sc = el.shadowRoot.children;
      for (let i = 0; i < sc.length; i++) {
        kids.push({ el: sc[i], style: getComputedStyle(sc[i]) });
      }
    }
    const sorted = sortStackingChildren(kids);
    for (const entry of sorted) walk(entry.el, layer.id, depth + 1);
  }

  // ---------- Main ----------

  try {
    materializePseudos(document.body);

    const body = document.body;
    const docWidth = Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth);
    const docHeight = Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight);

    const rootId = nid("root");
    const bodyStyle = getComputedStyle(body);
    layers.push({
      id: rootId,
      name: (document.title || "Imported Page").slice(0, 60),
      type: "FRAME",
      x: 0, y: 0,
      width: docWidth,
      height: docHeight,
      rotation: 0,
      opacity: 1,
      visible: true,
      zIndex: 0,
      parentId: null,
      fills: (function() {
        const c = parseColor(bodyStyle.backgroundColor) || parseColor(getComputedStyle(document.documentElement).backgroundColor);
        if (c && c.a > 0) return [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
        return [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
      })(),
      strokes: [],
      effects: [],
      cornerRadius: 0,
      clipsContent: true,
      autoLayout: null,
    });

    const kids = [];
    const bc = body.children;
    for (let i = 0; i < bc.length; i++) kids.push({ el: bc[i], style: getComputedStyle(bc[i]) });
    const sorted = sortStackingChildren(kids);
    for (const entry of sorted) walk(entry.el, rootId, 0);

    cleanupPseudos();

    return {
      layers,
      pageTitle: document.title || "Imported Page",
      pageUrl: location.href,
      documentWidth: docWidth,
      documentHeight: docHeight,
    };
  } catch (err) {
    cleanupPseudos();
    throw err;
  }
})();
`;
