# Example video spec

`explainer.json` is a complete four-scene spec. To render it, put your narration
audio in `narration/` under the names the spec refers to — any format ffmpeg
reads (`.wav`, `.mp3`, `.m4a`) — then:

```bash
npm run video -- examples/video/explainer.json --check   # validate, print the timeline
npm run video -- examples/video/explainer.json           # render to out/helm-explainer.mp4
```

Scene lengths come from the narration files, so the spec does not set any
durations. The `text` on each scene is what produces the caption cues; keep it
matching what is actually spoken.

The full spec reference is in [docs/VIDEO.md](../../docs/VIDEO.md).
