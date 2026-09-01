/**
 * Frame composition.
 *
 * Each frame is an SVG document rendered to PNG. Two decisions here matter for
 * correctness:
 *
 *  1. Text is emitted as glyph outlines, never as `<text>`. The renderer cannot
 *     substitute a different font, and no caption can break the document by
 *     containing an `&` or a `<`, because user text never reaches the XML.
 *  2. Layout is computed once per scene, not once per frame. A frame differs
 *     from its neighbour only in opacities, so nothing can shift by a pixel
 *     halfway through a shot.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fitText, type FitResult } from './text.js';
import { loadFont, type LoadedFont } from './fonts.js';
import { cueAt } from './timeline.js';
import type { Background, Cue, Timeline, VideoSpec } from './types.js';

const LINE_HEIGHT = 1.28;
const BULLET_LINE_HEIGHT = 1.32;

interface TextBlock {
  fit: FitResult;
  x: number;
  /** Baseline of the first line. */
  baseline: number;
  color: string;
  font: LoadedFont;
  align: 'left' | 'center';
}

interface BulletBlock extends TextBlock {
  markerX: number;
  markerY: number;
  markerRadius: number;
  revealFrame: number;
}

interface SceneLayout {
  background: string;
  title: TextBlock | null;
  body: TextBlock | null;
  bullets: BulletBlock[];
  image: { href: string; x: number; y: number; width: number; height: number; fit: string } | null;
}

interface CaptionLayout {
  fit: FitResult;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  firstBaseline: number;
  centerX: number;
}

function round(n: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const dataUriCache = new Map<string, string>();

function dataUri(path: string): string {
  let uri = dataUriCache.get(path);
  if (uri === undefined) {
    const bytes = readFileSync(path);
    const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? sniffMime(bytes);
    uri = `data:${mime};base64,${bytes.toString('base64')}`;
    dataUriCache.set(path, uri);
  }
  return uri;
}

function sniffMime(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length > 12 && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length > 3 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}

export class FrameComposer {
  private readonly spec: VideoSpec;
  private readonly timeline: Timeline;
  private readonly titleFont: LoadedFont;
  private readonly bodyFont: LoadedFont;
  private readonly sceneLayouts: SceneLayout[] = [];
  private readonly captionLayouts = new Map<number, CaptionLayout>();
  private readonly cueIndex = new Map<Cue, number>();

  readonly inset: number;
  readonly contentX: number;
  readonly contentY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  private readonly captionBandHeight: number;
  private readonly gap: number;

  constructor(spec: VideoSpec, timeline: Timeline) {
    this.spec = spec;
    this.timeline = timeline;
    this.titleFont = loadFont(spec.theme.boldFontFile);
    this.bodyFont = loadFont(spec.theme.fontFile);

    const shortEdge = Math.min(spec.width, spec.height);
    this.inset = Math.round(shortEdge * spec.theme.safeArea);
    this.gap = Math.round(shortEdge * 0.03);

    this.captionBandHeight = spec.captions.enabled
      ? Math.round(
          spec.theme.captionSize * LINE_HEIGHT * spec.captions.maxLines +
            spec.theme.captionSize * 0.9 +
            this.gap,
        )
      : 0;

    this.contentX = this.inset;
    this.contentY = this.inset;
    this.contentWidth = spec.width - this.inset * 2;
    this.contentHeight = spec.height - this.inset * 2 - this.captionBandHeight;

    if (this.contentWidth < 64 || this.contentHeight < 64) {
      throw new Error(
        `theme.safeArea of ${spec.theme.safeArea} leaves only ${this.contentWidth}×${this.contentHeight}px for ` +
          `content at ${spec.width}×${spec.height}. Lower theme.safeArea, or turn captions off.`,
      );
    }

    timeline.cues.forEach((cue, i) => this.cueIndex.set(cue, i));
    spec.scenes.forEach((_, index) => this.sceneLayouts.push(this.layoutScene(index)));
    timeline.cues.forEach((cue, i) => this.captionLayouts.set(i, this.layoutCaption(cue)));
  }

  /* ---------------------------- layout ---------------------------- */

  private layoutScene(index: number): SceneLayout {
    const scene = this.spec.scenes[index];
    const theme = this.spec.theme;
    const timing = this.timeline.scenes[index];
    const label = `scenes[${index}] ("${scene.id}")`;

    const present = {
      title: scene.title !== null,
      image: scene.image !== null,
      body: scene.body !== null,
      bullets: scene.bullets.length > 0,
    };
    const partCount = Object.values(present).filter(Boolean).length;
    if (partCount === 0) {
      return { background: this.backgroundMarkup(scene.background, index), title: null, body: null, bullets: [], image: null };
    }

    // Split the content box between the parts that are present, then let each
    // part shrink inside its own share. Because every part is fitted to a share
    // and the shares plus gaps equal the box, the stack always fits.
    const available = this.contentHeight - this.gap * (partCount - 1);
    const weights = { title: 3, image: 5, body: 3, bullets: 3 };
    const totalWeight =
      (present.title ? weights.title : 0) +
      (present.image ? weights.image : 0) +
      (present.body ? weights.body : 0) +
      (present.bullets ? weights.bullets : 0);
    const share = (weight: number) => (available * weight) / totalWeight;

    const blocks: { height: number; place: (top: number) => void }[] = [];
    let title: TextBlock | null = null;
    let body: TextBlock | null = null;
    let image: SceneLayout['image'] = null;
    const bullets: BulletBlock[] = [];

    if (scene.title) {
      const fit = fitText({
        text: scene.title,
        fontSize: theme.titleSize,
        minFontSize: theme.minFontSize,
        maxWidth: this.contentWidth,
        maxHeight: share(weights.title),
        maxLines: 3,
        lineHeightFactor: LINE_HEIGHT,
        measure: (t, s) => this.titleFont.width(t, s),
        label: `${label} title`,
      });
      const block: TextBlock = {
        fit, x: this.contentX, baseline: 0, color: theme.titleColor, font: this.titleFont, align: theme.align,
      };
      title = block;
      blocks.push({
        height: fit.height,
        place: (top) => { block.baseline = top + fit.fontSize; },
      });
    }

    if (scene.image) {
      const height = Math.min(share(weights.image), this.contentHeight * scene.image.maxHeight);
      const placed = { href: dataUri(scene.image.path), x: this.contentX, y: 0, width: this.contentWidth, height, fit: scene.image.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet' };
      image = placed;
      blocks.push({ height, place: (top) => { placed.y = top; } });
    }

    if (scene.body) {
      const fit = fitText({
        text: scene.body,
        fontSize: theme.bodySize,
        minFontSize: theme.minFontSize,
        maxWidth: this.contentWidth,
        maxHeight: share(weights.body),
        maxLines: 8,
        lineHeightFactor: LINE_HEIGHT,
        measure: (t, s) => this.bodyFont.width(t, s),
        label: `${label} body`,
      });
      const block: TextBlock = {
        fit, x: this.contentX, baseline: 0, color: theme.bodyColor, font: this.bodyFont, align: theme.align,
      };
      body = block;
      blocks.push({ height: fit.height, place: (top) => { block.baseline = top + fit.fontSize; } });
    }

    if (scene.bullets.length > 0) {
      const bulletsShare = share(weights.bullets);
      const bulletGap = Math.round(theme.bodySize * 0.55);
      const perBullet = (bulletsShare - bulletGap * (scene.bullets.length - 1)) / scene.bullets.length;
      const indent = Math.round(theme.bodySize * 1.6);
      const reveals = this.bulletRevealFrames(index, scene.bullets.length, timing.startFrame, timing.frames);

      const fitted = scene.bullets.map((text, i) =>
        fitText({
          text,
          fontSize: theme.bodySize,
          minFontSize: theme.minFontSize,
          maxWidth: this.contentWidth - indent,
          maxHeight: perBullet,
          maxLines: 3,
          lineHeightFactor: BULLET_LINE_HEIGHT,
          measure: (t, s) => this.bodyFont.width(t, s),
          label: `${label} bullets[${i}]`,
        }),
      );
      const groupHeight = fitted.reduce((sum, f) => sum + f.height, 0) + bulletGap * (fitted.length - 1);
      // Bullet text stays left-aligned to each other — a ragged left edge is
      // unreadable — but the group as a whole is centred under a centred title.
      const groupWidth = Math.max(...fitted.map((f) => indent + f.width));
      const groupLeft =
        theme.align === 'center'
          ? this.contentX + Math.round((this.contentWidth - groupWidth) / 2)
          : this.contentX;
      blocks.push({
        height: groupHeight,
        place: (top) => {
          let cursor = top;
          fitted.forEach((fit, i) => {
            bullets.push({
              fit,
              x: groupLeft + indent,
              baseline: cursor + fit.fontSize,
              color: theme.bodyColor,
              font: this.bodyFont,
              align: 'left',
              markerX: groupLeft + Math.round(indent * 0.35),
              markerY: cursor + fit.fontSize * 0.62,
              markerRadius: Math.max(3, Math.round(fit.fontSize * 0.16)),
              revealFrame: reveals[i],
            });
            cursor += fit.height + bulletGap;
          });
        },
      });
    }

    const stackHeight = blocks.reduce((sum, b) => sum + b.height, 0) + this.gap * (blocks.length - 1);
    let cursor = this.contentY + Math.max(0, (this.contentHeight - stackHeight) / 2);
    for (const block of blocks) {
      block.place(cursor);
      cursor += block.height + this.gap;
    }

    return { background: this.backgroundMarkup(scene.background, index), title, body, bullets, image };
  }

  /** Bullets appear spread across the narration, or across the scene without one. */
  private bulletRevealFrames(index: number, count: number, startFrame: number, frames: number): number[] {
    const timing = this.timeline.scenes[index];
    const spanStart = timing.narrationFrames > 0 ? timing.narrationStartFrame : startFrame;
    const spanFrames = timing.narrationFrames > 0 ? timing.narrationFrames : frames;
    if (count === 1) return [spanStart];
    // The last bullet lands at 70% of the span so it is readable before the cut.
    return Array.from({ length: count }, (_, i) =>
      spanStart + Math.round((spanFrames * 0.7 * i) / (count - 1)),
    );
  }

  private layoutCaption(cue: Cue): CaptionLayout {
    const theme = this.spec.theme;
    const padX = Math.round(theme.captionSize * 0.7);
    const padY = Math.round(theme.captionSize * 0.45);
    const maxBoxWidth = this.spec.width - this.inset * 2;
    const fit = fitText({
      text: cue.text,
      fontSize: theme.captionSize,
      minFontSize: theme.minFontSize,
      maxWidth: maxBoxWidth - padX * 2,
      maxHeight: theme.captionSize * LINE_HEIGHT * this.spec.captions.maxLines,
      maxLines: this.spec.captions.maxLines,
      lineHeightFactor: LINE_HEIGHT,
      measure: (t, s) => this.bodyFont.width(t, s),
      label: `caption in scenes[${cue.sceneIndex}]`,
    });

    const boxWidth = Math.min(maxBoxWidth, fit.width + padX * 2);
    const boxHeight = fit.height + padY * 2;
    const boxX = Math.round((this.spec.width - boxWidth) / 2);
    const boxY = this.spec.height - this.inset - boxHeight;
    return {
      fit,
      boxX,
      boxY,
      boxWidth,
      boxHeight,
      firstBaseline: boxY + padY + fit.fontSize,
      centerX: this.spec.width / 2,
    };
  }

  /* ---------------------------- markup ---------------------------- */

  private backgroundMarkup(background: Background, index: number): string {
    const { width, height } = this.spec;
    switch (background.type) {
      case 'solid':
        return `<rect width="${width}" height="${height}" fill="${background.color}"/>`;
      case 'gradient': {
        const radians = ((background.angle ?? 135) * Math.PI) / 180;
        const dx = Math.cos(radians) / 2;
        const dy = Math.sin(radians) / 2;
        const id = `grad${index}`;
        return (
          `<defs><linearGradient id="${id}" x1="${round(0.5 - dx, 4)}" y1="${round(0.5 - dy, 4)}" ` +
          `x2="${round(0.5 + dx, 4)}" y2="${round(0.5 + dy, 4)}">` +
          `<stop offset="0" stop-color="${background.from}"/>` +
          `<stop offset="1" stop-color="${background.to}"/></linearGradient></defs>` +
          `<rect width="${width}" height="${height}" fill="url(#${id})"/>`
        );
      }
      case 'image':
        // Placeholder; the per-frame path re-emits this with the Ken Burns
        // transform for the frame in question.
        return '';
    }
  }

  private backgroundImageMarkup(background: Background, progress: number): string {
    if (background.type !== 'image') return '';
    const { width, height } = this.spec;
    const zoom = 1 + (background.kenBurns ?? 0) * progress;
    const w = width * zoom;
    const h = height * zoom;
    const x = (width - w) / 2;
    const y = (height - h) / 2;
    const fit = background.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice';
    const dim = background.dim ?? 0;
    const overlay = dim > 0 ? `<rect width="${width}" height="${height}" fill="#000000" opacity="${round(dim, 3)}"/>` : '';
    return (
      `<rect width="${width}" height="${height}" fill="#000000"/>` +
      `<image x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
      `preserveAspectRatio="${fit}" href="${dataUri(background.path)}"/>${overlay}`
    );
  }

  private textMarkup(block: TextBlock, opacity: number): string {
    if (block.fit.lines.length === 0 || opacity <= 0) return '';
    const parts: string[] = [];
    block.fit.lines.forEach((line, i) => {
      const y = block.baseline + i * block.fit.lineHeight;
      const x =
        block.align === 'center'
          ? block.x + (this.contentWidth - block.font.width(line, block.fit.fontSize)) / 2
          : block.x;
      parts.push(block.font.glyphPaths(line, block.fit.fontSize, x, y, block.color, opacity));
    });
    return parts.join('');
  }

  /* --------------------------- per frame --------------------------- */

  sceneIndexAt(frame: number): number {
    const scenes = this.timeline.scenes;
    let lo = 0;
    let hi = scenes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frame < scenes[mid].startFrame) hi = mid - 1;
      else if (frame >= scenes[mid].endFrame) lo = mid + 1;
      else return mid;
    }
    return scenes.length - 1;
  }

  /** Content opacity: fades in at the head of a scene and out at its tail. */
  private sceneOpacity(frameInScene: number, sceneFrames: number): number {
    const fadeFrames = Math.min(
      Math.round(this.spec.fade * this.spec.fps),
      Math.floor(sceneFrames / 2),
    );
    if (fadeFrames <= 0) return 1;
    if (frameInScene < fadeFrames) return (frameInScene + 1) / (fadeFrames + 1);
    const fromEnd = sceneFrames - 1 - frameInScene;
    if (fromEnd < fadeFrames) return (fromEnd + 1) / (fadeFrames + 1);
    return 1;
  }

  svgForFrame(frame: number): string {
    const index = this.sceneIndexAt(frame);
    const scene = this.spec.scenes[index];
    const timing = this.timeline.scenes[index];
    const layout = this.sceneLayouts[index];
    const frameInScene = frame - timing.startFrame;
    const progress = timing.frames > 1 ? frameInScene / (timing.frames - 1) : 0;
    const opacity = this.sceneOpacity(frameInScene, timing.frames);

    const background =
      scene.background.type === 'image'
        ? this.backgroundImageMarkup(scene.background, progress)
        : layout.background;

    const parts: string[] = [background];

    if (layout.image) {
      parts.push(
        `<image x="${round(layout.image.x)}" y="${round(layout.image.y)}" width="${round(layout.image.width)}" ` +
          `height="${round(layout.image.height)}" preserveAspectRatio="${layout.image.fit}" ` +
          `opacity="${round(opacity, 3)}" href="${layout.image.href}"/>`,
      );
    }
    if (layout.title) parts.push(this.textMarkup(layout.title, opacity));
    if (layout.body) parts.push(this.textMarkup(layout.body, opacity));

    for (const bullet of layout.bullets) {
      const revealFrames = Math.max(1, Math.round(this.spec.fade * this.spec.fps));
      const since = frame - bullet.revealFrame;
      if (since < 0) continue;
      const reveal = Math.min(1, (since + 1) / revealFrames);
      const bulletOpacity = opacity * reveal;
      parts.push(
        `<circle cx="${round(bullet.markerX)}" cy="${round(bullet.markerY)}" r="${bullet.markerRadius}" ` +
          `fill="${this.spec.theme.accentColor}" opacity="${round(bulletOpacity, 3)}"/>`,
      );
      parts.push(this.textMarkup(bullet, bulletOpacity));
    }

    if (this.spec.captions.enabled) {
      const cue = cueAt(this.timeline.cues, frame);
      if (cue) parts.push(this.captionMarkup(cue));
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.spec.width}" height="${this.spec.height}" ` +
      `viewBox="0 0 ${this.spec.width} ${this.spec.height}">${parts.join('')}</svg>`
    );
  }

  private captionMarkup(cue: Cue): string {
    const layout = this.captionLayouts.get(this.cueIndex.get(cue) as number);
    if (!layout) return '';
    const theme = this.spec.theme;
    const radius = Math.round(theme.captionSize * 0.35);
    const parts = [
      `<rect x="${layout.boxX}" y="${round(layout.boxY)}" width="${round(layout.boxWidth)}" ` +
        `height="${round(layout.boxHeight)}" rx="${radius}" fill="${theme.captionBackground}"/>`,
    ];
    layout.fit.lines.forEach((line, i) => {
      const width = this.bodyFont.width(line, layout.fit.fontSize);
      const x = layout.centerX - width / 2;
      const y = layout.firstBaseline + i * layout.fit.lineHeight;
      parts.push(this.bodyFont.glyphPaths(line, layout.fit.fontSize, x, y, theme.captionColor, 1));
    });
    return parts.join('');
  }

  /** Characters in the spec that the chosen fonts cannot draw. */
  missingGlyphs(): string[] {
    const missing = new Set<string>();
    for (const scene of this.spec.scenes) {
      if (scene.title) for (const c of this.titleFont.missingCodepoints(scene.title)) missing.add(c);
      const bodyText = [scene.body ?? '', ...scene.bullets].join(' ');
      for (const c of this.bodyFont.missingCodepoints(bodyText)) missing.add(c);
    }
    for (const cue of this.timeline.cues) {
      for (const c of this.bodyFont.missingCodepoints(cue.text)) missing.add(c);
    }
    return [...missing];
  }
}
