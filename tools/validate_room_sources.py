"""Validate all ROOMLIST photographs, exact originals, legacy primaries and galleries."""
from pathlib import Path
import json, hashlib, re, zipfile, sys
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image
from openpyxl import load_workbook
ROOT=Path(__file__).resolve().parent.parent
read=lambda p:json.loads((ROOT/p).read_text(encoding='utf-8'))
rooms=read('public/data/rooms.json'); data=read('public/data/photo-sources.json'); pdf=read('inspection/pdf-report.json'); mapping=read('inspection/room-pdf-mapping.json')
classification=read('inspection/room-gallery-classification.json')
admin=read('public/data/admin-photos.json')
assert admin['schemaVersion']==1
admin_lookup={p['id']:p for p in admin['photos']}
assert len(admin_lookup)==len(admin['photos'])
expected_photo_count=164+len(admin_lookup)
missing_interiors=[rid for rid in ['22A','22F','72D','72A','72BC'] if not any(p['roomId']==rid and p['kind']=='interior' for p in admin['photos'])]
lookup={p['id']:p for p in data['photos']}
assert len(lookup)==len(data['photos'])
wb=load_workbook(ROOT/data['sources']['xlsx'],data_only=False); ws=wb['教室データベース']
assert len(rooms)==42 and len({r['id'] for r in rooms})==42
workbook_rooms=[r for r in rooms if r['source'].get('xlsx')]
new_rooms=[r for r in rooms if r['source'].get('addedFromPdf')]
user_rooms=[r for r in rooms if r['source'].get('type')=='user-provided']
custom=read('public/data/custom-rooms.json')
assert custom['schemaVersion']==1
assert [r['id'] for r in custom['rooms']]==[r['id'] for r in user_rooms]
for template,room in zip(custom['rooms'],user_rooms):
    for key in template:
        if key not in ['images','photoStatus','gallery']: assert template[key]==room[key]
    assert template['images']=={'interior':None,'exterior':None}
    assert template['photoStatus']=={'interior':'missing','exterior':'missing'}
    assert template['gallery']==[]
assert {r['id'] for r in user_rooms}=={'72A','72BC'}
assert len(workbook_rooms)+len(new_rooms)+len(user_rooms)==len(rooms)
for room in user_rooms:
    assert room['name']==room['id']+'教室'
    assert room['displayName']==room['name']+'(7号館2階)'
    assert (room['building'],room['floor'],room['code'])==('7','2',room['id'][2:])
    assert room['source']['xlsx'] is None
    assert room['source']['pdfPages']==[] and room['source']['pdfLabel'] is None
    assert room['source']['addedFromUser'] is True
    assert room['source']['locationEvidence']=={'source':'user-provided','building':'7','floor':'2'}
    assert room['capacity'] is None and room['equipment'] is None
    if not any(p['roomId']==room['id'] for p in admin['photos']):
        assert room['images']=={'interior':None,'exterior':None}
        assert room['photoStatus']=={'interior':'missing','exterior':'missing'}
        assert room['gallery']==[]
    for kind in ['interior','exterior']:
        slot=lookup[f'{room["id"]}-{kind}']
        assert slot['sourceType']==slot['source']=='user-provided'
        assert slot['status']=='missing' and 'webp' not in slot
assert len(workbook_rooms)==37
assert {r['source']['xlsx']['row'] for r in workbook_rooms}==set(range(2,40))-{38}
assert {r['id'] for r in new_rooms}=={'21A','22H','33J'}
assert all(c.value is None for c in ws[38])
for room in workbook_rooms:
    row=room['source']['xlsx']['row']
    assert room['comment']==(ws.cell(row,8).value or '')
for room in new_rooms:
    assert room['source']['addedFromPdf'] is True
    assert room['source']['locationEvidence']['page'] in [2,3]
    assert room['capacity']==({'21A':100,'22H':100,'33J':12}[room['id']])

available=[source for source in data['photos'] if source['status']=='available']
assert len(available)==expected_photo_count
assert {s['id'] for s in available if s.get('sourceType')=='admin'}==set(admin_lookup)
assert len([s for s in available if s.get('sourceType')=='pdf'])==148
assert len([s for s in available if s.get('preservedExisting')])==16
verified=0; legacy=0; workbook_verified=0
with zipfile.ZipFile(ROOT/data['sources']['xlsx']) as z:
    for source in available:
        target=ROOT/'public'/source['webp']['src']; raw=target.read_bytes()
        assert hashlib.sha256(raw).hexdigest()==source['webp']['sha256']
        assert len(raw)==source['webp']['bytes']
        with Image.open(target) as im:
            assert im.format=='WEBP'; im.load()
            assert im.size==(source['webp']['width'],source['webp']['height'])
        if source['sourceType']=='admin':
            entry=admin_lookup[source['id']]
            assert re.fullmatch(r'admin-[A-Za-z0-9-]+',entry['id'])
            assert entry['src']==f'images/rooms/{entry["id"]}.webp'
            assert entry['source']==source['source']=='管理者追加'
            assert entry['roomId']==source['roomId'] and entry['kind']==source['kind']
            assert entry['kind'] in ['interior','exterior']
            assert entry['addedAt']==source['addedAt']
            for key in ['src','sha256','bytes','width','height']: assert entry[key]==source['webp'][key]
            verified+=1
            continue
        original=(ROOT/source['original']).read_bytes()
        assert hashlib.sha256(original).hexdigest()==source['originalSha256']
        if source['sourceType']=='xlsx':
            assert original==z.read(source['mediaPath'])
            room=next(r for r in rooms if r['id']==source['roomId'])
            assert source['anchor']['row']==room['source']['xlsx']['row']
            assert source['anchor']['column']==('F' if source['kind']=='interior' else 'G')
            workbook_verified+=1
        else:
            page=pdf['pages'][source['page']-1]
            assert source['roomName'] in re.sub(r'\s+','',page['text'])
            source_img=next(i for i in page['images'] if i['xref']==source['pdfXref'] and i['index']==source['pdfImageIndex'])
            assert source_img['sha256']==source['originalSha256']
            assert source['classification']=='interior-photograph'
            a,b,c,d,_,_=source['pdfTransform']
            expected=(source_img['height'],source_img['width']) if abs(a)<.01 and abs(d)<.01 else (source_img['width'],source_img['height'])
            # PDF pictures are small originals; no upscaling or clipping occurs.
            assert (source['webp']['width'],source['webp']['height'])==expected
        verified+=1

referenced=[]
for room in rooms:
    for kind in ['interior','exterior']:
        img=room['images'][kind]; source=lookup[f'{room["id"]}-{kind}']
        assert source['roomId']==room['id']
        if img is None:
            assert source['status']=='missing' and room['photoStatus'][kind]=='missing'
        else:
            original=source
            source=lookup[img['sourceId']]
            assert source['roomId']==room['id'] and source['kind']==kind
            assert source['status']=='available' and room['photoStatus'][kind]=='available'
            if original['status']=='available':
                assert source['id']==original['id']
            else:
                first=next(p for p in admin['photos'] if p['roomId']==room['id'] and p['kind']==kind)
                assert source['sourceType']=='admin' and source['id']==first['id']
            assert img['src']==source['webp']['src']
            assert img['source']==source['source'] and img.get('page')==source.get('page')
            assert source['id'] in [g['sourceId'] for g in room['gallery']]
            if room['source'].get('xlsx') and source['sourceType']!='admin': legacy+=1
    assert len({g['sourceId'] for g in room['gallery']})==len(room['gallery'])
    for image in room['gallery']:
        source=lookup[image['sourceId']]
        assert source['roomId']==room['id']
        assert image['kind'] in ['interior','exterior']
        for key in ['src','width','height']: assert image[key]==source['webp'][key]
        assert image['source']==source['source'] and image.get('page')==source.get('page')
        referenced.append(image['sourceId'])
assert verified==expected_photo_count and legacy==47 and workbook_verified==16
assert len(referenced)==expected_photo_count and set(referenced)=={s['id'] for s in available}
assert [r['id'] for r in rooms if not r['images']['interior']]==missing_interiors
assert {r['id'] for r in data['pdfOnlyRooms']}=={'21A','22H','33J'}
assert all(r['status']=='included' for r in data['pdfOnlyRooms'])
assert len(list((ROOT/'public/images/rooms').glob('*.webp')))==expected_photo_count
assert len({(s['anchor']['row'],s['anchor']['column']) for s in available if s.get('preservedExisting')})==16
included={(x['page'],x['index']) for x in classification['items'] if x['classification']=='interior-photograph'}
excluded={(x['page'],x['index']) for x in classification['items'] if x['classification']=='excluded-symbol'}
actual={(s['page'],s['pdfImageIndex']) for s in available if s['sourceType']=='pdf'}
all_embedded={(page['page'],i['index']) for page in pdf['pages'] for i in page['images']}
assert included==actual and len(included)==148 and len(excluded)==6
assert included.isdisjoint(excluded) and included|excluded==all_embedded
assert len(mapping['rooms'])==37
for rid,m in mapping['rooms'].items():
    assert len(m['photos'])==len([s for s in available if s['roomId']==rid and s['sourceType']=='pdf'])

summary=data['summary']
assert summary['roomCount']==42 and summary['primaryPhotoSlots']==84
assert summary['workbookRowSlots']==38 and summary['originalWorkbookRoomCount']==37
assert summary['blankWorkbookRows']==[38] and summary['addedUserRooms']==['72A','72BC']
assert summary['interiorAvailable']==42-len(missing_interiors)
assert summary['interiorMissing']==missing_interiors
assert summary['exteriorAvailable']==sum(r['images']['exterior'] is not None for r in rooms)
assert summary['adminPhotographs']==len(admin_lookup)
assert summary['galleryPhotoCount']==summary['webpCount']==expected_photo_count
assert len([p for p in data['photos'] if p['id'] in {f'{r["id"]}-{kind}' for r in rooms for kind in ['interior','exterior']}])==84
assert len(data['photos'])==198+len(admin_lookup)
for source in data['sourceFiles']:
    assert hashlib.sha256((ROOT/source['file']).read_bytes()).hexdigest()==source['sha256']
report={'roomCount':42,'primaryPhotoSlots':84,'originalWorkbookRoomCount':37,'addedPdfRooms':['33J','21A','22H'],'addedUserRooms':['72A','72BC'],'photoRecords':len(data['photos']),'galleryPhotos':expected_photo_count,'webpCount':expected_photo_count,'adminPhotographs':len(admin_lookup),'workbookOriginalsByteIdentical':16,'legacyPrimaryPhotosMaintained':47,'pdfPhotosAdded':148,'pdfPhotographOccurrencesCovered':148,'excludedPdfSymbols':6,'allEmbeddedOccurrencesClassified':154,'allCommentsPreserved':True,'pdfTitleMatches':37,'missingInteriors':missing_interiors,'webpBytes':sum(s['webp']['bytes'] for s in available),'metadataConflicts':mapping['metadataConflicts'],'passed':True}
(ROOT/'inspection/room-data-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

doc=['# 教室・全写真の出典整理','','## 概要','',
'- 原資料：[教室データベース](<../'+data['sources']['xlsx']+'>) と [ROOMLIST](<../roomlist.pdf>)（40物理ページ）。',
'- 元ブック37室を保持し、PDF掲載の **33J・21A・22H** とユーザー指定の **72A・72BC** を追加。アプリ登録は **42室**。空白のxlsx38行目から架空教室を作成していない。',
'- **72A・72BCはユーザー提供情報**（7号館2階）。ROOMLISTには7号館の掲載がなく、PDF・XLSX由来と表記しない。追加指定時点の定員・設備・写真は未提供。管理者が後日追加した写真は別出典として記録。',
'- XLSX既存写真 **16点すべて保持**（室内3・外観13）。元画像はブックZIP内メディアとバイト単位で同一。',
'- PDF全37教室ページに掲載された写真 **148点すべて** を収録。室内全景・机・AV機器ラック等の写真を含む。上段1枚だけの抽出ではない。',
f'- 合計 **{expected_photo_count} WebP**（既存16 + PDF148 + 管理者追加{len(admin_lookup)}）、'+f'{report["webpBytes"]:,} bytes（約{report["webpBytes"]/1024/1024:.2f} MiB）。',
f'- 室内写真あり{42-len(missing_interiors)}／42室。**'+('・'.join(missing_interiors)+'は写真なし' if missing_interiors else '写真なしの教室なし')+'**。他室の写真で代用しない。',
'- PDF埋込画像154出現を全分類し、写真148・記号6と照合。フロア図・配線図・トイレ等の記号をgalleryへ混入させていない。フロア図の大半はベクトルであり写真抽出の対象外。',
'- 学生ホールp34は図の左下にも写真があるため、右側だけを選ぶ位置閾値で除外しない。',
'- 原H列コメントは37室すべて原文維持。PDF新規3室に推測コメント・設備を追加しない。',
'', '## 後方互換スキーマ','',
'- [教室JSON](<../public/data/rooms.json>) は42件の配列。従来の `images.interior/exterior`・`photoStatus`・既存47代表画像のパス/IDを維持。',
'- [ユーザー追加マニフェスト](<../public/data/custom-rooms.json>) は `schemaVersion:1, rooms:[room]`。72A・72BCを永続保存し、全体生成・gallery再生成のどちらでも最終段でマージする。',
'- ユーザー追加室は `source.type:user-provided`・`addedFromUser:true`・`xlsx:null`・`pdfPages:[]`・`pdfLabel:null`。所在地根拠も `user-provided`。マニフェストの初期状態は `capacity/equipment` と両代表写真がnull、`gallery:[]`、両 `photoStatus` がmissing。',
'- [管理者写真マニフェスト](<../public/data/admin-photos.json>) は `schemaVersion:1, photos:[{id,roomId,src,kind,source,width,height,sha256,bytes,addedAt}]`。IDは `admin-UUID`、保存先は `images/rooms/admin-UUID.webp`、出典は `管理者追加`。再生成時にファイルのSHA-256・寸法を検証してマージし、元資料の写真と区別。写真がない代表枠のみ最初の追加写真で補い、既存代表写真は差し替えない。',
'- 各roomへ `gallery:[{src,kind,source,page,sourceId,width,height}]` を追加。kindはinterior/exterior。写真なしの教室は空配列。',
'- galleryは従来の代表写真を先に、その後PDFの残り写真をページの上から左→右順に追加。同じPDF画像を代表とgalleryで二重登録しない。',
'- [出典台帳](<../public/data/photo-sources.json>) schemaVersion2。各写真に原画像SHA-256、xref、物理ページ、配置座標/変換行列、WebPのSHA-256・寸法を記録。',
'- 歴史的な `pdfOnlyRooms` 配列は削除せず、3室すべて `status:included` に更新。',
f'- 台帳は42室×室内/外観の84原資料代表写真枠を記録（ユーザー追加室の未提供4枠もmissing）。gallery追加114記録と管理者追加{len(admin_lookup)}記録を合わせ{len(data["photos"])}写真記録、うち利用可能{expected_photo_count}点。`roomCount:42`・`primaryPhotoSlots:84`・`addedUserRooms:[72A,72BC]`。元ブックは37室・38行枠・空白38行目のまま。',
'- 管理者写真の台帳は `sourceType:admin`・`source:管理者追加`・`id:admin-UUID`。代表採用時も原資料のmissing記録をavailable複製せず、`images.kind.sourceId` を管理者写真IDへ向ける。集計の `adminPhotographs`・`galleryPhotoCount`・`webpCount` はマニフェスト件数を加算。',
'', '## 原本・向き・軽量化','',
'- [既存抽出原本](<../assets/source-photos/xlsx/>)（16点）と [PDF原画像](<../assets/source-photos/pdf/>)（154出現）を無加工のまま保管。元画像を削除・差替えしない。',
'- [配布WebP](<../public/images/rooms/>) はPillowで品質80、最大1440×1080、拡大なし。PDF内の小さい写真はその解像度を維持。',
'- PDFで90度回転配置されていた機器写真32点は、配布用WebPのみPDF変換行列に従って向きを補正。元のJPEG 2000/PNG等のバイトは不変。',
'', '## 新規教室と定員','',
'| 教室 | 写真ページ | 所在地の根拠 | 定員 |','|---|---:|---|---:|',
'| 33J教室 | p31 | p3「3号館3階」のフロア図 | 12（p31個別表） |',
'| 21A教室 | p35 | p2「2号館1階」のフロア図 | 100（p1一覧・p35） |',
'| 22H教室 | p39 | p2「2号館2階」のフロア図 | 100（p1一覧・p39） |',
'| 72A教室 | — | ユーザー提供：7号館2階 | null（未提供） |',
'| 72BC教室 | — | ユーザー提供：7号館2階 | null（未提供） |',
'',
'- 定員は日付付きp1「2025年9月現在」一覧を優先。33Jはp1にないためp31個別表の12を採用し、日付は不明としてnull。',
'- YCホール・学生ホールの定員欄「-」、22A・22F・72Dの該当記述なし、ユーザー追加72A・72BCの未提供定員はnull。設備は全件nullのまま。',
'- 一覧と個別ページの定員差異5件は両値を保存し、勝手に訂正しない。',
'', '| 教室 | p1一覧（採用） | 個別ページ |','|---|---:|---|']
for c in mapping['metadataConflicts']: doc.append(f'| {c["roomId"]} | {c["capacity"]} | {c["individualPageCapacity"]}（p{c["individualPage"]}） |')
doc+=['','## 全教室・写真数','','| 教室 | XLSX行 | PDF写真ページ | PDF全写真 | gallery計 |','|---|---:|---:|---:|---:|']
for room in rooms:
    rid=room['id']; m=mapping['rooms'].get(rid)
    row=room['source']['xlsx']['row'] if room['source'].get('xlsx') else '—'
    count=len([s for s in available if s['sourceType']=='pdf' and s['roomId']==rid])
    doc.append(f'| {room["name"]} | {row} | {m["page"] if m else "—"} | {count} | {len(room["gallery"])} |')
doc+=['','## 再現・検証','',
'Pythonはbundled Pythonとopenpyxl/Pillow、抽出専用のPyMuPDFを使用。既存の原資料監査ではoffice-renderスキル指定LibreOffice Kit CLI（native/pdfium、144dpi）で描画した37教室ページ全点を目視照合済み。今回のユーザー指定2室にPDFページ根拠を追加していない。PyMuPDFをページレンダリングには使わない。','',
'```text','python tools/extract_room_sources.py','python tools/map_room_pdf.py','python tools/enrich_room_metadata.py','python tools/build_rooms_data.py  # 最終段でbuild_room_galleries.pyも実行','python tools/validate_room_sources.py','```','',
'galleryだけ再生成する場合：`python tools/build_room_galleries.py`（冪等）。',
f'- {expected_photo_count} WebPのデコード・寸法・参照・SHA-256一致。原画像148写真すべてのhashとPDF埋込画像を照合。管理者追加{len(admin_lookup)}点も独立マニフェストと照合。',
'- 16既存原本がxlsx ZIPメディアと完全一致し、従来47代表写真の参照を維持。',
'- 42ID一意、37元H列原文一致、ユーザー追加2室の出典・定員未提供を照合。全148PDF写真が一意にgalleryへ対応、6記号と全154埋込出現の分類漏れなし。',
'- 原資料・写真の権利は原権利者に帰属。学外公開・再配布の許諾はこの作業で取得していない。写真には人物が写るものがあり、公開範囲は管理者が確認すること。',
'', '## 原資料のSHA-256','']
for s in data['sourceFiles']: doc.append(f'- [{s["file"]}](<../{s["file"]}>)：`{s["sha256"]}`')
(ROOT/'docs/source-audit.md').write_text('\n'.join(doc)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
