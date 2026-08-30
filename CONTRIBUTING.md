# Contributing

Thanks for helping with NVX Session.

## The `src/pro/` submodule

`src/pro/` is a git submodule that points at a private repository holding the
paid Pro features. In a normal clone it is empty, and that is expected: the free
product is complete without it. The build, the tests and the typecheck all work
with `src/pro/` absent, and continuous integration runs exactly that way. You do
not need access to it to contribute to the free product.

If you clone with `--recursive` and do not have access, the submodule simply
stays empty and nothing breaks.

## Building and testing

    npm install
    npm run build          # dist/, manifest v3
    npm run build:mv2      # dist-mv2/, manifest v2
    npm test               # unit tests
    npm run typecheck
    npm run check          # every shipped script parses, plus a house style sweep

Load `dist/` unpacked in a Chromium browser (developer mode, "Load unpacked").

## House style

- No em dashes in shipped text. `npm run check` enforces it.
- Match the surrounding code: its comment density, naming, and idiom.
- Keep the free product working with the Pro submodule absent. If a change needs
  something from `src/pro/`, it belongs behind the existing gate, never as a hard
  dependency of the free tree.

## Licence

By contributing you agree your contribution is licensed under GPL-3.0, the same
licence as the project.
