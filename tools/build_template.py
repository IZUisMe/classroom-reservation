"""Sanitize the official form; never modify the original workbook.
Run with bundled Python, then export public/templates/application.xlsx with the
LibreOffice Kit CLI documented in docs/pdf-template.md.
"""
from pathlib import Path
from copy import copy
import json
from openpyxl import load_workbook
from openpyxl.packaging.core import DocumentProperties
from openpyxl.worksheet.pagebreak import RowBreak, ColBreak

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '【YC】学内施設使用許可願生成マシーン (2).xlsx'
OUTPUT = ROOT / 'public/templates/application.xlsx'


def main():
    wb = load_workbook(SOURCE, data_only=False, keep_links=False)
    ws = wb['表面']
    for sheet in list(wb.worksheets):
        if sheet != ws:
            wb.remove(sheet)
    wb.active = 0
    wb.defined_names.clear()
    wb._external_links = []
    wb.properties = DocumentProperties(creator='Classroom application', title='学内施設使用許可願',
                                      description='Sanitized official blank form', lastModifiedBy='Classroom application')
    # Remove all dynamic content, including blank-entry hints that would collide
    # with later overlays. Preserve original cell styles, merges and all borders.
    cleared = []
    for row in ws:
        for cell in row:
            if cell.data_type == 'f' or (isinstance(cell.value, str) and cell.value.startswith('=')):
                cleared.append(cell.coordinate)
                cell.value = None
            if cell.comment:
                cell.comment = None
            if cell.hyperlink:
                cell.hyperlink = None
    for row in range(42, 51):
        for col in ('A', 'H', 'P', 'U', 'X', 'AC'):
            ws[f'{col}{row}'].value = None
    # These dashes belonged to the former phone value, not form labels.
    for address in ('Z22', 'AD22'):
        ws[address].value = None
    ws._images = []
    ws._charts = []
    ws.data_validations.dataValidation = []
    ws.conditional_formatting._cf_rules.clear()
    ws.print_area = 'A1:AF54'
    ws.page_setup.orientation = 'portrait'
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.sheet_properties.pageSetUpPr.autoPageBreaks = False
    ws.print_options.horizontalCentered = True
    ws.print_options.verticalCentered = False
    ws.sheet_view.showGridLines = False
    ws.row_breaks = RowBreak()
    ws.col_breaks = ColBreak()
    for part in (ws.oddHeader, ws.oddFooter, ws.evenHeader, ws.evenFooter, ws.firstHeader, ws.firstFooter):
        for section in (part.left, part.center, part.right):
            section.text = None
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    wb.save(OUTPUT)
    check = load_workbook(OUTPUT, data_only=False)
    assert check.sheetnames == ['表面']
    assert not any(c.data_type == 'f' for row in check.active for c in row)
    original = load_workbook(SOURCE, data_only=False)['表面']
    assert {str(r) for r in original.merged_cells.ranges} == {str(r) for r in check.active.merged_cells.ranges}
    for row in original.iter_rows(min_row=1, max_row=54, max_col=32):
        for cell in row:
            target = check.active[cell.coordinate]
            assert copy(cell.border) == copy(target.border), cell.coordinate
    print(json.dumps({'output': str(OUTPUT), 'sheets': check.sheetnames, 'clearedFormulaCells': cleared,
                      'columnGroups': [{'min': c.min, 'max': c.max, 'width': c.width} for c in ws.column_dimensions.values()],
                      'heightPoints': sum(ws.row_dimensions[i].height or ws.sheet_format.defaultRowHeight for i in range(1,55))}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
