from pathlib import Path
import sys
sys.stdout.reconfigure(encoding='utf-8')
import json, zipfile
from openpyxl import load_workbook

root = Path(__file__).resolve().parent.parent
source = root / '【YC】学内施設使用許可願生成マシーン (2).xlsx'
wb = load_workbook(source, data_only=False)
report = []
for ws in wb.worksheets:
    cells = []
    for row in ws:
        for c in row:
            if c.value is not None:
                cells.append({'cell': c.coordinate, 'value': str(c.value)})
    images = []
    for image in ws._images:
        anchor = image.anchor
        start = getattr(anchor, '_from', None)
        images.append({'format': image.format, 'width': image.width, 'height': image.height,
                       'anchor': {'row': start.row+1, 'column': start.col+1} if start else str(anchor)})
    report.append({'sheet': ws.title, 'rows': ws.max_row, 'columns': ws.max_column,
                   'print_area': str(ws.print_area), 'merged_ranges': [str(x) for x in ws.merged_cells.ranges],
                   'cells': cells, 'images': images,
                   'validations': [{'sqref': str(v.sqref), 'formula1': v.formula1, 'type': v.type} for v in ws.data_validations.dataValidation]})
output = root / 'inspection'
output.mkdir(exist_ok=True)
(output / 'workbook-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
for sheet in report:
    print(sheet['sheet'], 'rows=', sheet['rows'], 'cols=', sheet['columns'], 'images=', len(sheet['images']))
    print(json.dumps(sheet['cells'][:100], ensure_ascii=False))
with zipfile.ZipFile(source) as z:
    print('media files:', len([x for x in z.namelist() if x.startswith('xl/media/')]))
