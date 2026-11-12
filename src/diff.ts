/** A non-blank line of a file, numbered from 1, trimmed. */
export interface NumberedLine {
  line: number;
  text: string;
}

export interface LineComparison {
  /** Lines only in the first text (WebTranslateIt's copy). */
  onlyBefore: NumberedLine[];
  /** Lines only in the second text (the local file). */
  onlyAfter: NumberedLine[];
}

/**
 * Compares two files line by line, ignoring the order of lines, indentation, trailing whitespace and blank
 * lines. Language files are collections of entries, so a moved line isn't a change. Repeated lines are matched
 * one to one, so a line that appears twice in one file and once in the other is reported once.
 */
export function compareLines(before: string, after: string): LineComparison {
  const unmatched = new Map<string, NumberedLine[]>();
  for (const entry of numberedLines(before)) {
    const sameText = unmatched.get(entry.text);
    if (sameText) sameText.push(entry);
    else unmatched.set(entry.text, [entry]);
  }

  const onlyAfter: NumberedLine[] = [];
  for (const entry of numberedLines(after)) {
    const sameText = unmatched.get(entry.text);
    if (sameText?.length) sameText.shift();
    else onlyAfter.push(entry);
  }

  const onlyBefore = [...unmatched.values()].flat().sort((a, b) => a.line - b.line);
  return { onlyBefore, onlyAfter };
}

function numberedLines(text: string): NumberedLine[] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((entry) => entry.text !== "");
}
