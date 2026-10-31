#!/usr/bin/env python3
"""Regenerates crates/file-core/tests/fixtures/office/* (needs python-docx, openpyxl, python-pptx and soffice)."""
import pathlib, subprocess, sys, tempfile, shutil
from docx import Document
from docx.enum.text import WD_BREAK
from openpyxl import Workbook
from pptx import Presentation

out = pathlib.Path(__file__).resolve().parent.parent / "crates/file-core/tests/fixtures/office"
out.mkdir(parents=True, exist_ok=True)

d = Document()
d.add_heading("OrangeFile quarterly report", 0)
d.add_paragraph("Résumé: café, naïve, œuvre — accents survive the conversion.")
d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
d.add_paragraph("Second page of the report.")
d.save(out / "report.docx")

wb = Workbook(); ws = wb.active; ws.title = "Sales"
ws.append(["Item", "Qty"]); ws.append(["Oranges", 12]); ws.append(["Pears", 7])
wb.save(out / "sheet.xlsx")

p = Presentation()
for title in ("Welcome slide", "Second slide", "Third slide"):
    s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = title
p.save(out / "deck.pptx")

(out / "note.rtf").write_text(r"{\rtf1\ansi\deff0 {\fonttbl{\f0 Arial;}}\f0\fs24 Plain RTF note for OrangeFile.\par}")

tmp = pathlib.Path(tempfile.mkdtemp())
prof = tmp / "profile"
def conv(src, fmt):
    subprocess.run(["soffice", f"-env:UserInstallation=file://{prof}", "--headless", "--convert-to", fmt, "--outdir", str(tmp), str(src)], check=True, capture_output=True)
conv(out / "report.docx", "odt"); conv(out / "report.docx", "doc")
conv(out / "sheet.xlsx", "xls"); conv(out / "sheet.xlsx", "ods")
conv(out / "deck.pptx", "ppt"); conv(out / "deck.pptx", "odp")
for f in tmp.iterdir():
    if f.suffix in (".odt", ".doc", ".xls", ".ods", ".ppt", ".odp"):
        shutil.copy(f, out / ("report" + f.suffix if f.stem == "report" else f.name))
shutil.rmtree(tmp)
print(sorted(x.name for x in out.iterdir()))
