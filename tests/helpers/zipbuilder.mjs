// Minimal ZIP archive builder for TESTS ONLY.
// Supports store/deflate entries, explicit Unix modes, DOS-host archives,
// UTF-8/encrypted flag bits, and raw (possibly malicious) entry names.
// Purpose-built so tests can construct valid and hostile archives without
// committing binary fixtures or adding another dependency.

import zlib from "node:zlib";

const DOS_DATE = 0x21; // 1980-01-01, arbitrary fixed date

// entry: { name, data, method?: "store"|"deflate", unixMode?: number|null,
//          host?: 0|3, encrypted?: boolean }
export function buildZip(entries = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw =
      e.data === undefined || e.data === ""
        ? Buffer.alloc(0)
        : typeof e.data === "string"
          ? Buffer.from(e.data, "utf8")
          : e.data;

    const method = e.method === "deflate" ? 8 : 0;
    let comp = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;

    // Traditional PKZIP encryption prefixes the stored data with a 12-byte
    // header — mimic that structure so metadata-level size checks pass and
    // the rejection happens on the encryption flag itself.
    if (e.encrypted) {
      comp = Buffer.concat([Buffer.alloc(12), comp]);
    }

    const crc = zlib.crc32(raw) >>> 0;
    const host = e.host ?? 3;
    const versionMadeBy = (host << 8) | 20;
    const flags = (e.encrypted ? 0x1 : 0) | 0x800;
    const mode = e.unixMode ?? 0o100644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(comp.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, comp);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(versionMadeBy, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(comp.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + comp.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// files: [{ name, data }] with plain regular-file defaults.
export function filesZip(files) {
  return buildZip(
    files.map((f) => ({
      name: f.name,
      data: f.data,
      method: f.method,
      unixMode: f.unixMode
    }))
  );
}
