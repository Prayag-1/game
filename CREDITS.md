# Credits

Third-party assets committed to this repository, with their licences.

## Textures

### Walnut board: `packages/web/src/assets/walnut.webp`

- **Source:** "Dark Wood" from Poly Haven,
  https://polyhaven.com/a/dark_wood
- **Authors:** Dimitrios Savva (photography), Dario Barresi (baking),
  Rico Cilliers (tiling)
- **Licence:** CC0 1.0 Universal (public domain dedication).
  https://polyhaven.com/license and
  https://creativecommons.org/publicdomain/zero/1.0/
  No attribution is required; it is given here anyway.
- **Changes:** the 2K diffuse map, scaled to 1024x1024, colour-graded from
  mahogany toward a dark walnut (less red, lower saturation and brightness,
  slightly more contrast), and saved as WebP at quality 72 (36 KB). The
  texture still tiles.
- **Used for:** the floor behind every screen, and the 3D board's surface
  and rim at the table.

## Fonts

### Noto Sans Devanagari

- **Source:** the `@fontsource/noto-sans-devanagari` npm package, self-hosted
  from the build (no font CDN).
- **Licence:** SIL Open Font License 1.1.

## Everything else

The cowrie shells, the mini table boards in the lobby and every other
drawing in the app are drawn in SVG in this repository
(`packages/web/src/components/Shell.tsx`). The 3D board and its cowries are
modelled in code, with no downloaded model
(`packages/web/src/components/table/board3d/`); the shells' slit and teeth
are textures drawn on a canvas at runtime. No artwork, layout or asset was
taken from any other Kauda game.
