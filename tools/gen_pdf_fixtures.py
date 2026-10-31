#!/usr/bin/env python3
"""Regenerates the PDF test fixtures. Not part of the build; the output is committed.

    python -m venv .venv && .venv/bin/pip install reportlab pypdf cryptography
    .venv/bin/python tools/gen_pdf_fixtures.py crates/file-core/tests/fixtures/pdf
"""
import io, sys, pathlib
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter, landscape
from pypdf import PdfReader, PdfWriter

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)

def page(c, size, rgb, label):
    c.setPageSize(size)
    c.setFillColorRGB(*rgb)
    c.rect(0, 0, size[0], size[1], stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.setFont("Helvetica-Bold", 36)
    c.drawString(40, size[1] - 80, label)

def make_three():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, invariant=True, pageCompression=0)
    page(c, A4, (0.85, 0.1, 0.1), "Page 1 - red"); c.showPage()
    page(c, landscape(letter), (0.1, 0.6, 0.1), "Page 2 - green"); c.showPage()
    page(c, A4, (0.1, 0.2, 0.85), "Page 3 - blue"); c.showPage()
    c.setTitle("Three pages"); c.save()
    r = PdfReader(io.BytesIO(buf.getvalue()))
    w = PdfWriter()
    for p in r.pages: w.add_page(p)
    w.pages[2].rotate(90)           # page 3 carries /Rotate 90
    w.add_metadata({"/Title": "Three pages", "/Author": "OrangeFile tests"})
    return w

w = make_three()
with open(out / "three-pages.pdf", "wb") as f: w.write(f)

w = make_three()
w.encrypt(user_password="open-sesame", owner_password="owner-secret", algorithm="AES-256")
with open(out / "encrypted.pdf", "wb") as f: w.write(f)

# Opens without a password, but the owner restricted printing/copying/editing.
w = make_three()
w.encrypt(user_password="", owner_password="owner-secret", algorithm="AES-128", permissions_flag=0)
with open(out / "restricted.pdf", "wb") as f: w.write(f)

data = (out / "three-pages.pdf").read_bytes()
(out / "truncated.pdf").write_bytes(data[: len(data) // 2])
(out / "not-a-pdf.pdf").write_bytes(b"This is just text pretending to be a PDF.\n")

# Two more pages, to merge with three-pages.pdf
buf = io.BytesIO(); c = canvas.Canvas(buf, invariant=True, pageCompression=0)
page(c, A4, (0.95, 0.55, 0.05), "Page 1 - orange"); c.showPage()
page(c, A4, (0.55, 0.15, 0.7), "Page 2 - purple"); c.showPage(); c.save()
(out / "second.pdf").write_bytes(buf.getvalue())

# Ten numbered pages, for splitting. Page n has grey level 20*n so each page is recognisable.
buf = io.BytesIO(); c = canvas.Canvas(buf, invariant=True, pageCompression=0)
for n in range(1, 11):
    page(c, A4, (n / 11, 0.2, 1 - n / 11), f"Page {n} of 10"); c.showPage()
c.save(); (out / "ten-pages.pdf").write_bytes(buf.getvalue())

# Five white A4 pages: /Rotate 0, 90, 180, 270, and one whose MediaBox does not start at (0, 0).
# Annotations are placed in "the page as shown", so these pin down the coordinate mapping for every rotation.
w = PdfWriter()
for rot in (0, 90, 180, 270):
    pg = w.add_blank_page(width=595, height=842)
    if rot: pg.rotate(rot)
pg = w.add_blank_page(width=595, height=842)
from pypdf.generic import RectangleObject
pg.mediabox = RectangleObject([100, 50, 695, 892])
pg.cropbox = RectangleObject([100, 50, 695, 892])
with open(out / "rotations.pdf", "wb") as f: w.write(f)

# One huge page (200 x 200 inches, the PDF 1.x maximum) to exercise render size caps.
buf = io.BytesIO(); c = canvas.Canvas(buf, pageCompression=0, invariant=True)
page(c, (14400, 14400), (0.9, 0.5, 0.0), "Huge"); c.showPage(); c.save()
(out / "huge-page.pdf").write_bytes(buf.getvalue())

# Zero pages is legal for the file but useless to us; the app must say so.
w = PdfWriter(); w.add_metadata({"/Title": "Empty"})
with open(out / "no-pages.pdf", "wb") as f: w.write(f)
print("ok", sorted(p.name for p in out.iterdir()))
