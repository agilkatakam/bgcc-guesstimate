#!/usr/bin/env python3
"""Organiser study pack: one PDF with everything, for the organising committee.

  Part 1  Study guide (organiser/study-guide.md)
  Part 2  The player handouts: case file and exhibit list, exactly as teams see them
  Part 3  All twelve exhibits as designed, each after an organiser note saying what it proves

Usage: python3 tools/build_study.py   (rebuilds the handouts first)
Output: Vardhan-Case-Organiser-Study-Pack.pdf
"""
import html, os, re, subprocess, sys, tempfile, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_pack as bp

ROOT, CHROME, BIN = bp.ROOT, bp.CHROME, bp.BIN
OUT = os.path.join(ROOT, "Vardhan-Case-Organiser-Study-Pack.pdf")
H = os.path.join(ROOT, "handouts")

GROUP = {1: "A", 4: "A", 8: "A", 3: "B", 5: "B", 7: "B", 6: "C", 10: "C", 12: "C", 2: "D", 9: "D", 11: "D"}
GNAME = {"A": "The police case (the body and Rao)", "B": "The man (Aryan's secrets)",
         "C": "The phone on the night", "D": "The escape (\"Arvind Menon\")"}
CLAIMS = {"A": "Claim 1 (the plate; B supplies the other half) and claim 2 (Rao's chart and van). Also gives the words of the Done text and the tip, which C then traces.",
          "B": "Claim 1 (no fracture ever; A supplies the plate), claim 4 (the motive), and the link that makes 4471 and the 14 March 1981 birthday Aryan's, needed for claims 3 and 5.",
          "C": "Claim 3 (4471 at Siolim at 11:20 or at Mapusa KTC at 1:50) and claim 5 (the Done text from 4471, or the tip from Kankavli). Both need B to tie 4471 to Aryan.",
          "D": "Claim 6 (Arvind Menon, Mumbai to Colombo, 9 Nov, 11:40 PM). Needs B's 4471 or birthday to make Menon Aryan."}

NOTE_CSS = bp.CSS + """
.note { border: 2px solid #a01818; padding: 7mm 8mm; background: #fffaf5; }
.note .kicker { font: bold 9pt Arial; letter-spacing: 2px; color: #a01818; }
.note h1 { margin: 4px 0 2px; }
.note .desc { font: italic 10pt Georgia; color: #555; margin: 2px 0 10px; }
.note dt { font: bold 9pt Arial; letter-spacing: 1px; color: #3b2f25; text-transform: uppercase; margin-top: 9px; }
.note dd { margin: 2px 0 0 0; }
.divider { height: 255mm; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.divider .t { font: bold 30pt Georgia; color: #2a211b; }
.divider .s { font: italic 12pt Georgia; color: #5a4b3e; margin-top: 10px; }
"""


def chrome(html_text, dest, tmp, name):
    p = os.path.join(tmp, name + ".html")
    open(p, "w", encoding="utf-8").write(html_text)
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={dest}", "file://" + p],
                   check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)


def page(body):
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{NOTE_CSS}</style></head><body>{body}</body></html>"


def pages(pdf):
    return int(re.search(r"Pages:\s+(\d+)", subprocess.run([f"{BIN}/pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))


def exhibit_notes(plot):
    """Per exhibit: the organiser description (plot 8.7) and the at-a-glance row (plot 8.8)."""
    s87 = bp.section(plot, "8. How everything connects")
    s87 = s87[s87.index("### 8.7"):s87.index("### 8.8")]
    s88 = s87_88 = bp.section(plot, "8. How everything connects")
    s88 = s88[s88.index("### 8.8"):s88.index("### 8.9")]
    desc = {}
    for m in re.finditer(r"^\*\*Exhibit (\d+): [^*]+\*\* \([A-D]\)\. (.*)$", s87, re.M):
        desc[int(m.group(1))] = re.sub(r'\s*\*"[^*]+"\*\s*$', "", m.group(2)).strip()
    glance = {}
    for m in re.finditer(r"^\| (\d+) \| ([^|]+) \| ([A-D]) \| ([^|]+) \| ([^|]+) \|$", s88, re.M):
        glance[int(m.group(1))] = (m.group(4).strip(), m.group(5).strip())
    assert len(desc) == 12 and len(glance) == 12, (sorted(desc), sorted(glance))
    return desc, glance


def main():
    subprocess.run([sys.executable, os.path.join(ROOT, "tools/build_handouts.py")], check=True)
    plot, guide = bp.rd("plot.md"), bp.rd("organiser/study-guide.md")
    cards = {n: (t, d) for n, t, d, _ in bp.parse_cards(bp.rd("game/cards.md"))}
    desc, glance = exhibit_notes(plot)
    tmp = tempfile.mkdtemp()
    parts = []
    try:
        cover = """<div class='cover'><div class='part'>Pre-induction event · Organising committee</div>
<div class='t'>THE VARDHAN CASE</div><div class='s'>Organiser study pack: the solution, the judging, and every exhibit</div>
<div><span class='warn'>CONTAINS THE SOLUTION · ORGANISERS ONLY</span></div>
<div class='toc'><b>Part 1</b> · Study guide: the game, the solution, timeline, cast, hidden groups, answer key, judging, running the event, questions<br>
<b>Part 2</b> · Player handouts: the case file and the exhibit list, as teams see them<br>
<b>Part 3</b> · The twelve exhibits, each after an organiser note on what it proves</div></div>"""
        body = re.sub(r"^# .*\n", "", guide)
        g = os.path.join(tmp, "guide.pdf")
        chrome(page(cover + "<div class='pb'></div><div class='part'>Part 1 · Organisers only</div><h1>Study guide</h1>" + bp.md(body)), g, tmp, "guide")
        parts.append(g)

        d2 = os.path.join(tmp, "d2.pdf")
        chrome(page("<div class='divider'><div class='part'>Part 2</div><div class='t'>Player handouts</div>"
                    "<div class='s'>The case file (2 pages) and the exhibit list (1 page), exactly as every team gets them.</div></div>"), d2, tmp, "d2")
        parts += [d2, os.path.join(H, "Case-File.pdf"), os.path.join(H, "Exhibit-List.pdf")]

        d3 = os.path.join(tmp, "d3.pdf")
        chrome(page("<div class='divider'><div class='part'>Part 3</div><div class='t'>The twelve exhibits</div>"
                    "<div class='s'>Each exhibit comes after a red-bordered organiser note: its hidden group, what it proves, "
                    "the wrong lead it pushes, and the detail that matters. The exhibit pages themselves are exactly what teams open.</div></div>"), d3, tmp, "d3")
        parts.append(d3)

        for n in range(1, 13):
            gk = GROUP[n]
            sib = ", ".join(str(x) for x in sorted(k for k, v in GROUP.items() if v == gk and k != n))
            title, pub = cards[n]
            loud, quiet = glance[n]
            note = f"""<div class='note'><div class='kicker'>ORGANISER NOTE · NOT FOR PLAYERS</div>
<h1>Exhibit {n}: {html.escape(title)}</h1>
<div class='desc'>What teams see before opening: “{html.escape(pub)}”</div>
<dl>
<dt>Hidden group</dt><dd><b>{gk} · {html.escape(GNAME[gk])}</b>. Same key facts as Exhibits {sib}: a team needs only one of the three.</dd>
<dt>What it is and what it contains</dt><dd>{bp.inline(desc[n])}</dd>
<dt>Claims it supplies</dt><dd>{html.escape(CLAIMS[gk])}</dd>
<dt>The wrong lead it pushes</dt><dd>{bp.inline(loud)}</dd>
<dt>The detail that matters</dt><dd>{bp.inline(quiet)}</dd>
</dl></div>"""
            np_ = os.path.join(tmp, f"n{n}.pdf")
            chrome(page(note), np_, tmp, f"n{n}")
            parts += [np_, os.path.join(H, "exhibits", f"Exhibit-{n:02d}.pdf")]

        subprocess.run([f"{BIN}/pdfunite", *parts, OUT], check=True)
        # checks
        probs = []
        for p in parts:
            if p.startswith(tmp) and os.path.basename(p).startswith("n") and pages(p) != 1:
                probs.append(f"{os.path.basename(p)} runs to {pages(p)} pages")
        txt = subprocess.run([f"{BIN}/pdftotext", OUT, "-"], capture_output=True, text=True).stdout
        for n in range(1, 13):
            if f"Exhibit {n}: {cards[n][0]}" not in txt.replace("\n", " "):
                probs.append(f"note {n} missing")
        print(f"built {OUT}: {pages(OUT)} pages (guide {pages(g)})")
        print("CHECK OK" if not probs else "PROBLEMS: " + "; ".join(probs))
    finally:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
