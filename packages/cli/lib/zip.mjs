// Minimal ZIP writer for the Arcunara CLI (directory packaging).
//
// No third-party dependencies: crc32 + zlib.deflateRaw + ZIP32 structures.
// Every entry name is stored UTF-8 with the language flag (0x0800) so
// Chinese / Unicode file names survive the round trip to the server.

import zlib from "node:zlib";

// DOS date/time (local time of the packed file; prototypes do not care).
function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);

  return { time, day };
}

function deflateBest(data) {
  const deflated = zlib.deflateRawSync(data, { level: 6 });

  // Store (method 0) when compression does not help — keeps the server's
  // extraction fast for already-compressed assets (images, fonts).
  if (deflated.length < data.length) {
    return { data: deflated, method: 8 };
  }

  return { data, method: 0 };
}

// Builds a ZIP archive from an ordered list of { name, data, mtime? }
// entries. `name` uses forward slashes and must not start with "/".
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");

    if (name.length > 0xffff || entry.data.length > 0xffffffff) {
      throw new Error(`ZIP entry too large: ${entry.name}`);
    }

    const { data, method } = deflateBest(entry.data);
    const crc = zlib.crc32(entry.data) >>> 0;
    const { time, day } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(0x031e, 4); // made by: UNIX, spec 3.0
    dir.writeUInt16LE(20, 6); // needed version
    dir.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs: rw-r--r--
    dir.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([dir, name]));
    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);

  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
