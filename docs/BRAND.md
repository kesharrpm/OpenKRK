# OpenKRK visual direction — Signal Theatre

OpenKRK should feel like a karaoke product people remember after one session. It is not a TJ skin, a desktop dashboard, or a neon AI mockup.

## Core visual idea

The BGV is the room. Interface graphics behave like a broadcast layer passing over it: rails, ribbons, cuts, timing lines, score bursts and short-lived control bugs. Large opaque panels are a last resort.

The brand uses **signal crossing** as its motif: two directional bands meeting and separating. This gives us a repeatable visual device for the logo, progress bars, transitions, score reveals and remote pairing without copying another karaoke manufacturer.

## Typography

Use condensed, high-impact display typography for television-facing text. Do not default to Inter/Roboto/Poppins/Montserrat. During development we use locally available condensed system faces and later ship an appropriately licensed project typeface.

Lyrics are their own typographic system and must optimize for distance readability, not brand fashion.

## Color

OpenKRK does not have one permanent purple/cyan palette. The BGV supplies the room color. The UI has three high-contrast signal colors used sparingly:

- Acid lime: ready / confirmation / active progress
- Warm amber: codes / timing / secondary emphasis
- Coral red: energy / score accents / urgent actions

Gradients are directional signals, not card backgrounds.

## Layout rules

1. BGV visible at all times except when a video song intentionally replaces it.
2. Player controls disappear when not being used.
3. Avoid symmetrical centered dashboard layouts.
4. Information enters from screen edges or aligns to rails.
5. Idle mode must feel alive without becoming busy.
6. Karaoke lyrics own the lower-middle safe area and nothing competes with them while singing.
7. Search is a temporary stage takeover, not the default home screen.
8. TV surfaces must work at 1366x768, 1600x900 and 1920x1080.

## Explicit anti-patterns

Do not add glass cards, floating metric tiles, generic blurred blobs, random gradient borders, excessive pills, giant centered logos, fake futuristic grids, or decorative widgets that do not help karaoke interaction.
