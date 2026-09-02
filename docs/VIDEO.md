# Video

Helm renders narrated explainer videos from a JSON spec: you supply narration
audio and the words on screen, it produces an MP4 with burnt-in captions and
matching `.srt` / `.vtt` sidecars.

```bash
npm run video -- path/to/spec.json
```

It needs no network, no API key and no account. `ffmpeg` and `ffprobe` ship as
npm dependencies, so there is nothing to install separately.

## Why you can trust the output

Most of this module is checks. The rules it holds itself to:

- **Timing is counted in whole frames, never in seconds.** Every narration file
  is measured by decoding it and counting samples — not by reading a duration
  from the container header, which several formats round. Scene boundaries are
  integers, and the total is the sum of the parts.
- **The audio track is built to the frame count, not fitted to it afterwards.**
  Each scene's audio is generated at exactly `frames × samples-per-frame`
  samples and checked before the next one is built. Offsets go to ffmpeg in
  samples (`adelay=1600S`), never in rounded milliseconds. Frame rates that do
  not divide the sample rate into whole samples are rejected outright, which is
  why `fps` must be 24, 25, 30, 50 or 60.
- **Text is measured with the font it is drawn with.** Every glyph is emitted as
  an outline taken from the same shaped run that measured the line, so the
  renderer cannot substitute a different face and make text wider than the box
  it was fitted to. It also means your text never reaches the XML, so a `&` or a
  `<` in a caption cannot corrupt a frame.
- **Text that will not fit stops the render.** Each block shrinks toward
  `theme.minFontSize` and, if it still overflows, the render fails naming the
  scene, the field and the measurements. Nothing is ever clipped quietly.
- **A missing glyph stops the render.** If the font cannot draw a character it
  is reported rather than rendered as a blank box. `--allow-missing-glyphs`
  overrides this.
- **The finished file is measured, not assumed.** After encoding, the MP4 is
  decoded and checked: frame size, constant frame rate, frame count (counted by
  decoding, not read from the container index), audio sample rate, audio length
  against picture length, and whether the audio is silent or clipping. A
  mismatch is an error and the file is reported as bad.

Everything above is covered by tests in `server/test/video-*.test.ts`,
including tests that the verifier rejects a file that does not match.

## Working on a spec

```bash
npm run video -- spec.json --check          # validate and print the timeline
npm run video -- spec.json --still 150 f.png # render one frame, ~1 second
npm run video -- spec.json                   # render and verify
```

`--check` reports every problem in the spec at once, with the field that caused
each, and proves that every piece of text fits its box — without encoding
anything. `--still` is the fast way to iterate on layout.

Other options:

| Option | Effect |
|---|---|
| `--out <file>` | Write elsewhere than the spec's `output` |
| `--fast` | Quicker encode; frame count read from the index rather than decoded |
| `--crf <n>` | x264 quality, 0–51, lower is better (default 18) |
| `--preset <name>` | x264 speed preset (default `medium`) |
| `--allow-missing-glyphs` | Render even if the font lacks glyphs for some text |
| `--keep-work` | Leave the intermediate audio on disk |

## The spec

Paths are resolved relative to the spec file. Only `scenes` is required.

```jsonc
{
  "output": "out/explainer.mp4",
  "preset": "youtube",        // youtube | square | vertical | shorts | tiktok | reels
  "width": 1920,              // overrides the preset; must be even
  "height": 1080,
  "fps": 30,                  // 24, 25, 30, 50 or 60
  "fade": 0.25,               // seconds of fade in/out on each scene's content

  "theme": {
    "background": { "type": "gradient", "from": "#0b1220", "to": "#1b2a4a", "angle": 120 },
    "fontFile": "fonts/Inter-Regular.ttf",   // optional; a system font is found otherwise
    "boldFontFile": "fonts/Inter-Bold.ttf",
    "titleColor": "#ffffff",
    "bodyColor": "#cbd5e1",
    "accentColor": "#38bdf8",                // bullet markers
    "captionColor": "#ffffff",
    "captionBackground": "#000000b3",
    "safeArea": 0.06,          // fraction of the short edge kept clear of content
    "titleSize": 81,           // pixels; derived from the frame size by default
    "bodySize": 45,
    "captionSize": 43,
    "minFontSize": 21,         // how far text may shrink before the render fails
    "align": "center"          // center | left
  },

  "audio": {
    "music": { "path": "audio/bed.mp3", "gainDb": -26 },
    "sampleRate": 48000
  },

  "captions": {
    "enabled": true,
    "maxCharsPerLine": 42,     // sets how narration is split into cues
    "maxLines": 2,
    "minCueSeconds": 0.7,      // short chunks are merged rather than flashed
    "sidecar": true            // write .srt and .vtt beside the video
  },

  "scenes": [ /* see below */ ]
}
```

### Scenes

A scene needs either a `narration` file or an explicit `duration`.

```jsonc
{
  "id": "intro",
  "narration": {
    "path": "audio/01.wav",
    "text": "The words being spoken. Used to build the caption cues.",
    "gainDb": 0
  },
  "padStart": 0.2,      // silent lead-in before the narration, seconds
  "padEnd": 0.4,        // silent tail after it
  "duration": 8,        // optional: hold the scene longer than the narration

  "title": "What is Helm?",
  "body": "A self-hosted business operating system.",
  "bullets": ["Tasks", "Social", "SEO"],
  "image": { "path": "shots/dashboard.png", "fit": "contain", "maxHeight": 0.55 },
  "background": { "type": "image", "path": "bg.jpg", "dim": 0.4, "kenBurns": 0.06 }
}
```

Scene length is `padStart + narration + padEnd`, with the narration rounded up
to a whole frame so a scene can never cut off a word. Setting `duration` holds
the scene longer; setting it *shorter* than the narration is an error, not a
truncation.

Content is laid out as a vertical stack — title, image, body, bullets — centred
in the area left after the safe margin and the caption band. Bullets appear one
at a time across the narration, and the space for all of them is reserved from
the start so nothing shifts as they arrive.

Backgrounds are `solid` (`color`), `gradient` (`from`, `to`, `angle`) or `image`
(`path`, `fit`, `dim`, `kenBurns`).

### Captions

By default, cues are derived from `narration.text`: the words are split at
sentence and clause boundaries into chunks that fit the line budget, and the
narration's measured length is divided between them in proportion to their
length, using largest-remainder rounding so the cue frames sum to the narration
exactly.

**This is an estimate of when each phrase is spoken, not a transcription.** The
cues start and end with the narration and never drift, but a phrase can land
early or late within it. Where that matters, give real timings instead — the
rendered captions then match them frame for frame:

```jsonc
{ "captions": [ { "start": 0.2, "end": 2.4, "text": "Exactly these words" } ] }
```

or point at an SRT whose times are relative to the scene:

```jsonc
{ "captionsFrom": "captions/scene-01.srt" }
```

A good workflow: render once, open the generated `.srt`, correct the times,
save it next to the scene and re-render with `captionsFrom`.

## Using it from code

```ts
import { loadSpecFile, renderVideo } from './services/video/index.js';

const spec = loadSpecFile('spec.json');
const result = await renderVideo(spec, { onProgress: (done, total) => { /* … */ } });
console.log(result.durationSeconds, result.verification.checks);
```

`renderVideo` throws `VideoSpecError` for a bad spec, `VideoRenderError` if
rendering fails, and `VideoVerificationError` — carrying a `problems` array — if
the encoded file does not match what was asked for.

## Limits

- There is no speech synthesis and no forced alignment. You bring the narration
  audio; word-level caption sync needs real timings (see above).
- Scenes cut rather than cross-fade. Content fades in and out within its own
  scene, which keeps every frame boundary exact; a cross-fade would mean two
  scenes sharing frames.
- Rendering is roughly real time at 1080p30 on a laptop. Frames that are
  identical to their predecessor are rasterised once and reused, so static
  scenes cost almost nothing.
