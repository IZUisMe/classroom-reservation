"""Gallery ordering, comments and permanent deletion overlay for regeneration and audits."""
from copy import deepcopy
import re


def apply_gallery_edits(rooms, sources, edits):
    assert isinstance(rooms, list) and isinstance(sources.get('photos'), list)
    assert edits.get('schemaVersion') == 1 and isinstance(edits.get('rooms'), dict)
    output_rooms, output_sources = deepcopy(rooms), deepcopy(sources)
    clean = {'schemaVersion': 1, 'rooms': {}}
    if 'deleted' in edits:
        assert isinstance(edits['deleted'], list)
        for photo in edits['deleted']:
            assert isinstance(photo.get('id'), str) and re.fullmatch(r'[A-Za-z0-9-]+', photo['id'])
            assert re.fullmatch(r'images/rooms/[A-Za-z0-9-]+\.webp', photo['src'])
        clean['deleted'] = deepcopy(edits['deleted'])
    deleted = {photo['id'] for photo in edits.get('deleted', [])}
    output_sources['photos'] = [photo for photo in output_sources['photos'] if photo['id'] not in deleted]
    room_ids = {room['id'] for room in rooms}
    for rid, edit in edits['rooms'].items():
        assert rid in room_ids and isinstance(edit, dict)
        known = {record['id'] for record in output_sources['photos'] if record['roomId'] == rid and record['status'] == 'available' and record.get('webp')}
        for key in ['order', 'hidden']:
            values = edit.get(key)
            assert isinstance(values, list) and len(values) <= 10000
            assert all(isinstance(value, str) for value in values)
            assert len(set(values)) == len(values) and set(values) <= known
        assert set(edit['hidden']) <= set(edit['order'])
        clean['rooms'][rid] = {'order': list(edit['order']), 'hidden': list(edit['hidden'])}
        if 'comment' in edit:
            assert isinstance(edit['comment'], str) and len(edit['comment'].encode('utf-16-le')) // 2 <= 300
            clean['rooms'][rid]['comment'] = edit['comment']
    total = visible = 0
    for room in output_rooms:
        records = [record for record in output_sources['photos'] if record['roomId'] == room['id'] and record['status'] == 'available' and record.get('webp')]
        lookup = {record['id']: record for record in records}
        assert len(lookup) == len(records)
        for record in records:
            assert record['kind'] in ['interior', 'exterior']
            assert re.fullmatch(r'images/rooms/[A-Za-z0-9-]+\.webp', record['webp']['src'])
        edit = clean['rooms'].get(room['id'])
        if edit is not None and 'comment' in edit:
            room['comment'] = edit['comment']
        order = []
        for sid in (edit['order'] if edit else []) + [photo['sourceId'] for photo in room.get('gallery', [])] + [record['id'] for record in records]:
            if sid in lookup and sid not in order:
                order.append(sid)
        hidden = set(edit['hidden'] if edit else [])
        if edit is not None:
            edit['order'] = order
        gallery = []
        for sid in order:
            if sid in hidden:
                continue
            record = lookup[sid]
            photo = {'src': record['webp']['src'], 'kind': record['kind'], 'source': record.get('source'), 'sourceId': sid, 'width': record['webp']['width'], 'height': record['webp']['height']}
            if 'page' in record:
                photo['page'] = record['page']
            gallery.append(photo)
        room['gallery'] = gallery
        room.setdefault('images', {})
        room.setdefault('photoStatus', {})
        for kind in ['interior', 'exterior']:
            first = next((photo for photo in gallery if photo['kind'] == kind), None)
            image = {key: first[key] for key in ['src', 'source', 'sourceId']} if first else None
            if first and 'page' in first:
                image['page'] = first['page']
            room['images'][kind] = image
            room['photoStatus'][kind] = 'available' if first else 'missing'
        total += len(records)
        visible += len(gallery)
    physical = {record['webp']['src']: record['webp'] for record in output_sources['photos'] if record['status'] == 'available' and record.get('webp')}
    output_sources.setdefault('summary', {}).update({'roomCount': len(output_rooms), 'galleryPhotoCount': visible, 'hiddenPhotoCount': total - visible, 'webpCount': len(physical), 'webpBytes': sum(photo['bytes'] for photo in physical.values()), 'interiorAvailable': sum(room['images']['interior'] is not None for room in output_rooms), 'interiorMissing': [room['id'] for room in output_rooms if room['images']['interior'] is None], 'exteriorAvailable': sum(room['images']['exterior'] is not None for room in output_rooms)})
    return output_rooms, output_sources, clean
