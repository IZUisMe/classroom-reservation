"""Read capacities from the dated 2025-09 PDF summary, retaining detailed-page discrepancies."""
from pathlib import Path
import json,re
ROOT=Path(__file__).resolve().parent.parent
mapping_path=ROOT/'inspection/room-pdf-mapping.json'
mapping=json.loads(mapping_path.read_text(encoding='utf-8'))
report=json.loads((ROOT/'inspection/pdf-report.json').read_text(encoding='utf-8'))
text=report['pages'][0]['text']
summary={m.group(1):int(m.group(2)) for m in re.finditer(r'(\d{2}[A-K]教室|FEISホール)\s+(\d+)\s',text)}
# Printed numbers were visually checked against the source table (page 1).
expected={'FEISホール':270,'31A教室':300,'31B教室':134,'31C教室':134,'31D教室':77,'31E教室':60,'31F教室':41,'32A教室':198,'32B教室':89,'32C教室':20,'32D教室':89,'32E教室':20,'32F教室':77,'32G教室':77,'32H教室':154,'32I教室':58,'32J教室':53,'32K教室':126,'33A教室':40,'33B教室':40,'33C教室':20,'33D教室':20,'33E教室':20,'33F教室':20,'33G教室':20,'33H教室':64,'33I教室':204,'33K教室':126,'21A教室':100,'22B教室':100,'22D教室':40,'22E教室':40,'22H教室':100,'22G教室':132}
assert summary==expected,(summary,expected)
conflicts=[]
for rid,entry in mapping['rooms'].items():
    label=entry['label']; page=report['pages'][entry['page']-1]
    # Layout extraction places the printed capacity as the first number after the header.
    # Match only values followed by an actual desk-type word, not any equipment counts.
    match=re.search(r'(?<!\d)(\d+)\s+(?:固定|移動)',page['text'])
    detailed=int(match.group(1)) if match else None
    value=summary.get(label)
    evidence={'source':'roomlist.pdf','page':1,'table':'教室設備機器一覧','asOf':'2025-09','capacity':value,'individualPage':entry['page'],'individualPageCapacity':detailed,'status':'confirmed' if value==detailed else ('not-specified' if value is None else 'conflict'),'policy':'定員は2025年9月現在と明記されたPDF1ページの一覧表を採用。個別ページと異なる場合は両値を保存。設備は不確実な列対応・更新差異を避け追加しない。'}
    entry['capacity']=value
    entry['equipment']=None
    entry['metadataEvidence']=evidence
    if evidence['status']=='conflict':conflicts.append({'roomId':rid,**evidence})
mapping['metadataConflicts']=conflicts
mapping['summaryAsOf']='2025-09'
mapping_path.write_text(json.dumps(mapping,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Capacities:',len(summary),'summary rows;',len(conflicts),'conflicts')
for c in conflicts: print(c['roomId'],c['capacity'],c['individualPageCapacity'])
