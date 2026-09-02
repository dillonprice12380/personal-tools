/**
 * Narrated explainer video rendering.
 *
 * See README-video.md at the repository root for the spec format. The short
 * version: `loadSpecFile` validates a JSON spec, `renderVideo` turns it into an
 * MP4 and then proves the MP4 matches the spec before returning.
 */
export { loadSpecFile, normaliseSpec, parseSrt, PRESETS, SUPPORTED_FPS, type NormaliseOptions } from './spec.js';
export { buildTimeline, cueAt, partition, secondsToFrames, framesToSeconds } from './timeline.js';
export { renderVideo, type RenderOptions, type RenderResult } from './render.js';
export { verifyOutput, type VerificationReport } from './verify.js';
export { toSrt, toVtt, sidecarsFor } from './captions.js';
export { FrameComposer } from './frames.js';
export { fitText, wrap, chunkForCaptions, TextOverflowError } from './text.js';
export * from './types.js';
