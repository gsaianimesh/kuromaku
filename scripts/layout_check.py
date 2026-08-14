"""
Checks the *printed* layout of submission/Kuromaku.pdf.

    npm run layout-check

Two failures are invisible in a browser and obvious on paper, and both happened
here: a before/after frame printing as a title above an empty box with its
images on the following page, and a caption landing under the next image rather
than its own.

An earlier version of this check measured the HTML in continuous flow, which
reports a split for every element that merely crosses a boundary before the
break rules move it — the opposite of what is being asked. This reads the
rendered PDF, where pagination has already happened.
"""
import sys
import fitz  # PyMuPDF

PDF = "submission/Kuromaku.pdf"

# A caption sits directly under its image. More than this much vertical gap
# between an image's bottom and the next text block means something came
# between them, or the caption was pushed to another page.
MAX_CAPTION_GAP_PT = 26


def main() -> int:
    doc = fitz.open(PDF)
    problems = []
    images_per_page = []

    for pno, page in enumerate(doc, start=1):
        rects = [fitz.Rect(page.get_image_bbox(i)) for i in page.get_images(full=True)]
        rects = [r for r in rects if r.height > 20]
        rects.sort(key=lambda r: r.y0)
        images_per_page.append(len(rects))

        blocks = [b for b in page.get_text("blocks") if b[4].strip()]
        page_bottom = page.rect.y1

        for r in rects:
            # An image flush against the bottom margin with no text under it is
            # the shape a split figure makes: its caption is on the next page.
            below = [b for b in blocks if b[1] >= r.y1 - 2]
            if not below:
                if page_bottom - r.y1 < MAX_CAPTION_GAP_PT:
                    problems.append(
                        f"page {pno}: an image ends {page_bottom - r.y1:.0f}pt from the "
                        f"bottom with no caption under it"
                    )
                continue
            gap = min(b[1] for b in below) - r.y1
            if gap > MAX_CAPTION_GAP_PT * 3:
                problems.append(
                    f"page {pno}: {gap:.0f}pt of white under an image before the next text"
                )

        # A page holding nothing but a little text and a lot of white, directly
        # before a page that opens with an image, is the empty-frame artefact.
        if not rects and blocks:
            used = max(b[3] for b in blocks) - min(b[1] for b in blocks)
            if used < page.rect.height * 0.45 and pno < len(doc):
                problems.append(
                    f"page {pno}: only {used:.0f}pt of content on an otherwise empty page"
                )

    print(f"\n{doc.page_count} pages, {sum(images_per_page)} images placed\n")
    if not problems:
        print("No split figures, no orphaned captions, no near-empty pages.\n")
        return 0
    for p in problems:
        print(f"  {p}")
    print(f"\n{len(problems)} layout problem(s).\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
