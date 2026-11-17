# Chapter titles across books

`titles.ts` reads a chapter title, as a book's table of
contents, headings or PDF outline gives it, into `{kind, label, n, name}`. From that it builds one
`display` for the chapter list and one `spoken` line, which is narrated before the text.

## Corpus

There were 24 files with 1,636 titles. The books were all public domain, from Project Gutenberg's own mirror
(gutenberg.pglaf.org), plus two open-licensed PDFs with outlines:

- **EPUBs:** Alice, Origin of Species, Jane Eyre, Leaves of Grass (370 poems), the illustrated Pride and
  Prejudice, Great Expectations, Romeo and Juliet, Beowulf, Sherlock Holmes, Walden, War and Peace, Moby-Dick,
  Wealth of Nations, Ulysses, Metamorphosis, Frankenstein and A Tale of Two Cities.
- **TXTs:** Pride and Prejudice, Sherlock Holmes, Moby-Dick, Frankenstein and Two Cities.
- **PDFs:** Think Python 2e (CC BY-NC) and Open Data Structures (CC BY).

The corpus isn't committed.

## Failure modes (titles as `parseBook` returns them today)

| Category | Titles | Books | Example |
|---|---:|---:|---|
| Roman numeral as the number (TTS may read "IV" as letters) | 813 | 17 | `CHAPTER IV.` |
| A number only, with no name | 713 | 12 | `CHAPTER I` |
| Trailing full stop | 587 | 10 | `CHAPTER 1. Loomings.` |
| Same title repeated in a book (the parts were dropped) | 410 | 5 | War and Peace: `CHAPTER I` ×15 |
| Label case varies within a book | 228 | 3 | `Chapter I.` next to `CHAPTER II.` |
| ALL CAPS name | 138 | 17 | `XIV. REJOICING OF THE DANES.` |
| The book's own numbering, with no label word | 55 | 2 | `I. A SCANDAL IN BOHEMIA`, and Ride the Tiger's `1: …` |
| A sentence of prose taken as a title (TXT heading search) | 41 | 5 | `part of his face, extending down past the` |
| Illustration caption glued to the heading | 34 | 1 | `He rode a black horse. CHAPTER III.` |
| Gutenberg header or license kept as a chapter | 20 | 17 | `THE FULL PROJECT GUTENBERG™ LICENSE` |
| Front or back matter, unnumbered | 14 | 8 | `PREFACE`, `ETYMOLOGY.`, `ADDENDA.` |
| Decoration or a stray bracket | 15 | 3 | `— I —`, `Chapter I.]` |
| Title page or contents kept as a chapter | 4 | 3 | `PRIDE. and PREJUDICE`, `DETEAILED CONTENTS.` |

The PDF outlines were clean. Their only gap was that the chapter numbers were missing. No PDF in the corpus
had page numbers in its outline, so that rule is tested on constructed cases only.

Some of these are bugs in parsing, not in titles. Normalising titles can only flag them:

1. **The TXT heading regex is too loose.** In `book.ts` `parseTxt`, the pattern `^(chapter|book|part)\b…` matches
   any line that starts with "part of…" or "book;". That splits chapters mid-sentence: 41 bad splits in 5 of
   6 TXTs. It also misses `I. A SCANDAL…` and `Letter 1`. The fix belongs in the regex: require a number or
   number word after the label, and a blank line before the heading.
2. **The Gutenberg license isn't filtered**, and in 17 of 18 Gutenberg EPUBs it comes out as the last
   chapter. `isMatterTitle` has no rule for it.
3. **Parts are lost.** `chapterLevel` lifts "Book One" or "Part II" and then drops it, so War and Peace,
   Two Cities and Wealth of Nations show "Chapter 1" over and over with no context.
4. **The caption is inside the `<h2>`** in the illustrated Pride and Prejudice
   (`<h2><img/><span class="caption">…</span><br/>CHAPTER II.</h2>`). Using the chapter's own heading instead
   of the table of contents doesn't help there. A rule on the text does.

## Recommendation

Use deterministic rules plus a display model that keeps the number and the name apart. Don't add an LLM
pass now.

```ts
type Title = { kind: 'chapter'|'front'|'back'|'skip'; label?: string; n?: number|string; name?: string;
               caption?: string; suspect?: true; display: string; spoken: string; raw: string };
```

The rules, applied in order by `normalizeTitle` and `normalizeChapters`:

1. **Clean up.** Collapse whitespace. Strip decorations (`— I —`, `* * *`) and stray brackets. Drop page
   numbers after dot leaders or a tab every time. Drop a trailing `NN` only when at least 60% of the book's
   titles end in one and those numbers never go down; that is a page column.
2. **Caption glued before the label.** In `<sentence>[.”] CHAPTER X.`, the leading text is an illustration
   caption. It goes into `caption` and leaves the title.
3. **Label and number.** The label is one of Chapter, Book, Part, Act, Scene, Letter, Stave, Canto, Section,
   Volume, Appendix and a few more. The number can be arabic, roman or a word (`Four`, `Fourth`,
   `Twenty-One`, `Book the First`). Whatever follows is the name. `CHAPTERXXVII` is parsed too.
4. **The book's own numbering with no label.** `1: Name`, `IV. NAME` and `12) Name` keep their number. A roman
   number with no label, a bare number, or `3 Name` (an outline's form) counts as a number only when the
   book's numbers count up (1, 2, 3 or I, II, III, restarting at 1). That keeps "L. of G.'s Purport",
   "Catch 22" and "Fahrenheit 451" as names.
5. **Name casing.** Each run set in capitals is title-cased: small words go lower case, roman numerals stay,
   `O'Brien` keeps its capital B and `GRENDEL'S` becomes `Grendel's`. Mixed case is left as the book wrote it,
   because "The way of the program" is the author's choice. A trailing full stop is dropped unless it ends an
   abbreviation. `.—` becomes `—`.
6. **Kind.**
   - `skip` (not narrated): the Gutenberg header and license, contents, copyright, cover, title page, index,
     "Also by", and a title equal to the book's `dc:title`. A Gutenberg header followed by 1,000 or more words
     becomes a `front` chapter called "Opening", so Beowulf's introduction isn't lost.
   - `front`: preface, foreword, introduction, prologue, dedication, Dramatis Personae, Etymology and similar.
   - `back`: epilogue, afterword, appendix, addenda, notes, About the Author and similar.
   - Everything else is a chapter, including a chapter named "Conclusion".
7. **Prefer the chapter's own heading** (an optional `heading` input) when the TOC label has no name and the
   heading has the same number with a name, or when the label is empty, prose or longer than 150 characters.
8. **Display.** Show the name if there is one, else "Chapter 4". The book's own label word is used, and
   "Chapter" is the fallback.
9. **Spoken.** "Chapter 4. Loomings." when the book uses a label. The name alone when the number was the
   book's bare numbering, since adding "Chapter" there would be the app's guess. Numbers are spoken as
   digits.
10. **Prose check.** A title that reads like prose gets `suspect: true`: it starts in lower case, or it runs
    past 10 words and ends mid-clause. That marks a bad split for the caller.
11. **Parts.** A chapter's `part` is normalised the same way, so the UI can group "Chapter 1" under
    "Book Two: 1805". Parsing has to carry the part through first (bug 3 above).

**Why not an LLM pass?** The rules fix every title in the corpus except the bad TXT splits, and those need
a parsing fix, not a better title. An LLM pass on titles alone would cost little. It would run on Claude
Haiku 5.5 ($0.10 per million tokens in, $0.50 out). A 60-chapter book is about 2k tokens in and 3k out, about
$0.002. War and Peace is about $0.01. The costs that matter are elsewhere:

- It adds 2 to 5 seconds of latency on import, or titles that change after the book appears.
- It's nondeterministic: the same file can give different titles.
- It needs a fallback for when the API fails.
- It sends titles to a third party. That's minor, since the text already goes to the TTS providers.

If it's ever wanted, the narrow use is this: run it only on books where the rules leave `suspect` titles,
or where more than half the titles have no name, and ask it for a name, not a rewrite.

## Before and after (representative)

| Before (`parseBook` today) | display | spoken |
|---|---|---|
| `I hope Mr. Bingley will like it. CHAPTER II.` | Chapter 2 | Chapter 2. |
| `“On the Stairs.” CHAPTERXXVII.` | Chapter 27 | Chapter 27. |
| `PRIDE. and PREJUDICE` | *(skip: title page)* | |
| `Chapter I.]` (P&P TXT) | Chapter 1 | Chapter 1. |
| `1: The Modern World and Traditional Man` | The Modern World and Traditional Man | The Modern World and Traditional Man. |
| `CHAPTER 1. Loomings.` | Loomings | Chapter 1. Loomings. |
| `CHAPTER XXXVIII—CONCLUSION` | Conclusion | Chapter 38. Conclusion. |
| `XVII. BANQUET (continued).—THE SCOP’S SONG OF FINN AND HNÆF.` | Banquet (continued)—The Scop’s Song of Finn and Hnæf | Banquet (continued)—The Scop’s Song of Finn and Hnæf. |
| `I. A SCANDAL IN BOHEMIA` | A Scandal in Bohemia | A Scandal in Bohemia. |
| `CHAPTER V. OF THE REAL AND NOMINAL PRICE OF COMMODITIES, …` | Of the Real and Nominal Price of Commodities, … | Chapter 5. Of the Real and Nominal Price of Commodities, … |
| `BOOK IV. CHILDREN OF ADAM` | Children of Adam | Book 4. Children of Adam. |
| `ACT III` | Act 3 | Act 3. |
| `Letter 4` | Letter 4 | Letter 4. |
| `— II —` (Ulysses) | Chapter 2 | Chapter 2. |
| `THE PROLOGUE` | The Prologue *(front)* | The Prologue. |
| `MOBY-DICK; or, THE WHALE.` | *(skip: title page)* | |
| `DETEAILED CONTENTS. ON THE ORIGIN OF SPECIES.` | *(skip: contents)* | |
| `The Project Gutenberg eBook of Beowulf…` (4,969 words) | Opening *(front)* | Opening. |
| `THE FULL PROJECT GUTENBERG™ LICENSE` | *(skip)* | |
| `part of his face, extending down past the` | *(unchanged, `suspect`)* | |

## Decided, and shipped

1. **Captions** are dropped.
2. **A bare `I`, `II`** (Metamorphosis, Ulysses) shows as "Chapter 1".
3. **Front and back matter.** Preface, Introduction and the like are narrated. Dedication,
   Acknowledgments, About the Author, Gutenberg's license and header, and title and contents pages
   are skipped. A Gutenberg header or title page with 1,000 or more words under it becomes "Opening".
4. **A list row** shows the name, or "Chapter 4" when there's none. Each stored chapter keeps its parts
   (`title_parts`: kind, label, n, name, part) so the UI can change later.
5. **Narration** starts with the heading: "Chapter 4. Loomings." when the book uses a word like "Chapter",
   the name alone for a bare-numbered book. A part's name is narrated as the part begins
   ("Book 2. 1805. Chapter 1.").
6. **The parse fixes ship too.**
   - TXT headings must name a section and a number (`isHeadingLine`), so "part of…" and "book;" no longer
     split chapters. A heading that goes on as a sentence ("Chapter 12, and…") is skipped too.
   - TXT is read between Gutenberg's START and END lines. A contents list, recognised when its first
     heading comes again, is passed over.
   - Parts are carried through, whether nested over their chapters or listed beside them. When the
     book's numbered chapters repeat, each list row shows its part: "Book 2 · Chapter 1".

## How it's wired

`book.ts` `keptChapters` reads every book's titles: the server's `parseBook` (EPUB, TXT, PDF) and the
app's `readBook` (the on-device preview) both go through it, so the phone and the server get the same
chapters. Each kept chapter has:

- `title`, the list's line;
- `heading`, what's narrated first (`partsOf` in `jobs.ts`);
- `parts`, the structured title.

`db.ts` stores `heading` and `title_parts` beside `title`. Chapters stored before this have neither and
are narrated by their title, as before. The work runs a chapter per turn and searches only a page's
opening for its heading, so a turn on the phone costs what it did before.
