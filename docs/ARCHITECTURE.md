# Architecture

OpenKRK is split so that the karaoke engine can evolve independently from the television presentation.

## Planned boundaries

- `src/main/` — Electron lifecycle, filesystem, dialogs, library workers, persistence
- `src/renderer/` — TV/player/search/operator surfaces
- `src/engine/midi/` — SpessaSynth integration, sequencing, SoundFont lifecycle, preload/cache
- `src/engine/lyrics/` — MIDI/KAR/LRC parsing and timed fragment model
- `src/engine/audio/` — microphone graph, monitoring, echo/reverb, recording
- `src/engine/bgv/` — BGV indexing, selection, crossfade and performance mode
- `src/engine/scoring/` — pitch tracking and scoring model
- `src/library/` — metadata normalization, indexing, search and statistics
- `src/remote/` — phone songbook, pairing and Socket.IO protocol
- `tests/` — parser fixtures, library stress tests and playback state tests

## Performance targets

- 30,000+ MIDI/KAR entries indexed without parsing every MIDI at startup.
- Search results in tens of milliseconds against the local index.
- Bounded parsed-MIDI cache.
- One persistent SoundFont/synth lifecycle instead of rebuilding for every song.
- Next-song prewarm only; no uncontrolled queue preloading.
- Cancellation tokens for superseded loads.
- BGV Performance Mode limited to one decoder.

## Playback state

`idle -> loading -> playing -> score -> next|idle`

Search, operator settings and phone remote are control surfaces over that state machine; they do not own playback themselves.

## Design constraint

The renderer must never become the source of truth for song metadata or queue state. It renders snapshots/events from the engine. This lets us replace the UI without destabilizing playback.
