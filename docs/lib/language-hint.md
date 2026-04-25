# lib/language-hint.ts

**Purpose**: Language detection for preprocessing — determines if text is English using stopword ratio and character set analysis.

## Key Functions

| Function | Description |
|----------|-------------|
| `isLikelyEnglish(text)` | Returns `true` if >10% of words are English stopwords |

## English Stopwords

~170 common English stopwords: "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out", etc.

## Key Patterns

- **Stopword ratio**: English text has a high density of function words. Non-English text has very few. 10% threshold is a conservative heuristic.
- **No ML dependency**: Pure dictionary lookup — no external API or model needed.
- **Used by**: `user-message-preprocessor` extension to skip non-English text from preprocessing (avoids unnecessary rewrites of non-English messages).
