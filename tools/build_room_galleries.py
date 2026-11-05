"""Upgrade the legacy primary-photo catalog to all verified ROOMLIST photographs.

Reads existing byte-preserved PDF objects; PyMuPDF is used ONLY for placement
transforms / raw-object verification, never to render a page. Public WebP may be
losslessly rotated to match the PDF page; archived original bytes never change.
"""
from pathlib import Path
import hashlib, json, re, sys
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tools/python-deps'))
import pymupdf
from PIL import Image, ImageOps

def load(path): return json.loads((ROOT/path).read_text(encoding='utf-8'))
def dump(path,obj): (ROOT/path).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sha(data): return hashlib.sha256(data).hexdigest()

LABELS={4:'FEISホール',5:'31A',6:'31B',7:'31C',8:'31D',9:'31E',10:'31F',11:'32A',12:'32B',13:'32C',14:'32D',15:'32E',16:'32F',17:'32G',18:'32H',19:'32I',20:'32J',21:'32K',22:'33A',23:'33B',24:'33C',25:'33D',26:'33E',27:'33F',28:'33G',29:'33H',30:'33I',31:'33J',32:'33K',33:'YCホール',34:'学生ホール',35:'21A',36:'22B',37:'22D',38:'22E',39:'22H',40:'22G'}
HALLS={'FEISホール':'feis-hall','YCホール':'yc-hall','学生ホール':'student-hall'}
PDF_ONLY={31:('33J','3','3','J',3),35:('21A','2','1','A',2),39:('22H','2','2','H',2)}
# Explicitly inspected exclusions. Floor/seat diagrams elsewhere are PDF vectors,
# not photographic embedded image objects. p34 includes a real photo at LEFT below
# its floor diagram and must not be excluded by an x-position heuristic.
EXCLUDED={(3,5):'フロア図内の小さな記号',(3,6):'フロア図内の小さな記号',(34,8):'フロア図内のトイレ等記号',(34,9):'フロア図内のトイレ等記号',(34,10):'フロア図内の小さな記号',(34,11):'フロア図内の小さな記号'}
VERIFICATION='office-render指定CLIで全37教室ページの見出し・室内/机/AV設備の写真を目視照合。フロア図・記号は除外。元のPDF埋込画像を無加工保存。'

rooms=load('public/data/rooms.json')
custom=load('public/data/custom-rooms.json')
assert custom['schemaVersion']==1
custom_rooms=custom['rooms']
custom_ids={room['id'] for room in custom_rooms}
assert custom_ids=={'72A','72BC'} and len(custom_rooms)==2
# Replace only previously merged user entries, never a workbook/PDF room.
for room in rooms:
    if room['id'] in custom_ids:
        assert room['source'].get('type')=='user-provided'
rooms=[room for room in rooms if room['id'] not in custom_ids]
ledger=load('public/data/photo-sources.json')
admin=load('public/data/admin-photos.json')
assert admin['schemaVersion']==1
admin_photos=admin['photos']
# Reapply the admin manifest once, including when only galleries are regenerated.
previous_admin_ids={p['id'] for p in ledger['photos'] if p.get('sourceType')=='admin'}
for room in rooms:
    for kind,image in room['images'].items():
        if image and (image.get('sourceId') in previous_admin_ids or image.get('source')=='管理者追加'):
            room['images'][kind]=None
            room['photoStatus'][kind]='missing'
report=load('inspection/pdf-report.json')
mapping=load('inspection/room-pdf-mapping.json')
# Keep legacy primary-photo records in their original order / with the same IDs.
primary_ids={f"{r['id']}-{kind}" for r in rooms for kind in ['interior','exterior']}
records=[record for record in ledger['photos'] if record['id'] in primary_ids]
by_record={record['id']:record for record in records}
by_room={r['id']:r for r in rooms}
source_file_hashes={s['file']:s['sha256'] for s in ledger['sourceFiles']}
assert sha((ROOT/'roomlist.pdf').read_bytes())==source_file_hashes['roomlist.pdf']
pdf=pymupdf.open(ROOT/'roomlist.pdf')
assert len(pdf)==report['pageCount']==40
summary_text=report['pages'][0]['text']
summary_capacity={m.group(1):int(m.group(2)) for m in re.finditer(r'(\d{2}[A-K]教室|FEISホール)\s+(\d+)\s',summary_text)}
classified=[]
photo_by_room={}
placement_by_key={}
for page_info in report['pages']:
    pn=page_info['page']
    extracted=pdf[pn-1].get_image_info(xrefs=True)
    if pn in LABELS:
        label=LABELS[pn] if 'ホール' in LABELS[pn] else LABELS[pn]+'教室'
        assert label in re.sub(r'\s+','',page_info['text']),(pn,label)
        rid=HALLS.get(LABELS[pn],LABELS[pn])
    else: rid=None
    photos=[]
    for image in page_info['images']:
        key=(pn,image['index'])
        info=extracted[image['index']-1]
        assert info['xref']==image['xref']
        raw=(ROOT/image['original']).read_bytes()
        assert sha(raw)==image['sha256']
        assert sha(pdf.extract_image(image['xref'])['image'])==image['sha256']
        matrix=list(info['transform'])
        placement_by_key[key]=matrix
        if key in EXCLUDED:
            classified.append({'page':pn,'index':image['index'],'xref':image['xref'],'original':image['original'],'originalSha256':image['sha256'],'classification':'excluded-symbol','reason':EXCLUDED[key]})
            continue
        assert rid is not None,('Unclassified image outside classroom page',key)
        assert image['width']>=200 and image['height']>=150,('Unexpected small photograph',key)
        photos.append(image)
        classified.append({'page':pn,'index':image['index'],'xref':image['xref'],'roomId':rid,'original':image['original'],'originalSha256':image['sha256'],'classification':'interior-photograph','verification':VERIFICATION,'pdfTransform':matrix})
    if rid:
        # Order by page reading rows; index is source identity, not display order.
        photos.sort(key=lambda image:(round(image['bbox'][1]/25),image['bbox'][0]))
        photo_by_room[rid]=(pn,photos)
assert len([x for x in classified if x['classification']=='interior-photograph'])==148
assert len(classified)==154

for pn,(rid,building,floor,code,floor_page) in PDF_ONLY.items():
    name=rid+'教室'; page=report['pages'][pn-1]
    # Location is explicitly present in the PDF floor-plan text, not guessed from
    # digits. Normalize full-width names and floor headings for the assertions.
    import unicodedata
    floor_text=unicodedata.normalize('NFKC',report['pages'][floor_page-1]['text'])
    assert f'{building}号館' in floor_text and f'{building}号館{floor}階' in floor_text.replace(' ','')
    assert rid in floor_text.replace(' ','')
    detailed_match=re.search(r'(?<!\d)(\d+)\s+(?:固定|移動)',page['text'])
    detailed=int(detailed_match.group(1)) if detailed_match else None
    capacity=summary_capacity.get(name,detailed)
    evidence={'source':'roomlist.pdf','page':1 if name in summary_capacity else pn,'table':'教室設備機器一覧' if name in summary_capacity else '個別教室の定員表','asOf':'2025-09' if name in summary_capacity else None,'capacity':capacity,'individualPage':pn,'individualPageCapacity':detailed,'status':'confirmed','policy':'日付付き一覧表を優先。33Jは一覧に記載がないため個別ページの定員12人を採用。'}
    if rid not in by_room:
        room={'id':rid,'name':name,'displayName':f'{name}({building}号館{floor}階)','building':building,'floor':floor,'code':code,'description':'','comment':'','capacity':capacity,'equipment':None,'images':{'interior':None,'exterior':None},'photoStatus':{'interior':'missing','exterior':'missing'},'source':{'xlsx':None,'pdfPages':sorted({floor_page,pn,*([1] if name in summary_capacity else [])}),'pdfLabel':name,'metadataEvidence':evidence,'locationEvidence':{'source':'roomlist.pdf','page':floor_page,'floor':f'{building}号館{floor}階'},'addedFromPdf':True}}
        rooms.append(room); by_room[rid]=room
    else:
        by_room[rid]['capacity']=capacity; by_room[rid]['source']['metadataEvidence']=evidence
    if rid not in mapping['rooms']:
        pn,photos=photo_by_room[rid]
        # Favor the full room photo, not the equipment close-up, for new rooms.
        first=photos[0]
        mapping['rooms'][rid]={'page':pn,'label':name,'photo':{'index':first['index'],'verification':VERIFICATION},'capacity':capacity,'equipment':None,'metadataEvidence':evidence,'addedFromPdf':True}
    for kind in ['interior','exterior']:
        key=f'{rid}-{kind}'
        if key not in by_record:
            record={'id':key,'roomId':rid,'roomName':name,'kind':kind,'status':'missing','reason':'当該外観写真の掲載なし。' if kind=='exterior' else '未選択'}
            records.append(record); by_record[key]=record

# Merge the persistent user manifest after source-backed rooms. ROOMLIST has no
# 7号館 pages; these rooms must never acquire fabricated XLSX/PDF provenance.
assert len(rooms)==40 and len(by_room)==40
for room in custom_rooms:
    rid=room['id']
    assert rid not in by_room
    assert room['source']['type']=='user-provided'
    assert room['source']['addedFromUser'] is True
    assert room['source']['xlsx'] is None and room['source']['pdfPages']==[]
    assert room['source']['pdfLabel'] is None
    assert room['capacity'] is None and room['equipment'] is None
    assert room['images']=={'interior':None,'exterior':None}
    assert room['photoStatus']=={'interior':'missing','exterior':'missing'}
    assert room['gallery']==[]
    rooms.append(room); by_room[rid]=room
    for kind in ['interior','exterior']:
        key=f'{rid}-{kind}'
        record={'id':key,'roomId':rid,'roomName':room['name'],'kind':kind,'status':'missing','sourceType':'user-provided','source':'user-provided','reason':'ユーザー指定で追加。写真資料は未提供。ROOMLISTに7号館の掲載なし。'}
        records.append(record); by_record[key]=record

rotated=0

def convert(original,destination,matrix):
    global rotated
    with Image.open(ROOT/original) as im:
        im=ImageOps.exif_transpose(im).convert('RGB')
        a,b,c,d,e,f=matrix
        # All verified photo placements are orthogonal (0 or quarter turns).
        # Keep any unsupported skew/mirror explicit rather than guessing.
        assert a*d-b*c>0,('Mirrored photo placement needs manual inspection',original,matrix)
        if abs(a)<.01 and abs(d)<.01:
            im=im.transpose(Image.Transpose.ROTATE_270 if b>0 else Image.Transpose.ROTATE_90)
            rotated+=1
        elif a<0 and d<0:
            im=im.transpose(Image.Transpose.ROTATE_180); rotated+=1
        else:
            assert a>0 and d>0 and abs(b)<.01 and abs(c)<.01,(original,matrix)
        im.thumbnail((1440,1080),Image.Resampling.LANCZOS)
        im.save(destination,'WEBP',quality=80,method=6)
        width,height=im.size
    data=destination.read_bytes()
    return {'src':destination.relative_to(ROOT/'public').as_posix(),'sha256':sha(data),'bytes':len(data),'width':width,'height':height}

for room in rooms:
    rid=room['id']; gallery=[]
    # Put byte-preserved old workbook photos first; keep all old primary paths.
    for kind in ['interior','exterior']:
        primary=by_record.get(f'{rid}-{kind}')
        if primary and primary.get('status')=='available':
            g=primary['webp']
            gallery.append({'src':g['src'],'kind':kind,'source':primary['source'],'page':primary.get('page'),'sourceId':primary['id'],'width':g['width'],'height':g['height']})
    page_and_photos=photo_by_room.get(rid)
    if page_and_photos:
        pn,photos=page_and_photos
        selected=mapping['rooms'][rid]['photo']['index']
        primary=by_record[f'{rid}-interior']
        for image in photos:
            if primary.get('sourceType')=='pdf' and primary.get('pdfImageIndex')==image['index'] and primary.get('page')==pn:
                record=primary
            elif primary.get('status')!='available' and image['index']==selected:
                record=primary
            else:
                key=f'{rid}-pdf-p{pn:02d}-i{image["index"]:02d}'
                record={'id':key,'roomId':rid,'roomName':room['name'],'kind':'interior','status':'available'}
                records.append(record); by_record[key]=record
            record.update({'status':'available','sourceType':'pdf','source':'roomlist.pdf','page':pn,'pdfRoomLabel':mapping['rooms'][rid]['label'],'pdfImageIndex':image['index'],'pdfXref':image['xref'],'pdfBoundingBox':image['bbox'],'pdfTransform':placement_by_key[(pn,image['index'])],'original':image['original'],'originalSha256':image['sha256'],'preservedExisting':False,'verification':VERIFICATION,'classification':'interior-photograph'})
            if record['id']==f'{rid}-interior' and record.get('webp'):
                # Old selected photos are unrotated room-wide views. Reuse the
                # original public path and bytes for backward compatibility.
                generated=record['webp']
                assert sha((ROOT/'public'/generated['src']).read_bytes())==generated['sha256']
            else:
                name=f'{rid.lower()}-interior.webp' if record['id']==f'{rid}-interior' else f'{rid.lower()}-pdf-p{pn:02d}-i{image["index"]:02d}.webp'
                destination=ROOT/'public/images/rooms'/name
                generated=convert(image['original'],destination,record['pdfTransform'])
                record['webp']=generated
            if not any(item['sourceId']==record['id'] for item in gallery):
                gallery.append({'src':generated['src'],'kind':'interior','source':'roomlist.pdf','page':pn,'sourceId':record['id'],'width':generated['width'],'height':generated['height']})
        primary=by_record[f'{rid}-interior']
        room['images']['interior']={'src':primary['webp']['src'],'source':primary['source'],'page':primary.get('page'),'sourceId':primary['id']}
        room['photoStatus']['interior']='available'
        mapping['rooms'][rid]['photos']=[{'index':image['index'],'verification':VERIFICATION} for image in photos]
    room['gallery']=gallery

assert len(rooms)==42 and len({r['id'] for r in rooms})==42
assert len([r for r in records if r['id'] in {f'{room["id"]}-{kind}' for room in rooms for kind in ['interior','exterior']}])==84
assert len({p['id'] for p in admin_photos})==len(admin_photos)
for photo in admin_photos:
    assert re.fullmatch(r'admin-[A-Za-z0-9-]+',photo['id'])
    assert photo['id'] not in by_record and photo['roomId'] in by_room
    assert photo['kind'] in ['interior','exterior'] and photo['source']=='管理者追加'
    assert photo['src']==f'images/rooms/{photo["id"]}.webp'
    destination=ROOT/'public'/photo['src']
    raw=destination.read_bytes()
    assert sha(raw)==photo['sha256'] and len(raw)==photo['bytes']
    with Image.open(destination) as im:
        assert im.format=='WEBP'
        im.load()
        assert im.size==(photo['width'],photo['height'])
    generated={key:photo[key] for key in ['src','sha256','bytes','width','height']}
    room=by_room[photo['roomId']]
    record={'id':photo['id'],'roomId':photo['roomId'],'roomName':room['name'],'kind':photo['kind'],'status':'available','sourceType':'admin','source':'管理者追加','webp':generated,'addedAt':photo['addedAt'],'preservedExisting':False}
    records.append(record); by_record[record['id']]=record
    room['gallery'].append({'src':photo['src'],'kind':photo['kind'],'source':'管理者追加','page':None,'sourceId':photo['id'],'width':photo['width'],'height':photo['height']})
    # Keep source-backed primary images; use the first admin photo only for a gap.
    if room['images'][photo['kind']] is None:
        room['images'][photo['kind']]={'src':photo['src'],'source':'管理者追加','page':None,'sourceId':photo['id']}
        room['photoStatus'][photo['kind']]='available'
available=[r for r in records if r['status']=='available']
assert len(available)==164+len(admin_photos)
assert len([r for r in available if r.get('sourceType')=='pdf'])==148
assert len([r for r in available if r.get('preservedExisting')])==16
assert len({record['id'] for record in records})==len(records)
assert sum(len(room['gallery']) for room in rooms)==164+len(admin_photos)
# Upgrade the historical list: these records are retained, but no longer describe
# omitted rooms. This avoids a silent contradiction in the audit ledger.
for entry in mapping['pdfOnly']:
    entry.update({'status':'included','reason':'全写真追加の要求に従い、見出しとフロア図で所在地を確認して新規登録。'})
ledger.update({'schemaVersion':2,'policy':'XLSX既存16写真を保持。ROOMLIST全40ページのうち37教室ページの写真148点を全収録し、フロア図・配線図・記号はgalleryに含めない。元画像バイトを保存し、配布WebPのみPDF配置の向きへ補正。','photos':records,'pdfOnlyRooms':mapping['pdfOnly'],'excludedPdfImages':[x for x in classified if x['classification']=='excluded-symbol']})
ledger['sources']['custom']='public/data/custom-rooms.json'
ledger['sources']['admin']='public/data/admin-photos.json'
ledger['policy']+=' 管理者追加写真は独立マニフェストから復元し、原資料の写真とは区別。'
ledger['policy']+=' ユーザー指定の72A・72BCは独立した追加マニフェストから登録し、写真・定員は未提供のまま。'
ledger['summary'].update({'roomCount':42,'primaryPhotoSlots':84,'originalWorkbookRoomCount':37,'addedPdfRooms':['33J','21A','22H'],'addedUserRooms':[room['id'] for room in custom_rooms],'existingPhotosPreserved':16,'interiorAvailable':sum(room['images']['interior'] is not None for room in rooms),'interiorMissing':[r['id'] for r in rooms if not r['images']['interior']],'exteriorAvailable':sum(room['images']['exterior'] is not None for room in rooms),'pdfInteriorAdded':148,'legacyPdfInteriorAdded':31,'pdfPhotographs':148,'adminPhotographs':len(admin_photos),'galleryPhotoCount':len(available),'webpCount':len(available),'webpBytes':sum(record['webp']['bytes'] for record in available),'excludedPdfSymbols':6,'pdfRotationAppliedCount':rotated})
dump('public/data/rooms.json',rooms)
dump('public/data/photo-sources.json',ledger)
dump('inspection/room-pdf-mapping.json',mapping)
dump('inspection/room-gallery-classification.json',{'source':'roomlist.pdf','pageCount':40,'classroomPages':37,'photographCount':148,'excludedSymbolCount':6,'items':classified})
dump('inspection/extraction-summary.json',ledger['summary'])
print(json.dumps(ledger['summary'],ensure_ascii=False,indent=2))
