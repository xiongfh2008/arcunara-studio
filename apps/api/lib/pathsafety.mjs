// Path segment validation shared by the ZIP extractor and the preview
// server. Security-first: ambiguous or unusual names are rejected outright.

import path from "node:path";

// A segment is valid when it can be joined under a controlled root without
// any chance of traversal, aliasing, or filesystem trickery:
// - no "." / ".." (traversal)
// - no "/" or "\" (separators; backslash also blocks Windows-style confusion)
// - no control characters or NUL
// - no ":" (Windows drive letters, NTFS alternate data streams)
export function isValidSegment(segment, { allowDotfiles = true } = {}) {
  if (typeof segment !== "string" || segment.length === 0) return false;
  if (segment.length > 255) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;

  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }

  if (segment.includes(":")) return false;
  if (!allowDotfiles && segment.startsWith(".")) return false;

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
