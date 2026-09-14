"""Extract page-anchored paragraphs. No images are exported from the source PDF."""
import json
import re
import sys
from collections import Counter
import fitz

doc = fitz.open(sys.argv[1])
if doc.needs_pass:
    raise RuntimeError('PDF is encrypted; supply an unlocked copy')
pages, issues = [], []
for index, page in enumerate(doc):
    # Text coordinates use unrotated page space; transform to displayed space below.
    raw = page.get_text('dict', sort=True)
    text_length = sum(len(s['text']) for b in raw['blocks'] if b['type'] == 0 for l in b['lines'] for s in l['spans'])
    if text_length < 40 and page.get_images():
        try:
            tp = page.get_textpage_ocr(language='eng+chi_sim', dpi=200, full=True)
            raw = page.get_text('dict', textpage=tp, sort=True)
            issues.append(f'第 {index+1} 页使用 OCR，请核对数字与阅读顺序')
        except Exception as e:
            raise RuntimeError(f'第 {index+1} 页缺少文本层，OCR 不可用；请安装 Tesseract 及 eng/chi_sim 语言包: {e}')
    elif page.get_images():
        issues.append(f'第 {index+1} 页包含图片；请核对图表文字是否已提取，必要时补译（图表保留在原 PDF）')
    blocks = []
    tables = []
    if text_length >= 40:
        try:
            for table in page.find_tables().tables:
                if table.row_count > 1 and table.col_count > 1:
                    tables.append((fitz.Rect(table.bbox), table.to_markdown()))
        except Exception:
            issues.append(f'第 {index+1} 页表格结构识别失败，请核对行列关系')
    for b in raw['blocks']:
        if b['type'] != 0:
            continue
        if any(rect.contains(fitz.Rect(b['bbox'])) for rect, _ in tables):
            continue
        lines = [''.join(s['text'] for s in l['spans']).strip() for l in b['lines']]
        text = '\n'.join(x for x in lines if x).strip()
        if not text:
            continue
        rect = fitz.Rect(b['bbox']) * page.rotation_matrix
        bbox = [rect.x0/page.rect.width, rect.y0/page.rect.height, rect.x1/page.rect.width, rect.y1/page.rect.height]
        bbox = [max(0, min(1, v)) for v in bbox]
        if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
            continue
        sizes = [s['size'] for l in b['lines'] for s in l['spans']]
        blocks.append(dict(text=text, bbox=bbox, size=max(sizes or [10])))
    for rect, markdown in tables:
        rect = rect * page.rotation_matrix
        bbox = [rect.x0/page.rect.width, rect.y0/page.rect.height, rect.x1/page.rect.width, rect.y1/page.rect.height]
        blocks.append(dict(text=markdown, bbox=[max(0, min(1, v)) for v in bbox], size=10))
    blocks.sort(key=lambda b: (b['bbox'][1], b['bbox'][0]))
    size_weights = Counter()
    for b in blocks:
        size_weights[b['size']] += len(b['text'])
    body_size = size_weights.most_common(1)[0][0] if size_weights else 10
    # In a two-column layout, short full-width headings also terminate a band.
    # Their ink bbox need not cross the column gutter.
    narrow = [b for b in blocks if b['bbox'][2]-b['bbox'][0] < .48]
    if any(b['bbox'][0] >= .48 for b in narrow) and any(b['bbox'][2] <= .52 for b in narrow):
        spanning = sorted([b for b in blocks if b['bbox'][0] < .45 and (b['bbox'][2] > .55 or b['size'] >= body_size*1.25)], key=lambda b: b['bbox'][1])
        ordered, pending = [], [b for b in blocks if b not in spanning]
        for wide in spanning + [None]:
            before = [b for b in pending if wide is None or b['bbox'][1] < wide['bbox'][1]]
            ordered.extend(sorted(before, key=lambda b: (b['bbox'][0] >= .48, b['bbox'][1], b['bbox'][0])))
            pending = [b for b in pending if b not in before]
            if wide:
                ordered.append(wide)
        blocks = ordered
    if not blocks:
        issues.append(f'第 {index+1} 页没有可提取文字，请确认是否为空白页')
    pages.append(blocks)

margin_counts = Counter(b['text'] for page in pages for b in page if b['bbox'][1] < .07 or b['bbox'][3] > .95)
toc = {entry[2]: entry[1] for entry in doc.get_toc() if entry[0] == 1}
sections, current = [], None
for p, blocks in enumerate(pages, 1):
    if p in toc:
        current = dict(id=f'section-{len(sections)+1}', title=toc[p], blocks=[])
        sections.append(current)
    body_sizes = Counter()
    for b in blocks:
        body_sizes[b['size']] += len(b['text'])
    typical = body_sizes.most_common(1)[0][0] if body_sizes else 10
    for i, block in enumerate(blocks, 1):
        text = block['text']
        if (block['bbox'][1] < .07 or block['bbox'][3] > .95) and (margin_counts[text] >= max(3, len(doc)*.5) or re.fullmatch(r'\d+', text)):
            continue
        heading = len(text) < 160 and '\n' not in text and block['size'] >= typical * 1.25
        if current is None or (heading and current['blocks']):
            current = dict(id=f'section-{len(sections)+1}', title=text if heading else f'第 {p} 页', blocks=[])
            sections.append(current)
        current['blocks'].append(dict(id=f'p{p}-b{i}', original=text, sourceLocations=[dict(page=p, bbox=block['bbox'])]))
sections = [s for s in sections if s['blocks']]
if not sections:
    raise RuntimeError('No text extracted')
print(json.dumps(dict(pageCount=len(doc), title=doc.metadata.get('title') or '', sections=sections, issues=issues), ensure_ascii=False))
