"""Integration test: regenerate and audit an isolated copy, never production data."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding='utf-8')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(root, name):
    return json.loads((root / name).read_text(encoding='utf-8'))

def write(root, name, value):
    (root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

protected = list((ROOT / 'public/data').glob('*.json')) + list((ROOT / 'public/images/rooms').glob('*.webp'))
before = {str(path): sha(path) for path in protected}
results = ROOT / 'test-results'
results.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='gallery-regeneration-', dir=results) as temporary:
    fixture = Path(temporary).resolve()
    assert fixture.parent == results.resolve() and fixture.name.startswith('gallery-regeneration-')
    def copy(relative):
        source, target = ROOT / relative, fixture / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    for relative in ['tools/build_room_galleries.py', 'tools/build_rooms_data.py', 'tools/validate_room_sources.py', 'tools/photo_gallery_edits.py', 'inspection/xlsx-rooms.json', 'inspection/pdf-report.json', 'inspection/room-pdf-mapping.json', 'inspection/room-gallery-classification.json']:
        copy(relative)
    for path in (ROOT / 'public/data').glob('*.json'):
        copy(path.relative_to(ROOT))
    for path in (ROOT / 'public/images/rooms').glob('*.webp'):
        copy(path.relative_to(ROOT))
    for path in (ROOT / 'assets/source-photos').rglob('*'):
        if path.is_file():
            copy(path.relative_to(ROOT))
    sources = read(ROOT, 'public/data/photo-sources.json')
    for source in sources['sourceFiles']:
        copy(source['file'])
    (fixture / 'docs').mkdir(exist_ok=True)
    rooms = read(fixture, 'public/data/rooms.json')
    by_room = {room['id']: room for room in rooms}
    edits = {'schemaVersion': 1, 'rooms': {}}
    for rid in ['32C', '72BC']:
        ids = [photo['sourceId'] for photo in by_room[rid]['gallery']]
        assert len(ids) > 1
        edits['rooms'][rid] = {'order': list(reversed(ids)), 'hidden': [ids[0]]}
    write(fixture, 'public/data/photo-edits.json', edits)
    manifest = read(fixture, 'public/data/admin-photos.json')
    new_id = 'admin-' + str(uuid.uuid4())
    original = manifest['photos'][0]
    photo = dict(original, id=new_id, roomId='72BC', src=f'images/rooms/{new_id}.webp', addedAt='2026-11-05T00:00:00.000Z')
    shutil.copy2(fixture / 'public' / original['src'], fixture / 'public' / photo['src'])
    manifest['photos'].append(photo)
    write(fixture, 'public/data/admin-photos.json', manifest)
    env = dict(os.environ)
    env['PYTHONPATH'] = str(ROOT / 'tools/python-deps') + os.pathsep + env.get('PYTHONPATH', '')
    subprocess.run([sys.executable, str(fixture / 'tools/build_room_galleries.py')], cwd=fixture, env=env, check=True)
    subprocess.run([sys.executable, str(fixture / 'tools/validate_room_sources.py')], cwd=fixture, env=env, check=True)
    generated_rooms = read(fixture, 'public/data/rooms.json')
    generated_sources = read(fixture, 'public/data/photo-sources.json')
    generated_edits = read(fixture, 'public/data/photo-edits.json')
    assert generated_sources['summary']['hiddenPhotoCount'] == 2
    assert generated_sources['summary']['webpCount'] == 164 + len(manifest['photos'])
    assert generated_sources['summary']['galleryPhotoCount'] == 162 + len(manifest['photos'])
    assert generated_edits['rooms']['72BC']['order'][-1] == new_id
    assert generated_edits['rooms']['72BC']['hidden'] == edits['rooms']['72BC']['hidden']
    for room in generated_rooms:
        hidden = set(generated_edits['rooms'].get(room['id'], {}).get('hidden', []))
        assert not hidden.intersection(photo['sourceId'] for photo in room['gallery'])
    # Re-running source generation must not restore hidden photos or change order.
    candidates = list((fixture / 'public/data').glob('*.json')) + list((fixture / 'public/images/rooms').glob('*.webp'))
    snapshot = {str(path): sha(path) for path in candidates}
    subprocess.run([sys.executable, str(fixture / 'tools/build_room_galleries.py')], cwd=fixture, env=env, check=True)
    assert snapshot == {str(path): sha(path) for path in candidates}
    # Restoring is an overlay change only; all physical image files are still there.
    sys.path.insert(0, str(ROOT / 'tools'))
    from photo_gallery_edits import apply_gallery_edits
    restore = json.loads(json.dumps(generated_edits))
    for edit in restore['rooms'].values():
        edit['hidden'] = []
    restored_rooms, restored_sources, _ = apply_gallery_edits(generated_rooms, generated_sources, restore)
    assert restored_sources['summary']['hiddenPhotoCount'] == 0
    assert sum(len(room['gallery']) for room in restored_rooms) == 164 + len(manifest['photos'])
    print('Isolated regeneration, original/admin hide+restore, new upload append and byte idempotence: PASS')
    # Permanently deleted original primaries, PDF detail images and uploads must
    # stay absent after both entry points rebuild their original sources.
    delete_records = [next(photo for photo in generated_sources['photos'] if photo['id'] == '31A-interior'),
                      next(photo for photo in generated_sources['photos'] if photo['id'].startswith('31A-pdf-')),
                      next(photo for photo in generated_sources['photos'] if photo['id'] == new_id)]
    deleted_ids = {photo['id'] for photo in delete_records}
    generated_edits['deleted'] = [{'id': photo['id'], 'src': photo['webp']['src'], 'roomId': photo['roomId'], 'sourceType': photo['sourceType'], 'preservedExisting': bool(photo.get('preservedExisting')), **({'page': photo['page'], 'pdfImageIndex': photo['pdfImageIndex']} if 'pdfImageIndex' in photo else {})} for photo in delete_records]
    for edit in generated_edits['rooms'].values():
        edit['order'] = [sid for sid in edit['order'] if sid not in deleted_ids]
        edit['hidden'] = [sid for sid in edit['hidden'] if sid not in deleted_ids]
    generated_edits['rooms']['31A'] = {'order': [], 'hidden': [], 'comment': '管理者の一言コメント'}
    generated_rooms, generated_sources, generated_edits = apply_gallery_edits(generated_rooms, generated_sources, generated_edits)
    manifest['photos'] = [photo for photo in manifest['photos'] if photo['id'] not in deleted_ids]
    write(fixture, 'public/data/admin-photos.json', manifest)
    write(fixture, 'public/data/rooms.json', generated_rooms)
    write(fixture, 'public/data/photo-sources.json', generated_sources)
    write(fixture, 'public/data/photo-edits.json', generated_edits)
    for photo in delete_records:
        (fixture / 'public' / photo['webp']['src']).unlink()
    for entry in ['build_room_galleries.py', 'build_rooms_data.py']:
        subprocess.run([sys.executable, str(fixture / 'tools' / entry)], cwd=fixture, env=env, check=True, stdout=subprocess.DEVNULL)
        rebuilt = read(fixture, 'public/data/rooms.json')
        assert not deleted_ids.intersection(photo['sourceId'] for room in rebuilt for photo in room['gallery'])
        assert next(room for room in rebuilt if room['id'] == '31A')['comment'] == '管理者の一言コメント'
        assert all(not (fixture / 'public' / photo['webp']['src']).exists() for photo in delete_records)
        subprocess.run([sys.executable, str(fixture / 'tools/validate_room_sources.py')], cwd=fixture, env=env, check=True, stdout=subprocess.DEVNULL)
    print('Permanent source/upload deletions and comments survive both regeneration entry points: PASS')
assert before == {str(path): sha(path) for path in protected}, 'Production data changed during isolated test'
print(f'Production data preserved: {len(protected)} files, {len(read(ROOT, "public/data/admin-photos.json")["photos"])} administrator photos')
