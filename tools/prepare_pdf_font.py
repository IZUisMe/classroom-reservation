"""Extract licensed Noto Sans JP and word-align glyf records for fontkit subsets.

@pdf-lib/fontkit 1.1.1 chooses short loca offsets for small subsets, but rounds
odd offsets down. The upstream TTF uses valid *long*, odd loca offsets. Padding
records to two bytes fixes that without changing glyph outlines or metrics.
No fontTools, package installation, or Windows font redistribution is needed.
"""
from pathlib import Path
import base64
import hashlib
import struct
import tarfile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / 'tools/noto-sans-jp.tgz'
INTEGRITY = '1vl2U7uYG5JAXGERZaLMXtfOSgyOU4Qhq30OOPrbAHjOu8AW9Pral/qN9Anta9fjd6eVRTijiNqcgy2TowzrDA=='


def checksum(data):
    data = data + b'\0' * (-len(data) % 4)
    return sum(struct.unpack(f'>{len(data)//4}I', data)) & 0xffffffff


def word_align_glyphs(data):
    count = struct.unpack_from('>H', data, 4)[0]
    tables = {}
    for i in range(count):
        tag, _, offset, length = struct.unpack_from('>4sIII', data, 12 + i * 16)
        tables[tag] = data[offset:offset+length]
    glyph_count = struct.unpack_from('>H', tables[b'maxp'], 4)[0]
    loca_format = struct.unpack_from('>h', tables[b'head'], 50)[0]
    if loca_format == 1:
        offsets = struct.unpack(f'>{glyph_count+1}I', tables[b'loca'])
    else:
        offsets = [offset * 2 for offset in struct.unpack(f'>{glyph_count+1}H', tables[b'loca'])]
    glyf = bytearray()
    new_offsets = []
    for start, end in zip(offsets, offsets[1:]):
        new_offsets.append(len(glyf))
        original = tables[b'glyf'][start:end]
        glyf.extend(original)
        if len(glyf) % 2:
            glyf.append(0)
        # Verify byte-for-byte preservation of every glyph, including instructions.
        assert glyf[new_offsets[-1]:new_offsets[-1]+len(original)] == original
    new_offsets.append(len(glyf))
    assert not any(offset % 2 for offset in new_offsets)
    tables[b'glyf'] = bytes(glyf)
    tables[b'loca'] = struct.pack(f'>{glyph_count+1}I', *new_offsets)
    head = bytearray(tables[b'head'])
    struct.pack_into('>I', head, 8, 0)
    struct.pack_into('>h', head, 50, 1)
    tables[b'head'] = bytes(head)
    # Rebuild the SFNT directory; table checksums and whole-file checksum are valid.
    tags = sorted(tables)
    selector = len(tags).bit_length() - 1
    search_range = 16 * 2**selector
    result = bytearray(struct.pack('>4sHHHH', data[:4], len(tags), search_range, selector, len(tags)*16-search_range))
    result.extend(b'\0' * (16 * len(tags)))
    head_offset = None
    for i, tag in enumerate(tags):
        payload = tables[tag]
        offset = len(result)
        struct.pack_into('>4sIII', result, 12+i*16, tag, checksum(payload), offset, len(payload))
        result.extend(payload)
        result.extend(b'\0' * (-len(result) % 4))
        if tag == b'head':
            head_offset = offset
    struct.pack_into('>I', result, head_offset+8, (0xb1b0afba-checksum(result)) & 0xffffffff)
    assert checksum(result) == 0xb1b0afba
    return bytes(result), glyph_count


def main():
    archive = ARCHIVE.read_bytes()
    assert base64.b64encode(hashlib.sha512(archive).digest()).decode() == INTEGRITY, 'Registry archive integrity mismatch'
    with tarfile.open(ARCHIVE) as source:
        original = source.extractfile('package/400Regular/NotoSansJP_400Regular.ttf').read()
        license_text = source.extractfile('package/LICENSE_FONT').read()
    prepared, count = word_align_glyphs(original)
    output = ROOT / 'public/fonts'
    output.mkdir(parents=True, exist_ok=True)
    (output/'NotoSansJP-Regular.ttf').write_bytes(prepared)
    (output/'OFL.txt').write_bytes(license_text)
    print(f'Noto Sans JP: {count} glyphs, {len(prepared)} bytes; outlines/metrics unchanged; glyf word-aligned')


if __name__ == '__main__':
    main()
