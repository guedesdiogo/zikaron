// Entity normalization, translated from ai-memory's `page.rs` at fc4da03
// (https://github.com/akitaonrails/ai-memory/blob/fc4da03/crates/ai-memory-core/src/page.rs#L161-L203)
// and extended with a diacritic-folded key, so "João" and "joao" name one entity.
//
// ai-memory is MIT licensed:
// Copyright (c) 2026 Fabio Akita
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/** A longer "entity" is a sentence, not a noun. */
export const MAX_ENTITY_LENGTH = 64;
/** Past this, the list stops being a salience signal and becomes a second copy of the body. */
export const MAX_ENTITIES = 10;

export interface Entity {
  /** As written, with whitespace collapsed: "João Silva". */
  name: string;
  /** What lookups match: lowercase, diacritics folded: "joao silva". */
  key: string;
}

/** Null when the name is empty, too long or holds control characters. */
export function normalizeEntity(raw: string): Entity | null {
  const name = raw.trim().split(/\s+/u).join(" ");
  if (name === "" || [...name].length > MAX_ENTITY_LENGTH || /\p{Cc}/u.test(name)) return null;
  return { name, key: foldKey(name) };
}

export function foldKey(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Drops invalid names and duplicates (by key), in order, and keeps at most `MAX_ENTITIES`. */
export function normalizeEntities(raw: readonly string[]): Entity[] {
  const seen = new Set<string>();
  const out: Entity[] = [];
  for (const item of raw) {
    const entity = normalizeEntity(item);
    if (entity === null || seen.has(entity.key)) continue;
    seen.add(entity.key);
    out.push(entity);
    if (out.length === MAX_ENTITIES) break;
  }
  return out;
}
