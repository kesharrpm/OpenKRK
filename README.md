# OpenKRK

OpenKRK is an open-source karaoke machine project focused on fast local libraries, MIDI/KAR playback, motion BGVs, precise lyric timing, scoring, and a distinctive TV-first interface.

## Status

Early production. The application is being rebuilt from first principles in this repository.

## Product principles

- **BGV-first:** the television is a living karaoke canvas, not a dashboard.
- **Original identity:** no TJ clone, no generic AI dashboard, no glassmorphism template language.
- **Karaoke-native interaction:** number entry, search, queue, remote, playback, and operator tools are first-class.
- **Large-library performance:** indexing/search must remain responsive with 30,000+ MIDI/KAR files.
- **Timing accuracy:** MIDI/KAR lyric rendering is event-driven and syllable-accurate.
- **Reliable playback:** persistent SoundFont engine, bounded caches, cancellation, preload, and recovery paths.
- **TV readability:** every playback surface is designed for distance viewing and moving backgrounds.

## Room Player 0.3 prototype

The `feature/platinum-karaoke-player` branch contains the PC-first loading/setup/new-songs/player flow, local freshness detection, SpessaSynth playback, BGV rotation, and on-demand MusicBrainz/Cover Art Archive metadata. See `docs/ROOM_PLAYER_0.3.md` for the flow and architecture.

## Development

Active work happens on production branches and lands through reviewed pull requests.

License and contributor documentation will be added before the first public beta.
