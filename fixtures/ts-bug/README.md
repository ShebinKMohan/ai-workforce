# ts-bug fixture — paginated search returns a short last page

## Bug report (the wording a user would submit)

> The paginated search endpoint drops results. With 7 matches and a page size of
> 3 the API reports 2 pages, so page 3 is never requested and the last match is
> never shown. `paginate()` also returns one item too few on every page.
> Find the cause and fix it. `npm test` reproduces it.

## What this fixture is

A dependency-free ESM JavaScript project. The only test runner is Node's own
`node:test`, so the fixture needs no install step and no network access.

- `src/pagination.js` — `pageCount()` and `paginate()`. Both contain a real
  off-by-one error.
- `test/pagination.test.js` — tests that pin the intended behaviour. They fail
  against the shipped code and pass once the off-by-one errors are fixed.
- `.workforce/checks.json` — the acceptance check the coordinator runs against a
  frozen candidate.

## Expected behaviour

- `pageCount(total, pageSize)` is the number of pages needed to show every item:
  `pageCount(7, 3) === 3`, and a partial final page still counts.
- `paginate(items, page, pageSize)` returns the `pageSize` items of a 1-based
  page, and the remainder on the final page: `paginate([1..7], 3, 3) === [7]`.
