// Shared layer tree types used by both backend and figma-plugin.
// The injection script produces Layer[], and code.ts consumes it.

export interface RGB {
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
}

export interface RGBA extends RGB {
  a: number; // 0-1
}

export interface SolidPaint {
  type: "SOLID";
  color: RGB;
  opacity: number;
}

export interface ImagePaint {
  type: "IMAGE";
  imageUrl: string;
  scaleMode: "FILL" | "FIT" | "TILE" | "CROP";
}

export interface GradientStop {
  position: number; // 0-1
  color: RGBA;
}

export interface LinearGradientPaint {
  type: "GRADIENT_LINEAR";
  angle: number; // degrees
  stops: GradientStop[];
}

export type Paint = SolidPaint | ImagePaint | LinearGradientPaint;

export interface Stroke {
  color: RGBA;
  width: number;
  style: "SOLID" | "DASHED" | "DOTTED";
  sides: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface Effect {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR";
  color?: RGBA;
  offsetX?: number;
  offsetY?: number;
  radius: number;
  spread?: number;
}

export interface AutoLayout {
  direction: "HORIZONTAL" | "VERTICAL";
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlign: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlign: "MIN" | "CENTER" | "MAX";
  wrap: boolean;
}

export type LayerType = "FRAME" | "RECTANGLE" | "TEXT" | "SVG" | "IMAGE";

export interface BaseLayer {
  type: LayerType;
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  zIndex: number;
  parentId: string | null;
}

export interface FrameLayer extends BaseLayer {
  type: "FRAME";
  fills: Paint[];
  strokes: Stroke[];
  effects: Effect[];
  cornerRadius: number | [number, number, number, number];
  clipsContent: boolean;
  autoLayout: AutoLayout | null;
}

export interface RectangleLayer extends BaseLayer {
  type: "RECTANGLE";
  fills: Paint[];
  strokes: Stroke[];
  effects: Effect[];
  cornerRadius: number | [number, number, number, number];
}

export interface TextStyleRun {
  start: number; // character offset
  end: number;   // exclusive
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  color?: RGBA;
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  letterSpacing?: number;
}

export interface TextLayer extends BaseLayer {
  type: "TEXT";
  characters: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: { unit: "PIXELS" | "AUTO"; value: number };
  letterSpacing: number;
  textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical: "TOP" | "CENTER" | "BOTTOM";
  textCase: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE";
  textDecoration: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  italic: boolean;
  color: RGBA;
  /** Whether the text rendered on a single line in the browser — drives textAutoResize choice. */
  singleLine?: boolean;
  /** Per-character-range overrides for mixed inline styling (bold/italic/colored runs inside a paragraph). */
  styleRuns?: TextStyleRun[];
}

export interface SvgLayer extends BaseLayer {
  type: "SVG";
  svg: string;
}

export interface ImageLayer extends BaseLayer {
  type: "IMAGE";
  imageUrl: string;
  scaleMode: "FILL" | "FIT";
  cornerRadius: number | [number, number, number, number];
}

export type Layer = FrameLayer | RectangleLayer | TextLayer | SvgLayer | ImageLayer;

// --- API Request / Response types ---

export interface ImportRequest {
  mode: "url" | "html";
  url?: string;
  html?: string;
  viewportWidth: number; // 390, 768, 1280, 1440
  theme: "light" | "dark";
}

export interface ImportResponse {
  success: boolean;
  layers?: Layer[];
  pageTitle?: string;
  pageUrl?: string;
  documentWidth?: number;
  documentHeight?: number;
  /**
   * Map of image URL → base64 data URL (data:image/png;base64,...)
   * Captured server-side in Puppeteer so CORS doesn't block them.
   */
  images?: Record<string, string>;
  error?: string;
}

// --- UI <-> Sandbox messages ---

export type UIToPluginMessage =
  | { type: "CREATE_DESIGN"; layers: Layer[]; imageMap: Record<string, number[]>; pageTitle: string }
  | { type: "CANCEL" };

export type PluginToUIMessage =
  | { type: "PROGRESS"; step: string; percent?: number }
  | { type: "DONE"; rootNodeId: string }
  | { type: "ERROR"; error: string };
