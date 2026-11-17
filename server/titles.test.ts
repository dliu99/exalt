// Chapter titles as real books give them (Project Gutenberg EPUBs and TXTs, PDF outlines, a
// commercial EPUB's numbering), read into a kind, label, number and name, and shown one way.
import { expect, test } from 'bun:test';
import { normalizeChapters, normalizeTitle, numberOf, titleCase } from './titles.ts';

const shown = (raw: string) => { const t = normalizeTitle(raw); return [t.display, t.spoken]; };

test('numbers are read in digits, roman numerals and words', () => {
  expect([numberOf('4'), numberOf('IV'), numberOf('XLVIII'), numberOf('Four'), numberOf('Fourth'), numberOf('Twenty-One'), numberOf('iv')]).toEqual([4, 4, 48, 4, 4, 21, 4]);
  expect([numberOf('Loomings'), numberOf('IIII'), numberOf('MIXED')]).toEqual([undefined, undefined, undefined]);
});

test('a label and number become the label in title case and digits, the name kept apart', () => {
  // Alice, Moby-Dick, Jane Eyre, A Tale of Two Cities, Frankenstein, Romeo and Juliet
  expect(normalizeTitle('CHAPTER I. Down the Rabbit-Hole')).toMatchObject({ kind: 'chapter', label: 'Chapter', n: 1, name: 'Down the Rabbit-Hole', display: 'Down the Rabbit-Hole', spoken: 'Chapter 1. Down the Rabbit-Hole.' });
  expect(normalizeTitle('CHAPTER 1. Loomings.')).toMatchObject({ n: 1, name: 'Loomings' });
  expect(shown('CHAPTER XXXVIII—CONCLUSION')).toEqual(['Conclusion', 'Chapter 38. Conclusion.']);
  expect(shown('Chapter 7')).toEqual(['Chapter 7', 'Chapter 7.']);
  expect(shown('Letter 4')).toEqual(['Letter 4', 'Letter 4.']);
  expect(shown('ACT III')).toEqual(['Act 3', 'Act 3.']);
  expect(shown('Part the Second')).toEqual(['Part 2', 'Part 2.']);
  expect(shown('Chapter Twenty-One: The Return')).toEqual(['The Return', 'Chapter 21. The Return.']);
  expect(shown('Appendix B: Debugging')).toEqual(['Debugging', 'Appendix B. Debugging.']);
  // Pride and Prejudice: a missing space, a stray bracket from the TXT's illustration markup
  expect(shown('CHAPTERXXVII.')).toEqual(['Chapter 27', 'Chapter 27.']);
  expect(shown('Chapter I.]')).toEqual(['Chapter 1', 'Chapter 1.']);
  // Leaves of Grass: a book of poems named after its number
  expect(normalizeTitle('BOOK IV. CHILDREN OF ADAM')).toMatchObject({ label: 'Book', n: 4, name: 'Children of Adam' });
});

test('an illustration caption glued before its chapter heading is taken off', () => {
  // Pride and Prejudice (Gutenberg's illustrated edition), its NCX labels
  expect(normalizeTitle('I hope Mr. Bingley will like it. CHAPTER II.')).toMatchObject({ n: 2, display: 'Chapter 2', caption: 'I hope Mr. Bingley will like it' });
  expect(normalizeTitle('He rode a black horse. CHAPTER III.')).toMatchObject({ n: 3, display: 'Chapter 3', caption: 'He rode a black horse' });
  expect(normalizeTitle('“Lady Catherine, said she, you have given me a treasure.” CHAPTER XXIX.')).toMatchObject({ n: 29, display: 'Chapter 29', caption: 'Lady Catherine, said she, you have given me a treasure' });
  expect(normalizeTitle('“On the Stairs.” CHAPTERXXVII.')).toMatchObject({ n: 27, caption: 'On the Stairs' });
  // A name after the label is a name, not a caption
  expect(normalizeTitle('CHAPTER XIII. Fifty-two')).toMatchObject({ n: 13, name: 'Fifty-two' });
});

test("a book's own numbering without a label word keeps its number and shows its name", () => {
  // Ride the Tiger (commercial EPUB), Sherlock Holmes, Beowulf
  expect(normalizeTitle('1: The Modern World and Traditional Man')).toMatchObject({ n: 1, name: 'The Modern World and Traditional Man', spoken: 'The Modern World and Traditional Man.' });
  expect(normalizeTitle('2: The End of a Cycle - …').name).toBe('The End of a Cycle - …');
  expect(normalizeTitle('I. A SCANDAL IN BOHEMIA')).toMatchObject({ n: 1, name: 'A Scandal in Bohemia' });
  expect(normalizeTitle('II. SCYLD’S SUCCESSORS.—HROTHGAR’S GREAT MEAD-HALL.').name).toBe('Scyld’s Successors—Hrothgar’s Great Mead-Hall');
  // A section number isn't a chapter number
  expect(normalizeTitle('1.2 Arrays').n).toBeUndefined();
});

test('capitals are title-cased, mixed case is left as the book has it', () => {
  expect(titleCase('OF THE REAL AND NOMINAL PRICE OF COMMODITIES')).toBe('Of the Real and Nominal Price of Commodities');
  expect(titleCase('GEOGRAPHICAL DISTRIBUTION—continued')).toBe('Geographical Distribution—continued');
  expect(titleCase('XVII BANQUET (continued)')).toBe('XVII Banquet (continued)');
  expect(titleCase('HENRY VIII AND O’BRIEN’S HAT')).toBe('Henry VIII and O’Brien’s Hat');
  expect(titleCase('PRIDE and PREJUDICE')).toBe('Pride and Prejudice');
  expect(titleCase('Down the Rabbit-Hole')).toBe('Down the Rabbit-Hole');
  expect(titleCase('The way of the program')).toBe('The way of the program');
  expect(titleCase('THE RED-HEADED LEAGUE')).toBe('The Red-Headed League');
});

test('front and back matter is told from chapters, and boilerplate is skipped', () => {
  const kind = (raw: string) => normalizeTitle(raw).kind;
  expect(['THE FULL PROJECT GUTENBERG™ LICENSE', 'DETEAILED CONTENTS. ON THE ORIGIN OF SPECIES.', 'Table of Contents', 'Copyright', 'Also by Julius Evola', 'List of Illustrations'].map(kind)).toEqual(Array(6).fill('skip'));
  expect(['PREFACE', 'NOTE TO THE THIRD EDITION', 'THE PROLOGUE', 'Dramatis Personæ', 'ETYMOLOGY.', 'INTRODUCTION.', 'Dedication', 'Foreword'].map(kind)).toEqual(Array(8).fill('front'));
  expect(['Epilogue', 'ADDENDA.', 'About the Author', 'Acknowledgments', 'Afterword', 'Appendix A'].map(kind)).toEqual(Array(6).fill('back'));
  // A chapter named Conclusion is a chapter (Walden)
  expect(['Conclusion', 'Economy', 'CHAPTER XXXVIII—CONCLUSION'].map(kind)).toEqual(['chapter', 'chapter', 'chapter']);
});

test('a sentence the TXT heading search took for a title is flagged', () => {
  expect(normalizeTitle('part of his face, extending down past the cheekbones, a black vizard').suspect).toBe(true);
  expect(normalizeTitle('book; and perhaps the vulgar verdict (if indeed a fondness for Miss').suspect).toBe(true);
  expect(normalizeTitle('Brute Neighbors').suspect).toBeUndefined();
});

test('page numbers after dot leaders always go, and trailing numbers go when every title ends in one', () => {
  expect(shown('Chapter 3 ........ 45')).toEqual(['Chapter 3', 'Chapter 3.']);
  expect(normalizeTitle('Introduction\t12').display).toBe('Introduction');
  const outline = normalizeChapters([{ title: 'Preface 7' }, { title: '1 The Way of the Program 15' }, { title: '2 Variables 27' }, { title: '3 Functions 41' }]);
  expect(outline.map((t) => [t.n, t.display])).toEqual([[undefined, 'Preface'], [1, 'The Way of the Program'], [2, 'Variables'], [3, 'Functions']]);
  // Numbers that don't count up are part of the name
  expect(normalizeChapters([{ title: 'Catch 22' }, { title: 'Fahrenheit 451' }, { title: 'Apollo 13' }]).map((t) => t.display)).toEqual(['Catch 22', 'Fahrenheit 451', 'Apollo 13']);
});

test('bare numbers are numbers when the book counts with them', () => {
  // Metamorphosis, Ulysses
  expect(normalizeChapters([{ title: 'I' }, { title: 'II' }, { title: 'III' }]).map((t) => [t.n, t.display])).toEqual([[1, 'Chapter 1'], [2, 'Chapter 2'], [3, 'Chapter 3']]);
  expect(normalizeChapters([{ title: '— I —' }, { title: '— II —' }, { title: '— III —' }]).map((t) => t.display)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  // Leaves of Grass: one roman-looking letter among poem names is a name
  expect(normalizeChapters([{ title: 'Song of Myself' }, { title: 'L. of G.’s Purport' }, { title: 'To You' }])[1]).toMatchObject({ display: 'L. of G.’s Purport' });
});

test("the book's title page and Gutenberg's header are skipped, a long header is kept as the opening", () => {
  const moby = normalizeChapters([{ title: 'MOBY-DICK; or, THE WHALE.' }, { title: 'ETYMOLOGY.' }, { title: 'CHAPTER 1. Loomings.' }], 'Moby Dick; Or, The Whale');
  expect(moby.map((t) => t.kind)).toEqual(['skip', 'front', 'chapter']);
  const pride = normalizeChapters([{ title: 'The Project Gutenberg eBook of Pride and Prejudice', words: 215 }, { title: 'PRIDE. and PREJUDICE' }, { title: 'Chapter I.' }], 'Pride and Prejudice');
  expect(pride.map((t) => t.kind)).toEqual(['skip', 'skip', 'chapter']);
  const origin = normalizeChapters([{ title: 'On the Origin of Species' }, { title: 'INTRODUCTION.' }], 'On the Origin of Species By Means of Natural Selection');
  expect(origin[0].kind).toBe('skip');
  const beowulf = normalizeChapters([{ title: 'The Project Gutenberg eBook of Beowulf: An Anglo-Saxon Epic Poem', words: 4969 }, { title: 'I. THE LIFE AND DEATH OF SCYLD.' }, { title: 'II. SCYLD’S SUCCESSORS.' }], 'Beowulf: An Anglo-Saxon Epic Poem');
  expect(beowulf.map((t) => [t.kind, t.display])).toEqual([['front', 'Opening'], ['chapter', 'The Life and Death of Scyld'], ['chapter', 'Scyld’s Successors']]);
});

test("a chapter's own heading names it when its table of contents label doesn't", () => {
  const [a, b, c] = normalizeChapters([
    { title: 'CHAPTER I', heading: 'CHAPTER I. Down the Rabbit-Hole' },
    { title: 'part of his face, extending down past the', heading: 'II. THE RED-HEADED LEAGUE' },
    { title: 'Chapter 3', heading: 'Chapter 4. Elsewhere' },
  ]);
  expect(a).toMatchObject({ n: 1, name: 'Down the Rabbit-Hole' });
  expect(b).toMatchObject({ n: 2, name: 'The Red-Headed League' });
  expect(b.suspect).toBeUndefined();
  // A heading with another number isn't this chapter's
  expect(c).toMatchObject({ n: 3, display: 'Chapter 3' });
});

test('a part a chapter sits in is read like a title, so "Chapter 1" can repeat across books', () => {
  // War and Peace, A Tale of Two Cities
  const [one, two] = normalizeChapters([{ title: 'CHAPTER I', part: 'BOOK ONE: 1805' }, { title: 'CHAPTER I', part: 'BOOK TWO: 1805' }]);
  expect([one.part?.label, one.part?.n, one.part?.name, two.part?.n, one.display]).toEqual(['Book', 1, '1805', 2, 'Chapter 1']);
});
