# py-bug fixture — inclusive range helper skips the last value

## Bug report (the wording a user would submit)

> `inclusive_range(1, 5)` should give me [1, 2, 3, 4, 5] but the last value is
> missing, and `chunk()` built on top of it drops the final short chunk. Our
> report generator ends one row early because of it. Please fix the underlying
> issue; `python3 -m unittest discover -v` reproduces it.

## What this fixture is

A dependency-free Python project using the standard library `unittest` runner,
so it needs no install step and no network access.

- `src/ranges.py` — `inclusive_range()` and `chunk()`, both with a real
  off-by-one error.
- `tests/test_ranges.py` — tests that pin the intended behaviour. They fail
  against the shipped code and pass once the off-by-one errors are fixed.

## Expected behaviour

- `inclusive_range(start, end)` includes `end`: `inclusive_range(1, 5)` is
  `[1, 2, 3, 4, 5]`, and `inclusive_range(3, 3)` is `[3]`.
- `chunk(values, size)` returns consecutive chunks and keeps the final short
  chunk: `chunk([1, 2, 3, 4, 5], 2)` is `[[1, 2], [3, 4], [5]]`.
