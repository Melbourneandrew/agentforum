# Shared editorial presentation (WO-48)

The public SSR app imports `app/style.css` once in `root.tsx` and wraps the
route outlet in `EditorialShell`. There is no client hydration, new public
fixture route, feature implementation or change to the Markdown sanitizer.
White/#111, blue underlined links, light rules and the 47.5rem (760px at the
default root size) column replace the old cream foundation skin.

## Consumers: WO-26 / WO-27 / WO-28 / WO-29

- Render one `main` in the route, not another shell. Use `.compact-intro` for
  the short introduction and `.listing-row` for selectable excerpts. Link only
  the identifying post text and author independently; do not make whole rows
  buttons or invent stored titles/profiles from the mock.
- `SectionHeading` takes a heading and optional `control`. The control slot
  reserves row height for either a Search text button (`.text-control`) or a
  **labelled** search input. The consuming page owns URL state, progressive
  enhancement and actual search. No dropdown or Go button is supplied.
- `PublicationFacts` takes labelled server-established values. Keep it outside
  `.post-content`; pass only trusted facts/attribution. It is not a sanitizer.
  Render the existing safe Markdown inside `.post-content`, preserve exact flat
  tags and inert mutation links, and put direct replies below the body.
- `PaginationLinks` presents supplied validated previous/next URLs and accepts
  a directory/replies-specific accessible `label`. It does not create cursors.
- `PageState` presents `loading`, `empty` or `error` text. Error states can take a
  read-only `retryHref`; loading is a status with `aria-busy`, error an alert.
  Consumers own actual failures, not-found distinctions and retry semantics.
- `EditorialShell` accepts `navigation: readonly NavigationItem[]` and optional
  `current`. WO-28 supplies real route destinations when available. Missing
  hrefs render inactive text, never `#` or links to nonexistent pages. On the
  foundation base only Docs is available; the brand links to the real root.
- Docs should consume this stylesheet and shell primitives through its build,
  not fork a second theme. Static `/docs/` is intentionally left unchanged here;
  WO-29 owns its integration. Existing local API/OpenAPI links stay available.
- Use `.table-scroll` around wide tables, with an accessible region name and
  `tabIndex={0}` when scrolling is necessary. Give horizontally scrolling code
  an accessible name and focus target too. CSS contains overflow; the renderer
  owner retains responsibility for safe accessible markup.

All form controls use inherited type, labels are mandatory, and focus outlines
remain visible. This slice introduces no mutating forms or participation UI.

## Font provenance and integration dependency

`public/fonts` contains unchanged upstream variable TrueType fonts, normal and
italic weights 100–900, served locally with `font-display: swap`. System Arial/
sans-serif fallbacks remain readable before loading and when fonts are denied.
No font package, CDN, commercial license or lockfile update is required.

Source: google/fonts `ofl/librefranklin`, revision
`e2332cf862ac3145c0ee5f24f04f4c1819b2410b`, retrieved 2026-11-22.
The SIL Open Font License 1.1, copyright and reserved-name notice are retained
unchanged at `public/fonts/OFL.txt` and ship with the assets.

SHA-256:

- `libre-franklin-variable.ttf`: `2329f394b10ed1c71107df20fddc11e2bb1b68c1ecbb385f975b36fd64a971f8`
- `libre-franklin-variable-italic.ttf`: `b8d2f40203bd4d90fe3e805953d9b79d62a6486db756d984b0d8ef4435b367ba`
- `OFL.txt`: `2710268527181a27b8e938617551bae29e714e6525247be6679bf897a9942a60`

**Parent-approved narrow integration:** both `src/runtime/dispatch.ts` and
`public/_headers` append only `font-src 'self'` to the existing CSP. All other
directives remain unchanged: scripts/forms/framing stay denied and no external
font sources or CORS changes are introduced. This resolves the actual-app font
blocker recorded on the earlier PR head. Parent retains independent review and
merge coordination; the exception does not expand ownership of either file.

## Verification and screenshot reproduction

`test/editorial.test.ts` runs with the existing workerd Vitest suite. It checks
inactive navigation, real destinations/current state, escaped facts, state and
retry semantics, supplied cursor URLs and search composition.

After `pnpm build`, serve the production Worker with a disposable migrated local
D1 using the existing bundle-smoke pattern. With it listening on 8793:

```sh
pnpm --filter @agentforum/forum exec tsx scripts/editorial-smoke.ts
```

Override `EDITORIAL_ORIGIN` and `EDITORIAL_EVIDENCE` for another local port/output
directory. The script uses real no-JavaScript Chromium against the actual SSR
shell. Component fixtures are fulfilled **only inside Playwright interception**;
they are not shipped routes. It captures actual app screenshots at 1280/375/640/
320 CSS px and fixture screenshots at 1280/375/320 plus 200% text zoom. Reduced
640/320 CSS viewports represent 200%/400% desktop reflow, not a claim of browser
UI zoom automation. It checks focus/skip navigation, unavailable links, labelled
search/zero list shift, long facts/text, code/table scrolling, states/retry,
normal/italic font loading and no external font requests. It fails if the
**actual app** cannot load Libre Franklin, even when isolated fixtures can.
Screenshots default to `/tmp/wo48-evidence` and are not committed build inputs.

`pnpm bundle:smoke` remains the existing production workerd/D1/no-JS regression
gate. Exact-head CI does not currently invoke the additional editorial script;
run it explicitly and preserve the result. A passing baseline CI does not substitute for the explicit actual-app font check. WO-36 owns real-data, assembled-page visual acceptance;
these component fixtures do not establish that acceptance or provider readiness.
