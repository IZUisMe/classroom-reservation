from pathlib import Path
import json,sys
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parent.parent
report=json.loads((root/'inspection/pdf-report.json').read_text(encoding='utf-8'))
lines=[]
for p in report['pages']:
    lines.append(f"PAGE {p['page']} {p['width']:.0f}x{p['height']:.0f}")
    lines.extend(f"  image {i['index']} {i['width']}x{i['height']} bbox={[round(x) for x in i['bbox']]}" for i in p['images'])
(root/'inspection/gallery-candidates.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('candidate report written')
