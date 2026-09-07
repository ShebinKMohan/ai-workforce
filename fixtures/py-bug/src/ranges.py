"""Range helpers used by the report generator."""


def inclusive_range(start, end):
    """Every integer from ``start`` to ``end``, with ``end`` included.

    BUG: ``range`` stops before ``end``, so the final value is missing.
    """
    if end < start:
        return []
    return list(range(start, end))


def chunk(values, size):
    """Split ``values`` into consecutive chunks of ``size``.

    BUG: the loop stops before the final partial chunk, so the remaining
    values are silently dropped.
    """
    if size <= 0:
        raise ValueError("size must be greater than zero")
    chunks = []
    for start in range(0, len(values) - size + 1, size):
        chunks.append(values[start:start + size])
    return chunks
