# NFA.cool — modular character generator v2

Generate reusable NFA character artwork locally from transparent PNG parts.
This version replaces universal headwear with eye-aligned glasses, small surface
attachments, floating ornaments, and fitted hats restricted to two body shapes.

The package includes **three sheets / 48 characters**, their individual images,
transparent cutouts, metadata, and browsable galleries under `output/v2-*`.

## Run

Requires Node.js 20.9+ and the pinned sharp dependency. After installation,
generation is local: no AI API, wallet, paid service, or network connection needed.

```sh
npm install
node generate.cjs --count 24 --seed my-collection --out output/my-collection
```

Reproduce the included sheets in new directories:

```sh
node generate.cjs --preset eyewear --out output/my-glasses
node generate.cjs --preset accents --out output/my-accents
node generate.cjs --preset mixed-v2 --out output/my-mixed
```

Open any output folder's `index.html` or `contact-sheet.png`.
The twelve named founding characters remain available with `--preset founding`.

## Accessories

| Trait | Values, in addition to `none` | Placement |
| --- | --- | --- |
| `eyewear` | round-wire, rectangular, oversized-round, half-rim, oval-sun, angular-sun, monocle, clear-visor | Lens centers registered to expression eye landmarks |
| `attachment` | sprout, bow, star-pin, antenna, flower, butterfly | Small part touching the actual silhouette at its anchor |
| `ornament` | halo, sparkles, crown, satellite | Intentionally floating above or beside the head |
| `hat` | beanie, explorer-cap | Separate proportions for sphere and capsule only |

Glasses can combine with one head accent. Attachment, ornament and hat occupy
one shared slot; invalid combinations fail before output is written. Hats are
**opt-in only**, never included in default random batches. Requesting a hat without
a body selects a compatible body; explicitly pairing it with another body fails.
Old headphones, headbands and universal hats are no longer selectable.

```sh
node generate.cjs --count 8 --seed garden --set body=cloud --set eyewear=round-wire --set attachment=sprout --out output/garden
node generate.cjs --count 8 --seed orbit --set ornament=satellite --out output/orbit
node generate.cjs --count 4 --seed cozy --set body=sphere --set hat=beanie --out output/cozy
```

Default random batches have a 45% extra chance of bare eyes after the initial
uniform eyewear draw; head accents are 30% attachments, 20% ornaments and 50% none.
These are sampling defaults, not rarity or scarcity claims. Showcase presets are
curated combinations that cover all new accessories.

## Other traits

| Family | Values |
| --- | --- |
| Body | pebble, cube, star, capsule, sphere, cloud, teardrop, bean |
| Palette | citrus, lilac, apricot, sky, cobalt, mint, butter, rose, graphite, coral, ice, periwinkle |
| Expression | curious, focused, joyful, thoughtful, calm, skeptical, excited, sleepy, surprised, determined |
| Tool | none, magnifier, notebook, pencil, laptop, map, microphone, pen, swatches, shield, bag, telescope, toolkit |
| Finish | clay, rubber, felt, ceramic, frosted, metal |
| Marking | plain, cheeks, freckles, speckles, stripe, symbol |
| Background | studio, archive, garden, observatory, workbench, map-room, reading-nook, gallery, dispatch, recording-booth |
| Frame | portrait, passport, capsule |

Run `node generate.cjs --list-traits` for machine-readable values. Repeat `--set`
to lock traits. Other options: `--size 128..2048`, `--count 1..1000`, `--start 1`,
`--title "Sheet title"`, `--force`. Default image size is 768 × 768; larger sizes
resample raster art. The preset determines its own count (12 or 16).

## Outputs and replay

Each character has `images/001.png`, `cutouts/001.png`, and `metadata/001.json`.
Each batch has `collection.json`, `contact-sheet.png`, and `index.html`.
Metadata includes traits, seed, DNA, version, image checksum and asset digest.

```sh
node generate.cjs --from output/v2-eyewear/metadata/001.json --out output/replay
npm test
```

Nonempty output folders are rejected unless `--force` is supplied. Force replaces
matching filenames but does not remove surplus files; use a new folder for each
collection. Contact sheets show at most the first 100 characters.

SHA-256 counter-based sampling is deterministic. Each ID has an independent seed;
random batches avoid duplicate full trait sets within that batch. This is not a
global uniqueness registry. Replay validates the renderer version and asset hashes.
**v1 manifests require the original v1 package**, because the trait schema and
renderer changed. For byte-for-byte archival reproduction, retain the output PNGs
and the same Node/sharp/libvips/font environment; platform rendering can differ.

## How to extend it

`generate.cjs` contains body face anchors, measured expression eye coordinates,
lens landmarks, compatibility rules, curated presets and the renderer.

- Glasses scale from lens spacing to eye spacing; the monocle targets one eye.
- Small attachments scan the rendered body's alpha at their chosen X position
  and overlap that surface by a few pixels. They do not span the whole head.
- Ornaments use an explicit gap; the satellite floats at the upper right.
- Hats have body-specific width/height/vertical placement parameters. Adding a new
  body requires an intentional fitted variant and visual review.
- Register extra PNG parts and their SHA-256 hashes in `assets/catalog.json`.
- Update `TRAITS`, placement landmarks, and `VERSION` for rendering changes.

`source-atlases/` preserves seven image-generated source sheets.
`node prepare-assets.cjs` rebuilds the 56 trimmed PNG assets, including six retired
legacy headwear parts retained as source material. There are 50 active parts.
Alpha cleanup removes low-opacity residue and isolated specks. Atlas regeneration
is optional; finished parts are bundled.

This is a 2D layer compositor with a soft 3D visual style, not a mesh/rig system.
Bodies use one frontal standing pose. Finishes are color and texture treatments;
backgrounds are vector motifs. Tools sit beside/in front of characters and are
not dynamically gripped. Artwork and accessory traits do not prove an agent has
skills, credentials, access rights or assets. This package does not mint NFTs.

## Validation

`npm test` verifies repeated seeded output and exact manifest replay in the tested
runtime, transparency, 56 asset files, trait locking, invalid input and overwrite
protection, hat/body compatibility, exclusive head slots, and eye registration.
All three included sheets were visually reviewed after generation.
