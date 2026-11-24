#!/usr/bin/env python3
"""Build Vardhan-Case-Event-Pack.pdf from the md sources via headless Chrome.

Usage: python3 tools/build_pack.py   (run from anywhere)
Needs Google Chrome and poppler (pdftotext, pdfseparate, pdfunite) in /opt/homebrew/bin.
"""
import html, os, re, subprocess, tempfile, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BIN = "/opt/homebrew/bin"
OUT = os.path.join(ROOT, "Vardhan-Case-Event-Pack.pdf")


def rd(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", t)
    return t


def md(text, br=False, hshift=0):
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s or s == "---":
            i += 1
            continue
        m = re.match(r"^\[\[svg:\s*(.+?)\]\]$", s)
        if m:  # inline an SVG file, path relative to the project root
            out.append(f"<div class='svg'>{rd(m.group(1))}</div>")
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", s)
        if m:
            lvl = min(6, len(m.group(1)) + hshift)
            out.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            i += 1
            continue
        if s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            cells = [[c.strip() for c in r.strip("|").split("|")] for r in rows]
            hdr, body = cells[0], [r for r in cells[1:] if not all(re.match(r"^:?-+:?$", c) for c in r)]
            t = "<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in hdr) + "</tr></thead><tbody>"
            for r in body:
                t += "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
            out.append(t + "</tbody></table>")
            continue
        if re.match(r"^(\s*)([-*]|\d+\.)\s+", ln):
            # nested list by indentation
            html_l, stack = [], []
            while i < len(lines) and (re.match(r"^(\s*)([-*]|\d+\.)\s+", lines[i]) or (lines[i].startswith("   ") and lines[i].strip())):
                m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)", lines[i])
                if not m:  # continuation line
                    html_l[-1] = html_l[-1][:-5] + " " + inline(lines[i].strip()) + "</li>"
                    i += 1
                    continue
                ind, mark, body = len(m.group(1)), m.group(2), m.group(3)
                tag = "ol" if mark[0].isdigit() else "ul"
                while stack and ind < stack[-1][0]:
                    html_l.append(f"</{stack.pop()[1]}>")
                if not stack or ind > stack[-1][0]:
                    if stack and html_l and html_l[-1].endswith("</li>"):
                        html_l[-1] = html_l[-1][:-5]
                        stack[-1] = (stack[-1][0], stack[-1][1], True)
                    html_l.append(f"<{tag}>")
                    stack.append((ind, tag, False))
                html_l.append(f"<li>{inline(body)}</li>")
                i += 1
            while stack:
                ind, tag, opened = stack.pop()
                html_l.append(f"</{tag}>")
                if stack and stack[-1][2]:
                    html_l.append("</li>")
            out.append("".join(html_l))
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|\||\s*[-*]\s|\s*\d+\.\s|---)", lines[i].strip()):
            para.append(inline(lines[i].strip()))
            i += 1
        out.append("<p>" + ("<br>" if br else " ").join(para) + "</p>")
    return "\n".join(out)


def section(text, title):
    """Return the body of '## title...' up to the next '## '."""
    m = re.search(r"^## " + re.escape(title) + r".*?$\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    return m.group(0) if m else ""


CSS = """
@page { size: A4; margin: 16mm 15mm 16mm; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.4pt; color: #1d1d1d; line-height: 1.42; margin: 0; }
h1 { font: bold 20pt Georgia; color: #7a1414; margin: 0 0 8px; }
h2 { font: bold 13.5pt Georgia; color: #3b2f25; border-bottom: 1.5px solid #3b2f25; padding-bottom: 2px; margin: 16px 0 7px; }
h3 { font: bold 11.5pt Georgia; color: #3b2f25; margin: 12px 0 5px; page-break-after: avoid; }
h4 { font: bold 10.5pt Georgia; margin: 10px 0 4px; }
p { margin: 5px 0; }
ul, ol { margin: 4px 0 6px; padding-left: 20px; }
li { margin: 2px 0; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 9px; font: 9pt Arial, sans-serif; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: #4a3c30; color: #fff; text-align: left; padding: 4px 6px; font-weight: bold; }
td { border-bottom: 1px solid #d6cfc4; padding: 4px 6px; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f6f1e8; }
code { font: 9pt 'Courier New', monospace; }
.pb { page-break-before: always; }
.svg { margin: 8px 0 12px; page-break-inside: avoid; }
.svg svg { width: 100%; height: auto; }
.part { font: bold 9pt Arial; letter-spacing: 2px; color: #7a1414; text-transform: uppercase; margin-bottom: 4px; }
.cover { height: 255mm; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.cover .t { font: bold 40pt Georgia; color: #2a211b; letter-spacing: 1px; }
.cover .s { font: italic 14pt Georgia; color: #5a4b3e; margin: 10px 0 40px; }
.warn { display: inline-block; margin: 0 auto; border: 2.5px solid #a01818; color: #a01818; font: bold 12pt Arial; padding: 10px 18px; letter-spacing: 1px; }
.toc { margin: 40px auto 0; text-align: left; width: 120mm; font-size: 11pt; }
.card { border: 1.5px solid #3b2f25; padding: 9mm 10mm 8mm; min-height: 225mm; position: relative; background: #fffdf8; }
.card h2 { border: none; font-size: 18pt; color: #7a1414; margin: 0; }
.card .sub { font: italic 10pt Arial; color: #666; margin-bottom: 10px; }
.card .xref { font: bold 9pt Arial; color: #7a1414; margin-top: 10px; }
.custody { position: absolute; left: 10mm; right: 10mm; bottom: 7mm; font: 8pt Arial; color: #444; }
.custody .boxes { display: flex; gap: 4mm; margin-top: 3px; }
.custody .boxes div { flex: 1; height: 9mm; border: 1px solid #888; }
.hidden-tag { font: bold 8pt Arial; letter-spacing: 1.5px; color: #fff; background: #7a1414; display: inline-block; padding: 2px 8px; margin-bottom: 6px; }
.org { background: #a01818; color: #fff; font: bold 9pt Arial; padding: 4px 10px; letter-spacing: 1.5px; display: inline-block; }
"""


def parse_cards(text):
    cards = []
    for part in text.split("\n---\n"):
        m = re.match(r"## Exhibit (\d+): ([^\n]+)\n> ([^\n]+)\n(.*)", part.strip(), re.S)
        if m:
            cards.append((int(m.group(1)), m.group(2).strip(), m.group(3).strip(), m.group(4).strip()))
    return cards


def build():
    cards_md, case_md, rules_md, plot_md, key_md = rd("game/cards.md"), rd("game/case-file.md"), rd("game/rules.md"), rd("plot.md"), rd("game/answer-key.md")
    cards = parse_cards(cards_md)
    assert len(cards) == 12, len(cards)
    h = [f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>"]
    h.append("""<div class='cover'><div class='part'>Pre-induction event · Organiser pack</div>
<div class='t'>THE VARDHAN CASE</div><div class='s'>A murder-mystery deduction game: fewest exhibits wins</div>
<div><span class='warn'>CONTAINS THE SOLUTION · ORGANISERS ONLY</span></div>
<div class='toc'><b>Part 1</b> · How the game runs<br><b>Part 2</b> · Case file<br>
<b>Part 3</b> · The twelve exhibits<br><b>Part 4</b> · Organisers only: solution, FAQ, answer key, buckets, full report</div></div>""")
    rules_body = re.sub(r"^# .*\n", "", rules_md)
    h.append("<div class='pb'></div><div class='part'>Part 1</div><h1>How the game runs</h1>" + md(rules_body))
    case_body = re.sub(r"^# .*\n", "", case_md)
    h.append("<div class='pb'></div><div class='part'>Part 2 · Player handout</div><h1>Case file</h1>" + md(case_body))
    idx = "| # | Title | Public description (on the website) |\n|---|---|---|\n" + "\n".join(f"| {n} | {t} | {d} |" for n, t, d, _ in cards)
    h.append("<div class='pb'></div><div class='part'>Part 3</div><h1>The twelve exhibits</h1>"
             "<p>Players open these on the website. Titles and descriptions are public throughout; every exhibit a team opens counts toward its score.</p>" + md(idx))
    for n, title, desc, body in cards:
        h.append(f"<div class='pb'></div><div class='card'><h2>EXHIBIT {n}</h2><div class='sub'>{html.escape(title)} · {html.escape(desc)}</div>"
                 f"{md(body, br=True)}</div>")
    org = ""
    for t in ["1. Solution", "2. Timeline", "3. Reveal FAQ", "5. Answer key", "6. Organiser key", "7. Combination analysis", "8. How everything connects"]:
        if t.startswith("8.") or t.startswith("9."):
            org += "<div class='pb'></div>"
        org += md(section(plot_md, t))
        if t.startswith("5."):
            org += md(re.sub(r"^# .*\n", "", key_md))
    h.append("<div class='pb'></div><div class='part'>Part 4</div><span class='org'>ORGANISERS ONLY · DO NOT SHOW PLAYERS</span><h1 style='margin-top:8px'>Solution and judging</h1>" + org)
    h.append("</body></html>")

    tmp = tempfile.mkdtemp()
    main_html = os.path.join(tmp, "pack.html")
    with open(main_html, "w", encoding="utf-8") as f:
        f.write("\n".join(h))
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={OUT}", "file://" + main_html],
                   check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    shutil.rmtree(tmp)
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run([f"{BIN}/pdfinfo", OUT], capture_output=True, text=True).stdout).group(1))
    print(f"built {OUT}: {pages} pages")


if __name__ == "__main__":
    build()
