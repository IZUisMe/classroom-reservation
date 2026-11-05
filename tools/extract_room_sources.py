"""Extract source objects only; page rendering is deliberately not performed here."""
from pathlib import Path
import sys, json, io, hashlib, zipfile
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'tools/python-deps'))
from openpyxl import load_workbook
from PIL import Image

def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

def workbook():
    file=ROOT/'【YC】学内施設使用許可願生成マシーン (2).xlsx'
    wb=load_workbook(file,data_only=False)
    cached=load_workbook(file,data_only=True)
    ws=wb['教室データベース']; cs=cached[ws.title]
    out=ROOT/'assets/source-photos/xlsx'; out.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(file) as z:
        media_by_hash={hashlib.sha256(z.read(name)).hexdigest():name for name in z.namelist() if name.startswith('xl/media/')}
    rows=[]; images=[]
    for row in range(2,ws.max_row+1):
        values={c.column_letter:c.value for c in ws[row] if c.value is not None}
        cache={c.column_letter:c.value for c in cs[row] if c.value is not None}
        comments={c.column_letter:{'text':c.comment.text,'author':c.comment.author} for c in ws[row] if c.comment}
        rows.append({'row':row,'values':values,'cached':cache,'comments':comments})
    for i,im in enumerate(ws._images,1):
        a=im.anchor._from; data=im._data(); ext='jpg' if im.format=='jpeg' else im.format
        path=out/f'image-{i:02d}-r{a.row+1}-{chr(65+a.col)}.{ext}'
        path.write_bytes(data)
        digest=hashlib.sha256(data).hexdigest()
        assert digest in media_by_hash, 'Extracted workbook image must be byte-identical to its ZIP media entry'
        images.append({'mediaPath':media_by_hash[digest],'index':i,'row':a.row+1,'column':chr(65+a.col),'original':path.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(data).hexdigest(),'width':im.width,'height':im.height})
    dump(ROOT/'inspection/xlsx-rooms.json',{'file':file.name,'sheet':ws.title,'rows':rows,'images':images})
    print('Workbook row slots',len(rows),'populated',sum(bool(r['values']) for r in rows),'images',len(images))

def pdf():
    import pymupdf
    doc=pymupdf.open(ROOT/'roomlist.pdf'); out=ROOT/'assets/source-photos/pdf'; out.mkdir(parents=True,exist_ok=True)
    pages=[]
    for idx,page in enumerate(doc,1):
        text=page.get_text(sort=True)
        textdir=ROOT/'inspection/pdf-text'; textdir.mkdir(exist_ok=True)
        (textdir/f'page-{idx:02d}.txt').write_text(text,encoding='utf-8')
        images=[]
        for n,info in enumerate(page.get_image_info(xrefs=True),1):
            xref=info['xref']
            if not xref: continue
            obj=doc.extract_image(xref); data=obj['image']; ext=obj['ext']
            path=out/f'page-{idx:02d}-image-{n:02d}-xref-{xref}.{ext}'; path.write_bytes(data)
            images.append({'index':n,'xref':xref,'bbox':list(info['bbox']),'width':obj['width'],'height':obj['height'],'original':path.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(data).hexdigest()})
        pages.append({'page':idx,'width':page.rect.width,'height':page.rect.height,'text':text,'images':images})
    dump(ROOT/'inspection/pdf-report.json',{'file':'roomlist.pdf','pageCount':len(doc),'pages':pages})
    print('PDF pages',len(doc),'embedded image occurrences',sum(len(p['images']) for p in pages))

if __name__=='__main__':
    workbook()
    if '--xlsx-only' not in sys.argv: pdf()
