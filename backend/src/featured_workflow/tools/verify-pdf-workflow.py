#!/usr/bin/env python3
"""Opt-in native clean/extract acceptance using only generated fixture data.
Requires PyMuPDF and the separately installed reviewed PDF-cleaning skill.
No model, provider, user-data or Node calls. --out retains PDF/PNG evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import fitz


def verify(root, project, binary, cleaner):
    document = fitz.open()
    page = document.new_page()
    for y, text in [(70, '爱分享'), (180, '财经资讯'), (300, '390278005'),
                    (430, '会员可免费代查全网资料'), (600, '知识库里没有收录的研报可免费代查')]:
        page.insert_text((60, y), text, fontname='china-s', fontsize=16)
    page = document.new_page()
    page.insert_text((60, 60), 'RESEARCH REPORT: REVENUE AND RISK', fontsize=18)
    page.insert_textbox(fitz.Rect(60, 100, 530, 500),
        'Revenue increased 12% to 1,234 million in fiscal 2025.\n'
        'Cash flow remained positive. The forward outlook is conditional.\n'
        'Risk factors: regulation, customer concentration, and liquidity.\n'
        'Important Disclosures: retain all substantive research evidence.', fontsize=12)
    page = document.new_page()
    page.insert_text((60, 60), 'UNKNOWN TEMPLATE - MUST BE RETAINED', fontsize=16)
    page.insert_textbox(fitz.Rect(60, 100, 530, 500),
        'This page is an unfamiliar appendix. Unknown promotion wording is retained.\n'
        'Research notes and legal information must not be removed without known rules.', fontsize=12)
    source_pdf = root / 'source.pdf'
    document.save(source_pdf)
    document.close()
    environment = dict(os.environ, LLM_RUNTIME='local', LOCAL_DB_PATH=str(root / 'test.sqlite'),
                       LOCAL_DATA_DIR=str(root / 'data'), LOCAL_SCHEDULER='0', XUEQIU_COOKIE_REFRESH='0')
    environment.pop('FEATURED_PDF_CLEANER', None)
    if cleaner:
        environment['FEATURED_PDF_CLEANER'] = str(cleaner)
    output = root / 'output'
    result = subprocess.run([str(binary), '--prepare-featured-report', str(source_pdf), '--out',
                             str(output), '--extract-only'], cwd=project, env=environment,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
    (root / 'native-cli.log').write_text(result.stdout)
    if result.returncode:
        raise RuntimeError(f'native CLI exited {result.returncode}; inspect {root / "native-cli.log"}')
    audit = json.loads((output / 'original.pdf.json').read_text())
    source = json.loads((output / 'source.json').read_text())
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    assert audit['input_pages'] == 3 and audit['output_pages'] == 2
    assert audit['original_pages_kept'] == [2, 3]
    assert audit['source_sha256'] == digest(source_pdf)
    assert audit['output_sha256'] == digest(output / 'original.pdf')
    assert audit['events'] == [{'page': 1, 'action': 'drop_page', 'rule': 'aifenxiang-ad-page'}]
    assert audit['processor']['kind'] == 'local-pdf-cleaner'
    assert audit['processor']['sha256'] == digest(Path(audit['processor']['script']))
    assert 'source' not in audit
    with fitz.open(source_pdf) as before, fitz.open(output / 'original.pdf') as after:
        for original_page, cleaned_page in [(1, 0), (2, 1)]:
            old = before[original_page].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            new = after[cleaned_page].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            assert old.samples == new.samples
            new.save(root / f'cleaned-page-{cleaned_page + 1}.png')
        text = '\n'.join(page.get_text() for page in after)
        assert 'RESEARCH REPORT: REVENUE AND RISK' in text
        assert 'UNKNOWN TEMPLATE - MUST BE RETAINED' in text and '390278005' not in text
    assert source['pageCount'] == 2
    blocks = [block for section in source['sections'] for block in section['blocks']]
    assert len(blocks) >= 4
    assert all(1 <= loc['page'] <= 2 for block in blocks for loc in block['sourceLocations'])
    assert any('Revenue increased 12%' in block['original'] for block in blocks)
    assert any('UNKNOWN TEMPLATE' in block['original'] for block in blocks)
    assert not (output / 'content.json').exists() and not (output / 'cache').exists()
    assert not (output / '.prepare.lock').exists()
    summary = dict(native_cli_exit=0, input_pages=3, output_pages=2, kept_original_pages=[2, 3],
                   cleaning_actions=audit['events'], rendered_retained_pages_pixel_equal=True,
                   source_blocks=len(blocks), source_sha_verified=True, output_sha_verified=True,
                   processor_sha_verified=True, llm_calls=0, directory=str(root))
    (root / 'verification.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--cleaner', type=Path, help='Explicit override; omit to prove native discovery')
    parser.add_argument('--out', type=Path, help='New directory retaining generated fixture evidence')
    args = parser.parse_args()
    if args.out:
        args.out.mkdir(parents=True, exist_ok=False)
        verify(args.out.resolve(), args.project_root.resolve(), args.binary.resolve(), args.cleaner)
    else:
        with tempfile.TemporaryDirectory(prefix='stock-info-featured-real-') as directory:
            verify(Path(directory), args.project_root.resolve(), args.binary.resolve(), args.cleaner)


if __name__ == '__main__':
    main()
