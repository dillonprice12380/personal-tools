/**
 * Text wrapping and box fitting.
 *
 * Pure functions over a `measure` callback, so they are unit-testable without a
 * font and behave identically to what the renderer draws (the renderer passes
 * the measurer of the very font it draws with).
 *
 * The contract everything else relies on: `fitText` either returns lines that
 * provably fit the box, or it throws. It never returns something that overflows.
 */

export type Measure = (text: string, fontSize: number) => number;

export function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Greedy wrap to `maxWidth`. A single word wider than the box is split across
 * lines rather than allowed to bleed out of it.
 */
export function wrap(text: string, fontSize: number, maxWidth: number, measure: Measure): string[] {
  const words = normaliseWhitespace(text).split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current) {
      lines.push(current);
      current = '';
    }
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (measure(word, fontSize) <= maxWidth) {
      current = word;
    } else {
      // Every piece but the last is complete; the last stays in progress so a
      // following word can still join it.
      const pieces = breakLongWord(word, fontSize, maxWidth, measure);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    }
  }
  pushCurrent();
  return lines;
}

/** Split a word too wide for the box into pieces that each fit. */
function breakLongWord(word: string, fontSize: number, maxWidth: number, measure: Measure): string[] {
  const chars = [...word];
  const pieces: string[] = [];
  let piece = '';
  for (const char of chars) {
    const candidate = piece + char;
    if (piece && measure(candidate, fontSize) > maxWidth) {
      pieces.push(piece);
      piece = char;
    } else {
      piece = candidate;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

export interface FitRequest {
  text: string;
  fontSize: number;
  minFontSize: number;
  maxWidth: number;
  maxHeight: number;
  maxLines: number;
  /** Baseline-to-baseline distance as a multiple of the font size. */
  lineHeightFactor: number;
  measure: Measure;
  /** Used in the error message when the text cannot be made to fit. */
  label: string;
}

export interface FitResult {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  width: number;
  height: number;
}

export class TextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextOverflowError';
  }
}

/**
 * Largest size in `[minFontSize, fontSize]` at which the text fits the box.
 * Throws rather than clipping — a caption that silently loses its last line is
 * worse than a render that stops and says so.
 */
export function fitText(request: FitRequest): FitResult {
  const { text, minFontSize, maxWidth, maxHeight, maxLines, lineHeightFactor, measure, label } = request;
  if (maxWidth <= 0 || maxHeight <= 0) {
    throw new TextOverflowError(`${label}: no room to lay out text (box is ${maxWidth}×${maxHeight}px)`);
  }
  const clean = normaliseWhitespace(text);
  if (!clean) return { lines: [], fontSize: request.fontSize, lineHeight: 0, width: 0, height: 0 };

  const start = Math.max(request.fontSize, minFontSize);
  let closest: { lines: string[]; height: number; size: number } | null = null;

  for (let size = Math.round(start); size >= Math.round(minFontSize); size--) {
    const lines = wrap(clean, size, maxWidth, measure);
    const lineHeight = size * lineHeightFactor;
    const height = lines.length === 0 ? 0 : (lines.length - 1) * lineHeight + size;
    if (lines.length <= maxLines && height <= maxHeight) {
      return {
        lines,
        fontSize: size,
        lineHeight,
        width: Math.max(...lines.map((line) => measure(line, size))),
        height,
      };
    }
    closest = { lines, height, size };
  }

  const detail = closest
    ? `at the minimum size of ${closest.size}px it still needs ${closest.lines.length} line(s) ` +
      `(${Math.ceil(closest.height)}px) but only ${maxLines} line(s) / ${Math.floor(maxHeight)}px are available`
    : 'the box is too small for any supported font size';
  throw new TextOverflowError(
    `${label}: text does not fit — ${detail}. Shorten the text, raise maxLines, or lower theme.minFontSize.\n` +
      `  text: ${JSON.stringify(clean.length > 120 ? `${clean.slice(0, 117)}...` : clean)}`,
  );
}

/**
 * Split narration into caption-sized chunks, preferring sentence ends, then
 * clause boundaries, then word boundaries. Chunks are sized by character budget
 * (line budget × chars per line) because cue timing is derived before any font
 * is known; the renderer re-wraps each chunk with real metrics afterwards.
 */
export function chunkForCaptions(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const budget = Math.max(1, maxCharsPerLine * maxLines);
  const clean = normaliseWhitespace(text);
  if (!clean) return [];

  const chunks: string[] = [];
  for (const sentence of splitSentences(clean)) {
    if (sentence.length <= budget) {
      chunks.push(sentence);
      continue;
    }
    for (const clause of splitOn(sentence, /(?<=[,;:—–])\s+/, budget)) {
      if (clause.length <= budget) chunks.push(clause);
      else chunks.push(...packWords(clause, budget));
    }
  }
  return chunks.filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[^a-z])/).filter(Boolean);
}

/** Split on `pattern`, then re-join neighbours that still fit the budget. */
function splitOn(text: string, pattern: RegExp, budget: number): string[] {
  const parts = text.split(pattern).filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && `${last} ${part}`.length <= budget) merged[merged.length - 1] = `${last} ${part}`;
    else merged.push(part);
  }
  return merged;
}

function packWords(text: string, budget: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > budget) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}
