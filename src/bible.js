// Bible lookups: books, chapters, passages, reference parsing, search.

const ALIASES = { psalms: 'Psalm', 'song of songs': 'Song of Solomon', revelations: 'Revelation' };

export function makeBible(db) {
  const books = db
    .prepare('SELECT book AS name, MAX(chapter) AS chapters FROM verses GROUP BY book ORDER BY MIN(id)')
    .all()
    .map((b) => ({ name: b.name, chapters: b.chapters }));
  const byLower = new Map(books.map((b) => [b.name.toLowerCase(), b.name]));

  const qChapter = db.prepare('SELECT verse, text FROM verses WHERE book=? AND chapter=? ORDER BY verse');
  const qRange = db.prepare(
    'SELECT verse, text FROM verses WHERE book=? AND chapter=? AND verse BETWEEN ? AND ? ORDER BY verse',
  );
  const qSearch = db.prepare(
    "SELECT book, chapter, verse, text FROM verses WHERE text LIKE ? ESCAPE '\\' ORDER BY id LIMIT 40",
  );

  function resolveBook(name) {
    const k = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return byLower.get(k) ?? byLower.get((ALIASES[k] ?? '').toLowerCase()) ?? null;
  }

  /** Parse "John 3:16", "John 3:16-18", "1 John 3". Returns null if not a reference. */
  function parseRef(q) {
    const m = /^\s*(.+?)\s+(\d+)(?::(\d+)(?:\s*-\s*(\d+))?)?\s*$/.exec(q);
    if (!m) return null;
    const book = resolveBook(m[1]);
    if (!book) return null;
    const chapter = +m[2];
    const v1 = m[3] ? +m[3] : null;
    const v2 = m[4] ? +m[4] : v1;
    return { book, chapter, v1, v2 };
  }

  function chapter(book, ch) {
    return qChapter.all(book, ch);
  }

  function passage(book, ch, v1, v2) {
    return qRange.all(book, ch, v1, v2);
  }

  function search(q) {
    const ref = parseRef(q);
    if (ref) {
      const rows = ref.v1 ? passage(ref.book, ref.chapter, ref.v1, ref.v2) : chapter(ref.book, ref.chapter);
      if (rows.length) return { kind: 'passage', ref, verses: rows };
    }
    const term = q.trim();
    if (term.length < 3) return { kind: 'results', results: [] };
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    return { kind: 'results', results: qSearch.all(like) };
  }

  return { books, resolveBook, parseRef, chapter, passage, search };
}

export function refLabel(book, chapter, v1, v2) {
  return v2 && v2 !== v1 ? `${book} ${chapter}:${v1}-${v2}` : `${book} ${chapter}:${v1}`;
}
