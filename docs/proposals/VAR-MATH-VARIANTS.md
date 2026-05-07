# VAR-MATH-Style Problem Variants for pi-braid Benchmark

**Type**: Benchmark Enhancement  
**Based on**: VAR-MATH (2507.12885), AntiLeakBench (2412.13670)  
**Purpose**: Test generalization, not memorization — same skill, different structure

---

## The Core Problem

VAR-MATH found: RL-trained models drop **48-73%** on variabilized benchmarks.
Same skill, different surface form → reveals memorization vs. true understanding.

pi-braid benchmark likely has contaminated problems (standard benchmarks).
If pi-braid scores high on standard problems but low on variants → it's memorizing, not reasoning.

---

## The Variant Generation Framework

```python
class ProblemVariantGenerator:
    """Generate structurally different variants of the same skill."""

    # For each problem type, define what variations exist
    VARIANTS = {
        "flatten_deep": [
            "custom_iter_class",      # __iter__ protocol
            "generator_input",        # generator, not list
            "mixed_iterables",        # list, tuple, generator, dict
            "nested_depth_variance", # different nesting depths
            "empty_and_singletons",  # edge cases
        ],
        "merge_sorted": [
            "custom_comparator",     # key= function
            "descending_order",      # reverse sorted
            "duplicates",            # duplicate elements
            "linked_list",           # different data structure
            "stable_merge",          # stable with equal elements
        ],
        "reverse_words": [
            "char_reversal",         # reverse characters, not words
            "mixed_delimiters",       # comma, space, tab as delimiters
            "unicode_words",          # non-ASCII words
            "empty_and_single",       # edge cases
            "preserve_whitespace",    # whitespace as data
        ],
        "group_anagrams": [
            "case_sensitivity",       # Case-Matters vs case-insensitive
            "unicode_chars",         # non-ASCII characters
            "empty_input",           # edge cases
            "all_same",              # all identical → one group
            "numbers_as_strings",     # "123" treated as word
        ],
        "binary_search": [
            "target_not_found",      # return insertion position
            "duplicates_in_array",    # ambiguous duplicates
            "boundary_cases",         # first, last, single element
            "negative_numbers",       # negative target/range
        ],
        "is_balanced": [
            "mixed_brackets",        # {} [] () together
            "unclosed_opens",        # [[[ → not balanced
            "unclosed_closes",       # ]]] → not balanced
            "single_type_only",      # only one type
            "empty_string",           # trivially balanced
        ],
    }
```

---

## Example: flatten_deep Variants

```python
def generate_flatten_variants():
    """Generate 5 structurally different flatten tasks."""

    base = """
def flatten_deep(lst):
    '''Flatten a nested list recursively.'''
    result = []
    for item in lst:
        if isinstance(item, list):
            result.extend(flatten_deep(item))
        else:
            result.append(item)
    return result
"""

    variants = []

    # V1: Custom __iter__ class
    v1 = base + """

class MyIterable:
    def __init__(self, data):
        self.data = data
    def __iter__(self):
        return iter(self.data)

# Task: flatten_deep with custom iterables
input_data = MyIterable([1, MyIterable([2, 3]), 4])
# Expected: [1, 2, 3, 4]
"""
    variants.append(("flatten_custom_iter", "flatten with __iter__ class", v1))

    # V2: Generator input
    v2 = base + """

def to_generator(lst):
    for item in lst:
        if isinstance(item, list):
            yield from to_generator(item)
        else:
            yield item

# Task: flatten_deep with generator input
input_data = to_generator([1, [2, [3, 4]], 5]])
# Expected: [1, 2, 3, 4, 5]
"""
    variants.append(("flatten_generator", "flatten with generator", v2))

    # V3: Mixed iterables
    v3 = base + """

# Task: flatten_deep with mixed iterables (list, tuple, generator, set)
from collections.abc import Iterable

def flatten_mixed(lst):
    result = []
    for item in lst:
        if isinstance(item, Iterable) and not isinstance(item, (str, bytes)):
            result.extend(flatten_mixed(item))
        else:
            result.append(item)
    return result

input_data = ([1, 2], (3, [4, 5]), [[6]], {7: 8})
# Expected: [1, 2, 3, 4, 5, 6] (sets have no order, sets ignored)
"""
    variants.append(("flatten_mixed", "flatten with mixed iterables", v3))

    # V4: Nested depth variance
    v4 = base + """

# Task: flatten_deep with varying nesting depths
input_data = [1, [2], [[3]], [[[4]]], [[[[5]]]]]
# Expected: [1, 2, 3, 4, 5]
# Challenge: different depths test whether model handles arbitrary nesting
"""
    variants.append(("flatten_depth_variance", "flatten with depth variance", v4))

    # V5: Empty and singletons
    v5 = base + """

# Task: flatten_deep edge cases
input_data = [1, [], [[]], [], [[[]]], 2]
# Expected: [1, 2]
# Challenge: model must handle empty lists at any depth
"""
    variants.append(("flatten_empty_singletons", "flatten with empty edge cases", v5))

    return variants
```

---

## Example: binary_search Variants

```python
def generate_binary_search_variants():
    """Generate structurally different binary search tasks."""

    base = """
def binary_search(arr, target):
    '''Find target in sorted array. Return index or -1.'''
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
"""

    variants = []

    # V1: Target not found → return insertion position
    v1 = base + """

# Task: binary_search for target not in array → return insertion position
arr = [1, 3, 5, 7, 9]
target = 4  # Not in array
# Expected: 2 (insertion position for 4 is index 2)
# Note: standard version returns -1; this expects insertion position
"""
    variants.append(("binary_insertion_pos", "binary search insertion position", v1))

    # V2: Duplicates in array (ambiguous)
    v2 = base + """

# Task: binary_search with duplicates → find ANY index of target
arr = [1, 2, 2, 2, 3, 4, 5]
target = 2
# Multiple valid indices: 1, 2, or 3
# Expected: any of [1, 2, 3] (all correct)
# Challenge: standard binary_search returns first match, but with duplicates, first match varies
"""
    variants.append(("binary_duplicates", "binary search with duplicates", v2))

    # V3: Boundaries
    v3 = base + """

# Task: binary_search at boundaries
arr = [1, 2, 3]  # Single element range
# Test: target = 1 (first), target = 3 (last), target = 2 (middle)
# Expected: 0, 2, 1 respectively
"""
    variants.append(("binary_boundaries", "binary search boundary cases", v3))

    # V4: Negative numbers
    v4 = base + """

# Task: binary_search with negative numbers
arr = [-10, -5, -3, -1, 0, 2, 4]
target = -5
# Expected: 1
"""
    variants.append(("binary_negatives", "binary search with negatives", v4))

    return variants
```

---

## Benchmark Integration

```python
def run_variant_benchmark(trials=3):
    """
    Run both standard and variant problems.
    Compare: if variants << standard → contamination
    """
    standard_results = run_standard_benchmark(trials)
    variant_results = run_variant_benchmark(trials)

    print("\n=== CONTAMINATION ANALYSIS ===")
    for problem in standard_results:
        std_rate = standard_results[problem]
        var_rate = variant_results.get(problem, 0)
        drop = std_rate - var_rate

        if drop > 20:
            status = "🚨 HIGH CONTAMINATION"
        elif drop > 10:
            status = "⚠️ MODERATE CONTAMINATION"
        else:
            status = "✅ CLEAN"

        print(f"{problem}: standard={std_rate:.0f}% variant={var_rate:.0f}% drop={drop:.0f}pp {status}")

    return standard_results, variant_results
```

---

## Expected Results Interpretation

```
If pi-braid scores HIGH on standard but LOW on variants:
  → Model is solving by memorization, not reasoning
  → pi-braid framing doesn't help with Level 1 (memorization)

If pi-braid scores HIGH on both standard AND variants:
  → pi-braid is genuinely improving Level 2 recombination
  → Structured output + contrast phrases are working

If braid-research > braid-full on variants:
  → Structured output + contrast phrases improve generalization
  → Confirms MDA (repetitive format catalyzes ICL circuits)
```

---

## Status

**Ready to implement** — Framework is designed, code patterns provided.
Implementation: Add to `evaluation/benchmark_multi_turn.py` as optional `--variants` flag.

---

*Related: BENCHMARK-IMPROVEMENTS-PROPOSAL.md*