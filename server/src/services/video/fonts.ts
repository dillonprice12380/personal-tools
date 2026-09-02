/**
 * Font loading, shaping and measurement.
 *
 * Text is measured and drawn from the *same* shaped glyph run: `measure()`
 * returns the width of exactly the glyphs `glyphPaths()` will emit. That is
 * deliberate. The usual way rendered text ends up overflowing its box is that
 * one engine measures it and a different one draws it; here there is only one.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { openSync as openFontSync } from 'fontkit';
import type { Font, FontCollection, GlyphRun } from 'fontkit';
import { VideoSpecError } from './types.js';

/** Where to look when the spec does not name a font file. */
const SYSTEM_FONT_CANDIDATES: Record<'regular' | 'bold', string[]> = {
  regular: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf',
  ],
  bold: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\segoeuib.ttf',
  ],
};

function firstExisting(paths: string[]): string | null {
  for (const path of paths) if (existsSync(path)) return path;
  return null;
}

export function resolveFontFile(
  configured: string | undefined,
  baseDir: string,
  weight: 'regular' | 'bold',
): string {
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(baseDir, configured);
    if (!existsSync(path)) {
      throw new VideoSpecError(`theme.${weight === 'bold' ? 'boldFontFile' : 'fontFile'}: no font at ${path}`);
    }
    return path;
  }
  const fromEnv = weight === 'bold' ? process.env.HELM_VIDEO_FONT_BOLD : process.env.HELM_VIDEO_FONT;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new VideoSpecError(`Font from the environment does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const found = firstExisting(SYSTEM_FONT_CANDIDATES[weight]);
  if (found) return found;
  throw new VideoSpecError(
    `No ${weight} font found. Set theme.fontFile in the spec (or the HELM_VIDEO_FONT environment ` +
      `variable) to a .ttf or .otf file — text is drawn as outlines, so a real font file is required.`,
  );
}

function isCollection(font: Font | FontCollection): font is FontCollection {
  return Array.isArray((font as FontCollection).fonts);
}

const cache = new Map<string, LoadedFont>();

export interface LineMetrics {
  /** Advance width of the whole line at the given size, in pixels. */
  width: number;
  /** Distance from the baseline to the top of the em box, in pixels. */
  ascent: number;
  descent: number;
  lineHeight: number;
}

export class LoadedFont {
  readonly path: string;
  private readonly font: Font;
  private readonly glyphSvgCache = new Map<number, string>();
  private readonly runCache = new Map<string, GlyphRun>();

  constructor(path: string) {
    this.path = path;
    const opened = openFontSync(path);
    const font = isCollection(opened) ? opened.fonts[0] : opened;
    if (!font) throw new VideoSpecError(`Font file contains no usable font: ${path}`);
    this.font = font;
  }

  get familyName(): string {
    return this.font.familyName;
  }

  get unitsPerEm(): number {
    return this.font.unitsPerEm;
  }

  private layout(text: string): GlyphRun {
    let run = this.runCache.get(text);
    if (!run) {
      run = this.font.layout(text);
      this.runCache.set(text, run);
    }
    return run;
  }

  /** Codepoints in `text` this font cannot draw. Empty means it renders fully. */
  missingCodepoints(text: string): string[] {
    const missing = new Set<string>();
    for (const char of text) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      // Whitespace and control characters never need a visible glyph.
      if (cp < 0x21) continue;
      if (!this.font.hasGlyphForCodePoint(cp)) missing.add(char);
    }
    return [...missing];
  }

  measure(text: string, fontSize: number): LineMetrics {
    const scale = fontSize / this.font.unitsPerEm;
    const run = this.layout(text);
    return {
      width: run.advanceWidth * scale,
      ascent: this.font.ascent * scale,
      descent: Math.abs(this.font.descent) * scale,
      lineHeight: (this.font.ascent - this.font.descent + this.font.lineGap) * scale,
    };
  }

  width(text: string, fontSize: number): number {
    return this.measure(text, fontSize).width;
  }

  /**
   * SVG `<path>` elements for one line of text, positioned with `x` as the left
   * edge and `y` as the baseline. Coordinates are absolute pixels.
   */
  glyphPaths(text: string, fontSize: number, x: number, y: number, fill: string, opacity: number): string {
    const run = this.layout(text);
    const scale = fontSize / this.font.unitsPerEm;
    const parts: string[] = [];
    let penX = 0;
    let penY = 0;
    for (let i = 0; i < run.glyphs.length; i++) {
      const glyph = run.glyphs[i];
      const position = run.positions[i];
      let d = this.glyphSvgCache.get(glyph.id);
      if (d === undefined) {
        d = glyph.path.toSVG() ?? '';
        this.glyphSvgCache.set(glyph.id, d);
      }
      if (d) {
        const gx = penX + position.xOffset;
        const gy = penY + position.yOffset;
        parts.push(`<path transform="translate(${round(gx)} ${round(gy)})" d="${d}"/>`);
      }
      penX += position.xAdvance;
      penY += position.yAdvance;
    }
    if (parts.length === 0) return '';
    const alpha = opacity >= 1 ? '' : ` opacity="${round(opacity, 3)}"`;
    // The nested scale flips the y axis: font units grow upward, SVG downward.
    return (
      `<g transform="translate(${round(x)} ${round(y)}) scale(${round(scale, 6)} ${round(-scale, 6)})" ` +
      `fill="${fill}"${alpha}>${parts.join('')}</g>`
    );
  }
}

function round(n: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

export function loadFont(path: string): LoadedFont {
  let font = cache.get(path);
  if (!font) {
    font = new LoadedFont(path);
    cache.set(path, font);
  }
  return font;
}
