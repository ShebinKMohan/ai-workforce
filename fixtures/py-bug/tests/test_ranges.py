import unittest

from src.ranges import chunk, inclusive_range


class InclusiveRangeTests(unittest.TestCase):
    def test_includes_the_end_value(self):
        self.assertEqual(inclusive_range(1, 5), [1, 2, 3, 4, 5])

    def test_single_value_range(self):
        self.assertEqual(inclusive_range(3, 3), [3])

    def test_empty_when_end_precedes_start(self):
        self.assertEqual(inclusive_range(5, 1), [])


class ChunkTests(unittest.TestCase):
    def test_keeps_the_final_short_chunk(self):
        self.assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_exact_multiple(self):
        self.assertEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])

    def test_every_value_appears_once(self):
        values = list(inclusive_range(1, 7))
        flattened = [value for group in chunk(values, 3) for value in group]
        self.assertEqual(flattened, values)

    def test_rejects_non_positive_size(self):
        with self.assertRaises(ValueError):
            chunk([1, 2], 0)


if __name__ == "__main__":
    unittest.main()
