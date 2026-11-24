// Tiny markdown renderer for exhibits and the case file. It builds React
// elements (never raw HTML), so exhibit text can't inject markup.
// Supports: #/##/### headings, paragraphs (single newlines kept as line
// breaks), **bold**, *italic*, `code`, "- " and "1. " lists (nested by two
// spaces), "> " quotes, "---" rules and pipe tables.
import { Fragment, type ReactNode } from "react";

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|\*(?!\s)(.+?)(?<!\s)\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(<strong key={`${key}-${i++}`}>{inline(m[2], i)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={`${key}-${i++}`}>{inline(m[3], i)}</em>);
    else out.push(<code key={`${key}-${i++}`}>{m[4]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const listRe = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

type ListItem = { text: string; children: ListItem[]; ordered: boolean };

function parseList(lines: string[]): { ordered: boolean; items: ListItem[] } {
  const top: ListItem[] = [];
  const first = lines[0].match(listRe)!;
  const stack: { indent: number; list: ListItem[] }[] = [{ indent: first[1].length, list: top }];
  let lastItem: ListItem | null = null;
  for (const raw of lines) {
    const m = raw.match(listRe);
    if (!m) {
      if (lastItem) lastItem.text += "\n" + raw.trim();
      continue;
    }
    const indent = m[1].replace(/\t/g, "  ").length;
    const item: ListItem = { text: m[3], children: [], ordered: /\d/.test(m[2]) };
    if (indent > stack[stack.length - 1].indent && lastItem) stack.push({ indent, list: lastItem.children });
    else while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].list.push(item);
    lastItem = item;
  }
  return { ordered: top[0]?.ordered ?? false, items: top };
}

function renderList(items: ListItem[], ordered: boolean, key: string): ReactNode {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag key={key}>
      {items.map((it, i) => (
        <li key={i}>
          {it.text.split("\n").map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, j)}</Fragment>)}
          {it.children.length > 0 && renderList(it.children, it.children[0].ordered, `${key}-${i}`)}
        </li>
      ))}
    </Tag>
  );
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as "h2" | "h3" | "h4";
      out.push(<Tag key={k++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(line)) { out.push(<hr key={k++} />); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      const showHead = head.some((c) => c !== "");
      out.push(
        <div className="tablewrap" key={k++}>
          <table className={showHead ? "" : head.length === 2 ? "kv" : ""}>
            {showHead && <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>}
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={k++}>{buf.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, j)}</Fragment>)}</blockquote>);
      continue;
    }
    if (listRe.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && (listRe.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) buf.push(lines[i++]);
      const { ordered, items } = parseList(buf);
      out.push(renderList(items, ordered, `l${k++}`));
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !lines[i].trim().startsWith("|") && !lines[i].startsWith(">") && !listRe.test(lines[i]) && !/^\s*-{3,}\s*$/.test(lines[i])) buf.push(lines[i++]);
    out.push(<p key={k++}>{buf.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, j)}</Fragment>)}</p>);
  }
  return <div className="md">{out}</div>;
}
