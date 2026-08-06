# Font licenses

`index.html` embeds three typefaces as base64 `@font-face` sources so the page renders
identically offline and behind a strict content-security policy. All three are licensed
under the **SIL Open Font License 1.1**, which permits embedding and redistribution
provided the copyright notice and license travel with the software.

| Font | Copyright | License | Source |
|---|---|---|---|
| Newsreader | 2020 The Newsreader Project Authors | [OFL-Newsreader.txt](OFL-Newsreader.txt) | [productiontype/Newsreader](https://github.com/productiontype/Newsreader) |
| Public Sans | 2015 The Public Sans Project Authors | [OFL-PublicSans.txt](OFL-PublicSans.txt) | [uswds/public-sans](https://github.com/uswds/public-sans) |
| IBM Plex Mono | 2017 IBM Corp., Reserved Font Name "Plex" | [OFL-IBMPlexMono.txt](OFL-IBMPlexMono.txt) | [IBM/plex](https://github.com/IBM/plex) |

Only the Latin subsets are embedded. `build.js` downloads the `.woff2` files from Google
Fonts on first run and caches them in this directory; the cached binaries are gitignored
because the built `index.html` already carries them.
