# Credits

booktier is an original implementation, not a fork. It was written after reading nine
open-source tier list projects, and it borrows techniques — not code — from three of them.
Each is named here with what was taken.

## Techniques adapted

**[silverweed/tiers](https://github.com/silverweed/tiers)** — WTFPL (no obligations).
- Geometry-based drag insertion: compute the insertion index from item rectangles and show a
  marker line, instead of swapping items on hover. Reimplemented for pointer events in
  `src/editor/dnd.js`.
- Loading a tier list document from a `?url=` query parameter. Reimplemented with origin and
  schema validation as `?data=` in `src/io/loadUrl.js`.

**[milk3e/Tier-List-Maker](https://github.com/milk3e/Tier-List-Maker)** — CC0 (public domain).
- Per-item metadata beyond the image, and a hover overlay that shows it. booktier folds this
  into the item record rather than a parallel side-table, and renders the card in CSS so it
  works without JavaScript.
- Its dependency-free canvas PNG exporter is the model for `src/export/png.js`.

**[nathan71370/tierlistrr](https://github.com/nathan71370/tierlistrr)** — MIT.
- The shape of `groupByPlacement` / `toPlacements`: keep a flat item list as the source of
  truth and derive tier-keyed groups. Reimplemented in `src/core/group.js`.
- Its mean-of-tier-index consensus algorithm is the reference for a possible multi-list
  comparison feature.

## Studied, nothing taken

**[infinia-yzl/opentierboy](https://github.com/infinia-yzl/opentierboy)** and
**[Elliot67/tier-list-now](https://github.com/Elliot67/tier-list-now)** are AGPL-3.0. Copying
code from either would force AGPL on this project including hosted deployments, so no code was
copied from them. Their compressed-URL state design informed the decision documented in
`ARCHITECTURE.md` §5 to make a JSON file the state of record instead.

**zhangchenchen/tier_list_maker** carries a proprietary license that forbids redistributing its
source, despite a README that says MIT. Nothing from it was used.

**Bretimproper361/Tier-List-Maker** has no license, and ships a Windows executable archive
unrelated to its web app. Avoided.
