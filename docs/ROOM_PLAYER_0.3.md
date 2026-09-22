# OpenKRK Room Player 0.3

This branch is the PC-first karaoke-room prototype built on Electron + HTML/CSS + SpessaSynth.

## Startup flow

1. Full-screen loading poster with a top-left `SONGS LOADING....` readout.
2. Cached library status is checked immediately.
3. When no songs are indexed, the first-run setup asks for:
   - Songs folder: MID / MIDI / KAR
   - BGV folder: MP4 / WEBM / MKV / MOV / M4V
   - Sound bank: SF2 / SF3 / SFOGG / DLS
4. The selected songs folder is indexed without blocking the renderer.
5. A five-second BGV preview plays with a short synthesized OpenKRK intro cue.
6. The room lands on a 10-row NEW SONGS screen with direct numeric entry above it.

Songs and BGVs may share one folder tree or use separate roots.

## Smart new-song detection

The local library is the source of truth.

- `firstSeenAt` records when OpenKRK first discovers a MIDI/KAR file.
- `mtimeMs` records the file modification time.
- The NEW SONGS panel sorts by first-seen time, then modification time.
- On the first scan, modification time provides the useful fallback ordering.
- Generated local song numbers remain stable through rescans.

This avoids making tens of thousands of internet API calls just to decide what was newly added to the karaoke machine.

## Metadata enrichment

When a song actually starts, OpenKRK performs an on-demand metadata lookup instead of blocking the library scan.

- MusicBrainz is used for recording, artist, release and work matching.
- Work relationships are queried for writer/composer/lyricist credits when available.
- Cover Art Archive is used for the matched release cover.
- Results are cached in `openkrk-metadata-cache.json`.
- MusicBrainz requests are throttled to roughly one request per second and include an OpenKRK User-Agent.

If a match fails or the PC is offline, playback continues with the local filename metadata and the built-in cover placeholder.

## Playback UI

- Direct number entry: type a song number and press Enter.
- SpessaSynth renders the local MIDI with the selected sound bank.
- MIDI/KAR lyric events remain time-driven and centered over the moving BGV.
- The intro card shows album art, title, artist, album, date and available credits.
- Romanized/secondary lyric space is already part of the TV layout and can be disabled in System.

## BGV handling

BGVs are not transcoded during startup. OpenKRK indexes them, groups them by folder name, and lets Chromium/Electron decode the selected video in the HTML stage. This keeps startup light and leaves room for a later background pre-analysis/transcode service if a particular codec needs it.

## Android direction

The visual stage intentionally lives in HTML/CSS/JavaScript. The Electron-only bridge is isolated behind `window.openkrk`, so a later Android shell can replace the native file-dialog/filesystem bridge while reusing most of the renderer, song UI, metadata presentation and MIDI logic.

## Branch

`feature/platinum-karaoke-player`
