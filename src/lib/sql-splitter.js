export function splitStatements(sqlText) {
  const statements = [];
  let current = '';
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i];
    const next = sqlText[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') { current += next; i++; inBlockComment = false; }
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next === "'") { current += next; i++; }
      else if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') inDoubleQuote = false;
      continue;
    }

    if (ch === '-' && next === '-') { inLineComment = true; current += ch; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; current += ch; continue; }
    if (ch === "'") { inSingleQuote = true; current += ch; continue; }
    if (ch === '"') { inDoubleQuote = true; current += ch; continue; }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);

  return statements;
}
