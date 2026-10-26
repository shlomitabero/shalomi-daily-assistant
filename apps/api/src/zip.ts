/**
 * A minimal, dependency-free ZIP writer (PKZIP "store" method — no
 * compression). Used to package a generated standalone app for download
 * without pulling in a zip library. The format is small enough to implement
 * correctly by hand: local file header + data per entry, then one central
 * directory record per entry, then a single end-of-central-directory
 * record. Verified against the system `unzip` utility in zip.test.ts.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A fixed timestamp (DOS date/time) is fine here — these are generated
// files, not user documents; nothing depends on the mtime.
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

export interface ZipEntry {
  path: string;
  content: string | Buffer;
}

const MAX_UINT32 = 0xffffffff;

export function buildZip(entries: ZipEntry[]): Buffer {
  // The end-of-central-directory record's entry-count fields are 16-bit
  // (see below), so more than 65535 entries needs the Zip64 extension
  // format, which this writer doesn't implement. Without this check, that
  // case fails deep inside Buffer#writeUInt16LE with a generic "value...
  // must be <= 65535" RangeError that gives no indication this was an
  // entry-count problem specifically.
  if (entries.length > 0xffff) {
    throw new Error(
      `buildZip: ${entries.length} entries exceeds the 65535-entry limit of this writer (no Zip64 support)`,
    );
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Mirrors the entries.length/nameBuf.length guards below and above --
    // this writer's per-entry local-header-offset field is also fixed-
    // width (32-bit, written into centralHeader below), so once every
    // entry processed so far adds up to more than ~4GB, the NEXT entry's
    // own offset would otherwise fail deep inside Buffer#writeUInt32LE
    // with the same generic, unhelpful RangeError those other two guards
    // exist to avoid (confirmed via a direct repro:
    // Buffer.alloc(46).writeUInt32LE(0x100000000, 42) throws exactly
    // that). Checked before any work on this entry, since it reflects the
    // running total from every PRIOR entry, not anything about this one.
    if (offset > MAX_UINT32) {
      throw new Error(
        `buildZip: the archive's total size so far (${offset} bytes) exceeds the ~4GB limit of this writer's 32-bit offset field (no Zip64 support)`,
      );
    }
    const nameBuf = Buffer.from(entry.path, "utf8");
    // Same reasoning as the entries.length guard above, applied to the
    // other fixed-width field this writer has to fill in per entry: the
    // local/central header's own file-name-length field is also 16-bit
    // (lines below write nameBuf.length into a UInt16LE). Nothing upstream
    // caps an entity/field name's length (EntitySchema/FieldSchema's own
    // `name` has no `.max()`), so a long enough name reaches here and
    // would otherwise fail deep inside Buffer#writeUInt16LE with the same
    // generic, unhelpful RangeError this file's other guard exists to
    // avoid.
    if (nameBuf.length > 0xffff) {
      throw new Error(
        `buildZip: entry "${entry.path}"'s own file name is ${nameBuf.length} bytes, exceeding the 65535-byte limit of this writer's 16-bit field (no Zip64 support)`,
      );
    }
    const dataBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    // Mirrors the offset guard just above, for the sibling 32-bit field
    // this entry's own data length gets written into (lines below write
    // dataBuf.length into a UInt32LE, twice). Checked before crc32 below
    // ever touches this buffer, so a single oversized entry fails fast
    // instead of first paying the cost of hashing it.
    if (dataBuf.length > MAX_UINT32) {
      throw new Error(
        `buildZip: entry "${entry.path}" is ${dataBuf.length} bytes, exceeding the ~4GB limit of this writer's 32-bit size field (no Zip64 support)`,
      );
    }
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // flags: bit 11 = filename is UTF-8
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // flags: bit 11 = filename is UTF-8
    centralHeader.writeUInt16LE(0, 10); // method
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0o644 << 16, 38); // external attrs (unix perms)
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;
  // The end record's own two 32-bit fields below (central-directory size
  // and offset) have the identical ~4GB ceiling as every per-entry field
  // the guards above already check -- the per-entry offset guard above
  // only ever checks the running total BEFORE each entry's own
  // contribution is added, so the FINAL total (the last entry's own
  // contribution included) is never actually checked until here.
  if (centralDirectoryOffset > MAX_UINT32 || centralDirectory.length > MAX_UINT32) {
    throw new Error(
      `buildZip: the archive's total size (${centralDirectoryOffset} bytes of file data plus a ${centralDirectory.length}-byte central directory) exceeds the ~4GB limit of this writer's 32-bit fields (no Zip64 support)`,
    );
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralDirectory.length, 12); // size of central dir
  end.writeUInt32LE(centralDirectoryOffset, 16); // offset of central dir
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, end]);
}
