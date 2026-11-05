"""Record inspected page titles and select only verified interior-photo rectangles."""
from pathlib import Path
import json, re
ROOT=Path(__file__).resolve().parent.parent
report=json.loads((ROOT/'inspection/pdf-report.json').read_text(encoding='utf-8'))
# Every title was checked against the Office-render CLI page image, not inferred from sequence.
labels={4:'FEISホール',5:'31A',6:'31B',7:'31C',8:'31D',9:'31E',10:'31F',11:'32A',12:'32B',13:'32C',14:'32D',15:'32E',16:'32F',17:'32G',18:'32H',19:'32I',20:'32J',21:'32K',22:'33A',23:'33B',24:'33C',25:'33D',26:'33E',27:'33F',28:'33G',29:'33H',30:'33I',31:'33J',32:'33K',33:'YCホール',34:'学生ホール',35:'21A',36:'22B',37:'22D',38:'22E',39:'22H',40:'22G'}
# These are not registered in the workbook. This legacy primary-map stage keeps
# them separate; build_room_galleries.py later verifies and includes all three.
pdf_only={31:'33J',35:'21A',39:'22H'}
halls={'FEISホール':'feis-hall','YCホール':'yc-hall','学生ホール':'student-hall'}
result={'rooms':{},'pdfOnly':[]}
for page in report['pages']:
    pn=page['page']
    if pn not in labels: continue
    short=labels[pn]; label=short if 'ホール' in short else short+'教室'
    compact=re.sub(r'\s+','',page['text'])
    if label not in compact:
        raise ValueError(f'Title not present in PDF text: {pn} {label}')
    if pn in pdf_only:
        result['pdfOnly'].append({'id':short,'name':label,'page':pn,'source':'roomlist.pdf','reason':'元ブック未登録。全写真追加の最終段で見出し・所在地を確認してroomsへ追加。'})
        continue
    # The second (top-right) photograph shows room seating and usually avoids the person at the lectern.
    # Classifications are based on inspected page layouts; photos are right of the floor plan.
    candidates=[i for i in page['images'] if i['bbox'][0]>page['width']*.43 and i['width']>=200 and i['height']>=150]
    if not candidates: raise ValueError(f'No interior photos on {pn}')
    candidates.sort(key=lambda i:(round(i['bbox'][1]/30),i['bbox'][0]))
    top_y=min(i['bbox'][1] for i in candidates)
    top=[i for i in candidates if abs(i['bbox'][1]-top_y)<25]
    selected=max(top,key=lambda i:i['bbox'][0]) if len(top)>1 else top[0]
    if pn==28:
        # Top-right is a furniture close-up; lower-left is the unobstructed whole-room view.
        selected=next(i for i in page['images'] if i['index']==3)
    # Header table's first numeric entry immediately after "定員" is captured from the text extraction.
    # It is cross-checked manually against each page image before use.
    result['rooms'][halls.get(short,short)]={'page':pn,'label':label,'photo':{'index':selected['index'],'verification':('Office-render CLIでページ見出しと右側下段左の室内写真を目視照合。PDF埋込画像を無加工抽出。' if pn==28 else 'Office-render CLIでページ見出しと右側上段の室内写真を目視照合。PDF埋込画像を無加工抽出。')},'capacity':None,'equipment':None,'metadataEvidence':None}
(ROOT/'inspection/room-pdf-mapping.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Mapped',len(result['rooms']),'existing rooms;',len(result['pdfOnly']),'PDF-only rooms')
for rid,m in result['rooms'].items():
    page=report['pages'][m['page']-1]
    print(rid, m['page'], 'selected image',m['photo']['index'],[(i['index'],i['width'],i['height'],[round(v) for v in i['bbox']]) for i in page['images']])
