#!/usr/bin/env python3
"""Render game/docs/exhibits.html (case file + twelve designed exhibits + the organiser report from plot.md section 8)
to Vardhan-Case-Exhibits.pdf,
then check that every fact in game/cards.md appears on that exhibit's page(s).

Usage: python3 tools/build_exhibits.py   (run from anywhere)
The designed pages are laid out by hand: after editing cards.md, edit exhibits.html to match and rerun.
"""
import os, re, subprocess, sys, tempfile, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BIN = "/opt/homebrew/bin"
SRC = os.path.join(ROOT, "game/docs/exhibits.html")
OUT = os.path.join(ROOT, "Vardhan-Case-Exhibits.pdf")


def norm(t):
    t = t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    t = t.replace("**", "").replace("*", "").replace("`", "")
    return re.sub(r"\s+", " ", t).lower()


def facts(body):
    """Numbers/times and quoted phrases a player could rely on."""
    out = set(re.findall(r"\d[\d:.,]*\d|\d", body))
    out |= {q for q in re.findall(r'"([^"\n]{2,})"', body) if len(q) >= 4}
    out |= set(re.findall(r"\b[A-Z]{3,}(?: [A-Z]{3,})*\b", body)) - {"ONLY"}
    return {norm(f).strip(" .") for f in out}


REPORT_CSS = """<style>
@page report { size: A4; margin: 14mm 15mm 15mm; }
.report { page: report; page-break-before: always; font-family: Georgia, 'Times New Roman', serif; font-size: 9.8pt; line-height: 1.42; color: #1d1d1d; }
.report .rb { font: bold 9pt Arial; letter-spacing: 1.5px; color: #fff; background: #a01818; padding: 5px 10px; margin-bottom: 8px; }
.report h2 { font: bold 16pt Georgia; color: #7a1414; margin: 4px 0 8px; }
.report h3 { font: bold 11.5pt Georgia; color: #3b2f25; border-bottom: 1.5px solid #3b2f25; padding-bottom: 2px; margin: 14px 0 6px; page-break-after: avoid; }
.report p { margin: 5px 0; } .report ul, .report ol { margin: 4px 0 6px; padding-left: 20px; } .report li { margin: 2px 0; }
.report table { width: 100%; border-collapse: collapse; margin: 6px 0 9px; font: 8.6pt Arial, sans-serif; }
.report tr { page-break-inside: avoid; }
.report th { background: #4a3c30; color: #fff; border: none; padding: 4px 6px; font-size: 8.4pt; }
.report td { border: none; border-bottom: 1px solid #d6cfc4; padding: 4px 6px; }
.report tbody tr:nth-child(even) td { background: #f6f1e8; }
.report .svg { margin: 6px 0 10px; page-break-inside: avoid; } .report .svg svg { width: 100%; height: auto; }
.report code { font: 8.6pt 'Courier New', monospace; }
</style>"""


def report_html():
    """Organiser report (plot.md section 8), rendered after the exhibits. Not exhibit pages: the fact check ignores it."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from build_pack import md, section, rd
    body = md(section(rd("plot.md"), "8. How everything connects"))
    return (REPORT_CSS + "<div class='report'><div class='rb'>ORGANISERS ONLY · CONTAINS THE SOLUTION · "
            "remove these pages before giving this PDF to players</div>" + body + "</div>")


def main():
    src = open(SRC, encoding="utf-8").read()
    assert "<script>" in src
    tmp_html = os.path.join(os.path.dirname(SRC), ".exhibits-build.html")
    with open(tmp_html, "w", encoding="utf-8") as f:
        f.write(src.replace("<script>", report_html() + "\n<script>", 1))
    try:
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={OUT}", "file://" + tmp_html],
                       check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    finally:
        os.remove(tmp_html)
    tmp = tempfile.mkdtemp()
    try:
        subprocess.run([f"{BIN}/pdfseparate", OUT, os.path.join(tmp, "p%d.pdf")], check=True)
        pages = sorted((int(re.search(r"\d+", f).group()), f) for f in os.listdir(tmp))
        texts = [subprocess.run([f"{BIN}/pdftotext", os.path.join(tmp, f), "-"], capture_output=True, text=True).stdout for _, f in pages]
    finally:
        shutil.rmtree(tmp)

    over = [i + 1 for i, t in enumerate(texts) if "PAGE OVERFLOW" in t]
    if over:
        print(f"content overflows page(s) {over}: lower that page's --z in exhibits.html")
    by_ex = {}
    for t in texts:
        m = re.search(r"E ?X ?H ?I ?B ?I ?T ?(\d(?: ?\d)?)(?![\d/])", t)
        if m:
            by_ex.setdefault(int(m.group(1).replace(' ', '')), []).append(t)
    cards = open(os.path.join(ROOT, "game/cards.md"), encoding="utf-8").read()
    bad = 0
    for part in cards.split("\n---\n"):
        m = re.match(r"## Exhibit (\d+): ([^\n]+)\n> ([^\n]+)\n(.*)", part.strip(), re.S)
        if not m:
            continue
        n, body = int(m.group(1)), m.group(4)
        page = norm(" ".join(by_ex.get(n, [])))
        missing = sorted(f for f in facts(body) if f not in page)
        if missing:
            bad += 1
            print(f"Exhibit {n}: missing {missing}")
    print(f"built {OUT}: {len(texts)} pages; " + ("fact check FAILED" if bad else f"fact check ok (all {len(by_ex)} exhibits)"))
    sys.exit(1 if bad or over else 0)


if __name__ == "__main__":
    main()
