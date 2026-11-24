#!/usr/bin/env python3
"""Player handouts, split out of the designed exhibits PDF:
  handouts/Case-File.pdf               the case file every team gets
  handouts/Exhibit-List.pdf/.md        titles + public descriptions of all twelve exhibits
  handouts/exhibits/Exhibit-NN.pdf     one file per exhibit (no organiser pages)

Usage: python3 tools/build_handouts.py   (rebuilds Vardhan-Case-Exhibits.pdf first)
Checks: every exhibit file holds its own exhibit's facts and nothing from another exhibit or the organiser report.
"""
import html, os, re, subprocess, sys, tempfile, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_exhibits as bx

ROOT, BIN, CHROME = bx.ROOT, bx.BIN, bx.CHROME
OUT = os.path.join(ROOT, "handouts")
TAG = re.compile(r"E ?X ?H ?I ?B ?I ?T ?(\d(?: ?\d)?)(?![\d/])")


def cards():
    out = {}
    for p in open(os.path.join(ROOT, "game/cards.md"), encoding="utf-8").read().split("\n---\n"):
        m = re.match(r"## Exhibit (\d+): ([^\n]+)\n> ([^\n]+)\n(.*)", p.strip(), re.S)
        if m:
            out[int(m.group(1))] = (m.group(2).strip(), m.group(3).strip(), m.group(4).strip())
    assert len(out) == 12, len(out)
    return out


def page_text(pdf, p):
    return subprocess.run([f"{BIN}/pdftotext", "-f", str(p), "-l", str(p), pdf, "-"], capture_output=True, text=True).stdout


def unite(pdf, pages, dest, tmp):
    for p in pages:
        subprocess.run([f"{BIN}/pdfseparate", "-f", str(p), "-l", str(p), pdf, os.path.join(tmp, f"p{p}.pdf")], check=True)
    subprocess.run([f"{BIN}/pdfunite", *[os.path.join(tmp, f"p{p}.pdf") for p in pages], dest], check=True)


def exhibit_list(cs, dest, tmp):
    src = open(bx.SRC, encoding="utf-8").read()
    style = src[src.index("<style>"):src.index("</style>") + 8]
    rows = "\n".join(f"<tr><td style='width:7%;font-weight:bold;text-align:center'>{n}</td><td style='width:25%'><b>{html.escape(t)}</b></td><td>{html.escape(d)}</td></tr>"
                     for n, (t, d, _) in sorted(cs.items()))
    page = f"""<!doctype html><html><head><meta charset="utf-8">{style}</head><body>
<section class="page cf" style="--z:1.12">
<div class="tag">EXHIBIT LIST</div>
<div class="head"><div class="badge">GOA<br>POLICE</div>
  <div><b>North Goa Police</b><span>The Vardhan case · Distribution: all teams</span></div></div>
<h1>THE TWELVE EXHIBITS</h1>
<div class="sub">Titles and descriptions. Open an exhibit on the website to read it in full.</div>
<div class="ans"><p>Every different exhibit your team opens counts. Of the correct answers, the team that opened the fewest exhibits wins; if two teams opened the same number, the earlier submission wins. Read these descriptions before you open anything.</p></div>
<table>
<tr><th>No.</th><th>Title</th><th>What it contains</th></tr>
{rows}
</table>
</section></body></html>"""
    h = os.path.join(tmp, "list.html")
    open(h, "w", encoding="utf-8").write(page)
    subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={dest}", "file://" + h],
                   check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    md = "# The twelve exhibits\n\nEvery different exhibit your team opens counts. Of the correct answers, the team that opened the fewest exhibits wins; if two teams opened the same number, the earlier submission wins.\n\n"
    md += "\n".join(f"{n}. **{t}.** {d}" for n, (t, d, _) in sorted(cs.items())) + "\n"
    open(dest[:-4] + ".md", "w", encoding="utf-8").write(md)


def main():
    subprocess.run([sys.executable, os.path.join(ROOT, "tools/build_exhibits.py")], check=True)
    pdf = bx.OUT
    n_pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run([f"{BIN}/pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
    groups, case_pages = {}, []
    for p in range(1, n_pages + 1):
        t = page_text(pdf, p)
        if "ORGANISERS ONLY" in t:
            break
        m = TAG.search(t)
        if m:
            groups.setdefault(int(m.group(1).replace(" ", "")), []).append(p)
        elif not groups:
            case_pages.append(p)
    cs = cards()
    assert sorted(groups) == list(range(1, 13)), groups
    assert case_pages, "no case file pages"
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "exhibits"))
    tmp = tempfile.mkdtemp()
    try:
        unite(pdf, case_pages, os.path.join(OUT, "Case-File.pdf"), tmp)
        for n, pages in sorted(groups.items()):
            unite(pdf, pages, os.path.join(OUT, "exhibits", f"Exhibit-{n:02d}.pdf"), tmp)
        exhibit_list(cs, os.path.join(OUT, "Exhibit-List.pdf"), tmp)
    finally:
        shutil.rmtree(tmp)
    # checks
    problems = []
    for n, (title, desc, body) in sorted(cs.items()):
        f = os.path.join(OUT, "exhibits", f"Exhibit-{n:02d}.pdf")
        t = subprocess.run([f"{BIN}/pdftotext", f, "-"], capture_output=True, text=True).stdout
        tags = {int(x.replace(" ", "")) for x in TAG.findall(t)}
        if tags != {n}:
            problems.append(f"Exhibit {n}: tags found {tags}")
        if re.search(r"ORGANISER|answer key|bucket", t, re.I):
            problems.append(f"Exhibit {n}: organiser text leaked")
        nt = bx.norm(t)
        miss = [x for x in bx.facts(body) if x not in nt]
        if miss:
            problems.append(f"Exhibit {n}: facts missing {miss[:5]}")
    ct = bx.norm(subprocess.run([f"{BIN}/pdftotext", os.path.join(OUT, "Case-File.pdf"), "-"], capture_output=True, text=True).stdout)
    for bad in ["auction", "hint", "code", "nine exhibits", "bucket", "organiser"]:
        if bad in ct:
            problems.append(f"Case file mentions '{bad}'")
    lt = bx.norm(subprocess.run([f"{BIN}/pdftotext", os.path.join(OUT, "Exhibit-List.pdf"), "-"], capture_output=True, text=True).stdout)
    for n, (title, desc, _) in cs.items():
        if bx.norm(desc).replace("-", "") not in lt.replace("-", ""):
            problems.append(f"Exhibit list: description {n} not found verbatim")
    info = subprocess.run([f"{BIN}/pdfinfo", os.path.join(OUT, "Exhibit-List.pdf")], capture_output=True, text=True).stdout
    print(f"case file: {len(case_pages)} pages; exhibits: " + ", ".join(f"{n}:{len(p)}p" for n, p in sorted(groups.items()))
          + f"; list: {re.search(r'Pages:\s+(\d+)', info).group(1)} page(s)")
    print("CHECK OK" if not problems else "PROBLEMS:\n- " + "\n- ".join(problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
