# Font licenses

`index.html` embeds two typefaces as base64 `@font-face` sources so the page renders
identically offline and behind a strict content-security policy. Both are members of the
IBM Plex family, licensed under the **SIL Open Font License 1.1**, which permits embedding
and redistribution provided the copyright notice and license travel with the software.

| Font | Used for | Copyright | License |
|---|---|---|---|
| IBM Plex Sans | Interface text | © 2017 IBM Corp., Reserved Font Name "Plex" | [OFL-IBMPlex.txt](OFL-IBMPlex.txt) |
| IBM Plex Mono | Dates, counts, key hints | © 2017 IBM Corp., Reserved Font Name "Plex" | [OFL-IBMPlex.txt](OFL-IBMPlex.txt) |

Source: [IBM/plex](https://github.com/IBM/plex). Only the Latin subsets are embedded, and
IBM Plex Sans ships as a single variable file covering every weight the interface uses.

`build.js` downloads the `.woff2` files from Google Fonts on first run and caches them in
this directory; the cached binaries are gitignored because the built `index.html` already
carries them.
