# Brand

    node brand/banner.cjs

Builds every banner from `banner.html`, so they cannot drift apart:

| file | size | for |
| --- | --- | --- |
| `cover.png` | 1024x576 | App Directory cover |
| `banner.png` | 1920x1080 | og:image for the site |
| `profile-banner.png` | 680x240 | Discord profile banner |
| `profile-banner-2x.png` | 1360x480 | the same at 2x |
| `x-header.png` | 1500x500 | X header |
| `x-header-2x.png` | 3000x1000 | the same at 2x |

The same look as the site: a neutral dark ground, the shield on its blue tile, the
wordmark, the claim, then what it does. Blue appears on the mark and nowhere else. No glow
and no grid.

The tile is the avatar in miniature: `#0b62d6` with a white shield and the check cut back
out in the same blue, as in `src/web/public/icon-avatar.svg`. RaidProtector's banners are
built the same way, in its violet.

Set in IBM Plex, so the banners are rendered by headless Chrome, which loads Plex the way
the site does. The script finds Chrome or Edge in the usual places, or set `CHROME`. It
checks every file's size against what was asked for and fails if one is off.

The files land here. The site serves its own copies from `src/web/public`, which are
swapped deliberately rather than overwritten by this script.
