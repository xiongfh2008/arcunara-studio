// Path segment validation shared by the ZIP extractor and the preview
// server. Security-first: ambiguous or unusual names are rejected outright.

import path from "node:path";

// Windows reserved device names (case-insensitive, with or without
// extension) are rejected — they can alias hardware devices on Windows.
const WINDOWS_RESERVED =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

// A segment is valid when it can be joined under a controlled root without
// any chance of traversal, aliasing, or filesystem trickery:
// - no "." / ".." (traversal)
// - no "/" or "\" (separators; backslash also blocks Windows-style confusion)
// - no control characters or NUL
// - no ":" (Windows drive letters, NTFS alternate data streams)
// - at most 255 UTF-8 bytes and no Windows reserved device name
export function isValidSegment(segment, { allowDotfiles = true } = {}) {
  if (typeof segment !== "string" || segment.length === 0) return false;
  if (Buffer.byteLength(segment, "utf8") > 255) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;

  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }

  if (segment.includes(":")) return false;
  if (!allowDotfiles && segment.startsWith(".")) return false;
  if (WINDOWS_RESERVED.test(segment)) return false;

  return true;
}

// Joins pre-validated segments under root and re-checks containment
// afterwards (defense in depth).
export function safeJoin(rootDir, segments) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }

  return resolved;
}

// Collision key treating NFC/NFD variants and case differences as equal,
// used by the extractor to reject duplicate/aliasing ZIP entries before
// they can overwrite each other on case-insensitive filesystems.
export function collisionKey(name) {
  return name.normalize("NFC").toLowerCase();
}
