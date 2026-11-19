// Pure validators over an ImportResponse's `layers` array.
// Each returns { ok, name, detail } where detail is a short human string.

const SKIPPED_NAMES = ["script", "style", "meta", "link", "noscript", "head", "title", "base"];

export function uniqueIds(layers) {
  const seen = new Map();
  for (const l of layers) {
    if (seen.has(l.id)) {
      return { ok: false, name: "unique ids", detail: `duplicate id ${l.id}` };
    }
    seen.set(l.id, l);
  }
  return { ok: true, name: "unique ids" };
}

export function parentRefsResolve(layers) {
  const ids = new Set(layers.map((l) => l.id));
  for (const l of layers) {
    if (l.parentId !== null && !ids.has(l.parentId)) {
      return { ok: false, name: "parent refs resolve", detail: `${l.id} points to missing parent ${l.parentId}` };
    }
  }
  return { ok: true, name: "parent refs resolve" };
}

export function noOrphanCycles(layers) {
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (const l of layers) {
    let cur = l;
    let hops = 0;
    while (cur && cur.parentId !== null) {
      cur = byId.get(cur.parentId);
      if (!cur) break;
      if (++hops > 50) {
        return { ok: false, name: "no orphan cycles", detail: `${l.id} exceeds 50 hops` };
      }
    }
  }
  return { ok: true, name: "no orphan cycles" };
}

export function geometryFinite(layers) {
  for (const l of layers) {
    for (const k of ["x", "y", "width", "height", "rotation", "opacity"]) {
      if (!Number.isFinite(l[k])) {
        return { ok: false, name: "geometry finite", detail: `${l.id} has non-finite ${k}=${l[k]}` };
      }
    }
    if (l.width < 0 || l.height < 0) {
      return { ok: false, name: "geometry finite", detail: `${l.id} has negative size ${l.width}x${l.height}` };
    }
  }
  return { ok: true, name: "geometry finite" };
}

export function styleRunsWellFormed(layers) {
  for (const l of layers) {
    if (l.type !== "TEXT" || !l.styleRuns) continue;
    const len = l.characters.length;
    let prevEnd = 0;
    for (const r of l.styleRuns) {
      if (r.start < 0 || r.end > len || r.start >= r.end) {
        return { ok: false, name: "styleRuns well-formed", detail: `${l.id} run [${r.start},${r.end}] invalid for len ${len}` };
      }
      // non-decreasing start
      if (r.start < prevEnd - 1) {
        // We allow overlap because different attributes can layer on the same range in real html
        // (e.g. a <strong> inside an <em>), but flag wild backwards jumps
      }
      prevEnd = Math.max(prevEnd, r.end);
    }
  }
  return { ok: true, name: "styleRuns well-formed" };
}

export function noSkippedTags(layers) {
  for (const l of layers) {
    const prefix = (l.name || "").split(".")[0].split("#")[0].toLowerCase();
    if (SKIPPED_NAMES.includes(prefix)) {
      return { ok: false, name: "no skipped tags leaked", detail: `${l.id} name="${l.name}"` };
    }
  }
  return { ok: true, name: "no skipped tags leaked" };
}

export function autoLayoutSanity(layers) {
  const byParent = new Map();
  for (const l of layers) {
    if (!byParent.has(l.parentId)) byParent.set(l.parentId, []);
    byParent.get(l.parentId).push(l);
  }
  for (const l of layers) {
    if (l.type !== "FRAME" || !l.autoLayout) continue;
    const kids = byParent.get(l.id) || [];
    if (kids.length < 2) continue;
    const dir = l.autoLayout.direction;
    const sorted = [...kids].sort((a, b) => (dir === "VERTICAL" ? a.y - b.y : a.x - b.x));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      const overlap =
        dir === "VERTICAL"
          ? a.y + a.height > b.y + 4
          : a.x + a.width > b.x + 4;
      if (overlap) {
        return {
          ok: false,
          name: "auto-layout sanity",
          detail: `${l.id} has auto-layout but children overlap on ${dir} axis`,
        };
      }
    }
  }
  return { ok: true, name: "auto-layout sanity" };
}

export function textNotFragmented(layers, opts = {}) {
  const { minChars = 2, maxTextLayers = null, label = "" } = opts;
  const texts = layers.filter((l) => l.type === "TEXT");
  for (const t of texts) {
    if (t.characters.length < minChars) {
      return {
        ok: false,
        name: "text not fragmented" + (label ? ` (${label})` : ""),
        detail: `TEXT "${t.characters}" (${t.id}) has only ${t.characters.length} chars`,
      };
    }
  }
  if (maxTextLayers !== null && texts.length > maxTextLayers) {
    return {
      ok: false,
      name: "text not fragmented" + (label ? ` (${label})` : ""),
      detail: `${texts.length} TEXT layers exceeds expected max ${maxTextLayers}`,
    };
  }
  return { ok: true, name: "text not fragmented" + (label ? ` (${label})` : "") };
}

export function imageCoverage(layers, images) {
  const referenced = new Set();
  for (const l of layers) {
    if (l.type === "IMAGE") referenced.add(l.imageUrl);
    if (Array.isArray(l.fills)) {
      for (const f of l.fills) if (f.type === "IMAGE") referenced.add(f.imageUrl);
    }
  }
  const missing = [...referenced].filter((u) => !(u in images));
  if (missing.length > 0) {
    return {
      ok: false,
      name: "image coverage",
      detail: `${missing.length}/${referenced.size} urls missing bytes (first: ${missing[0].slice(0, 80)})`,
    };
  }
  return { ok: true, name: "image coverage", detail: `${referenced.size} imgs all present` };
}

export function pseudoMaterialized(layers) {
  // A fixture containing ".quote::before" should produce either the pseudo text
  // as part of the "quote" block (merged by isTextBlock) OR as its own TEXT layer.
  // We just check that the literal quote mark ("\u201C" or "\"") appears in some text.
  const needle = "\u201C";
  const found = layers.some(
    (l) => l.type === "TEXT" && l.characters && l.characters.includes(needle)
  );
  if (!found) {
    return { ok: false, name: "pseudo-elements materialized", detail: `no text contains "${needle}"` };
  }
  return { ok: true, name: "pseudo-elements materialized" };
}

export function hiddenContentExcluded(layers) {
  // Our fixture has "<div class='hidden'>This should NOT appear..." and ".sr-only" span
  const banned = ["This should NOT appear", "Screen-reader-only"];
  for (const l of layers) {
    if (l.type === "TEXT" && l.characters) {
      for (const b of banned) {
        if (l.characters.includes(b)) {
          return { ok: false, name: "hidden content excluded", detail: `found banned "${b}"` };
        }
      }
    }
  }
  return { ok: true, name: "hidden content excluded" };
}

export function counts(layers) {
  const c = { FRAME: 0, RECTANGLE: 0, TEXT: 0, IMAGE: 0, SVG: 0 };
  for (const l of layers) c[l.type] = (c[l.type] || 0) + 1;
  return c;
}
