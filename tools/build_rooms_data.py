"""Build auditable classroom JSON and lightweight WebP assets from inspected sources."""
from pathlib import Path
import json, hashlib, io, sys, re
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image, ImageOps
ROOT=Path(__file__).resolve().parent.parent
XLSX=json.loads((ROOT/'inspection/xlsx-rooms.json').read_text(encoding='utf-8'))
PDF_PATH=ROOT/'inspection/pdf-report.json'
PDF=json.loads(PDF_PATH.read_text(encoding='utf-8')) if PDF_PATH.exists() else {'pages':[]}
MAP_PATH=ROOT/'inspection/room-pdf-mapping.json'
MAPPING=json.loads(MAP_PATH.read_text(encoding='utf-8')) if MAP_PATH.exists() else {'rooms':{},'pdfOnly':[]}

def dump(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def sha(data): return hashlib.sha256(data).hexdigest()

def webp(original,room_id,kind):
    source=ROOT/original
    dest=ROOT/'public/images/rooms'/f'{room_id.lower()}-{kind}.webp'
    dest.parent.mkdir(parents=True,exist_ok=True)
    with Image.open(source) as im:
        im=ImageOps.exif_transpose(im).convert('RGB')
        im.thumbnail((1440,1080),Image.Resampling.LANCZOS)
        im.save(dest,'WEBP',quality=80,method=6)
        width,height=im.size
    data=dest.read_bytes()
    return {'src':dest.relative_to(ROOT/'public').as_posix(),'sha256':sha(data),'bytes':len(data),'width':width,'height':height}

rooms=[]; sources=[]; unused_rows=[]
for row in XLSX['rows']:
    r=row['row']; v=row['values']; cache=row['cached']
    if not v:
        unused_rows.append(r); continue
    name=cache.get('D')
    if not name: raise ValueError(f'Missing source name row {r}')
    halls={'学生ホール':'student-hall','FEISホール':'feis-hall','YCホール':'yc-hall'}
    room_id=halls.get(name,name.removesuffix('教室'))
    numeric=isinstance(v.get('A'),(int,float))
    building=str(int(v['A'])) if numeric else None
    floor=str(int(v['B'])) if isinstance(v.get('B'),(int,float)) else None
    code=v.get('C')
    if not numeric:
        location=re.search(r'\((\d+)号館(地下)?(\d+)階\)',cache.get('E',''))
        if location:
            building=location.group(1)
            floor=('-' if location.group(2) else '')+location.group(3)
    mapping=MAPPING['rooms'].get(room_id,{})
    images={}; statuses={}
    for kind,col in [('interior','F'),('exterior','G')]:
        existing=[im for im in XLSX['images'] if im['row']==r and im['column']==col]
        assert len(existing)<=1
        record={'id':f'{room_id}-{kind}','roomId':room_id,'roomName':name,'kind':kind,'status':'missing'}
        if existing:
            im=existing[0]
            record.update({'status':'available','sourceType':'xlsx','source':XLSX['file'],'sheet':XLSX['sheet'],'cell':f'{col}{r}','anchor':{'row':r,'column':col},'mediaPath':im.get('mediaPath'),'original':im['original'],'originalSha256':im['sha256'],'preservedExisting':True})
        elif kind=='interior' and mapping.get('photo'):
            photo=mapping['photo']; page=next(p for p in PDF['pages'] if p['page']==mapping['page'])
            im=next(i for i in page['images'] if i['index']==photo['index'])
            record.update({'status':'available','sourceType':'pdf','source':'roomlist.pdf','page':mapping['page'],'pdfRoomLabel':mapping['label'],'pdfImageIndex':im['index'],'pdfXref':im['xref'],'pdfBoundingBox':im['bbox'],'original':im['original'],'originalSha256':im['sha256'],'preservedExisting':False,'verification':photo['verification']})
        else:
            record['reason']='PDFに当該教室の室内写真なし。既存xlsxにも当該写真なし。' if kind=='interior' else 'xlsxに当該外観写真なし。PDFから外観の推測補完はしない。'
        if record['status']=='available':
            generated=webp(record['original'],room_id,kind)
            record['webp']=generated
            images[kind]={'src':generated['src'],'source':record['source'],'page':record.get('page'),'sourceId':record['id']}
        else:
            images[kind]=None
        statuses[kind]=record['status']; sources.append(record)
    display=cache.get('E') or name
    rooms.append({'id':room_id,'name':name,'displayName':display,'building':building,'floor':floor,'code':code,'description':'','comment':v.get('H',''),'capacity':mapping.get('capacity'),'equipment':mapping.get('equipment'),'images':images,'photoStatus':statuses,'source':{'xlsx':{'file':XLSX['file'],'sheet':XLSX['sheet'],'row':r,'columns':{'name':'D','displayName':'E','comment':'H'}},'pdfPages':([1,mapping['page']] if mapping.get('metadataEvidence') else [mapping['page']]) if mapping else [],'pdfLabel':mapping.get('label'),'metadataEvidence':mapping.get('metadataEvidence')}})

assert len(rooms)==37
assert len({r['id'] for r in rooms})==37
assert sum(s.get('preservedExisting',False) for s in sources)==16
summary={'workbookRowSlots':len(XLSX['rows']),'roomCount':len(rooms),'blankWorkbookRows':unused_rows,'existingPhotosPreserved':16,'interiorAvailable':sum(r['images']['interior'] is not None for r in rooms),'interiorMissing':[r['id'] for r in rooms if r['images']['interior'] is None],'exteriorAvailable':sum(r['images']['exterior'] is not None for r in rooms),'pdfInteriorAdded':sum(s.get('sourceType')=='pdf' for s in sources),'webpBytes':sum(s.get('webp',{}).get('bytes',0) for s in sources)}
dump(ROOT/'public/data/rooms.json',rooms)
dump(ROOT/'public/data/photo-sources.json',{'schemaVersion':1,'sources':{'xlsx':XLSX['file'],'pdf':'roomlist.pdf'},'policy':'XLSXの既存写真を優先保存。PDF写真は対応教室が確認できる場合のみ室内写真の欠落を補完。未確認はmissing。PDFページは1始まりの物理ページ番号。','summary':summary,'photos':sources,'pdfOnlyRooms':MAPPING['pdfOnly'],'blankWorkbookRows':unused_rows,'metadataConflicts':MAPPING.get('metadataConflicts',[]),'sourceFiles':[{'file':name,'sha256':sha((ROOT/name).read_bytes())} for name in [XLSX['file'],'roomlist.pdf']],'metadataAsOf':MAPPING.get('summaryAsOf')})
dump(ROOT/'inspection/extraction-summary.json',summary)
print(json.dumps(summary,ensure_ascii=False,indent=2))

# The legacy primary-photo stage above preserves all original workbook semantics.
# Finalize the current catalog with every verified ROOMLIST photo and PDF-only rooms.
import runpy
runpy.run_path(str(ROOT/'tools/build_room_galleries.py'),run_name='__main__')
