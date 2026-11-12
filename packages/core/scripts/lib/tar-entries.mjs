/**
 * tar-entries.mjs — the entries of a gzipped tar, read in process.
 *
 * Two tools ask what a tarball holds: `pack-compare.mjs` compares two local
 * packs of one tree, and `check-release-content.mjs` reads the content behind a
 * published version. Both need the same answer, so both read archives here
 * rather than each carrying a reader (or shelling out to `tar`, whose absence
 * or misbehaviour a caller would have to classify as a verdict about the
 * archive).
 *
 * `Unreadable` is the contract: a failure to read is a third state, never a
 * verdict about the content. A caller that reports "the trees differ" for an
 * archive it could not open sends a release looking for a source change that
 * does not exist, and one that reports "equal" for an archive it never opened
 * clears a release it never saw. Both callers exit 2 on this error.
 *
 * The reader handles what npm's packer writes: ustar headers, pax extended
 * headers (`x`) and global headers (`g`), GNU long names and links (`L`, `K`),
 * regular files, directories, and links. An entry type it does not know is
 * refused rather than ignored, because ignoring one silently drops content from
 * whatever the caller is deciding.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** A failure to read, which callers treat as "cannot answer", never a verdict. */
export class Unreadable extends Error {}

function cstr(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(block, start, length, what, where) {
  const raw = cstr(block, start, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Unreadable(`${where}: ${what} field is not octal: ${raw}`);
  return Number.parseInt(raw, 8);
}

/** The header checksum, with the checksum field itself read as spaces. */
function storedChecksum(block) {
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index];
  return sum;
}

function readHeader(where, block) {
  const declared = octal(block, 148, 8, "checksum", where);
  const actual = storedChecksum(block);
  if (declared !== actual) {
    throw new Unreadable(`${where}: header checksum ${declared} does not match the block (${actual})`);
  }
  const flag = block[156] === 0 ? 0x30 : block[156];
  return {
    name: cstr(block, 0, 100),
    prefix: cstr(block, 345, 155),
    size: octal(block, 124, 12, "size", where),
    typeflag: String.fromCharCode(flag),
    linkname: cstr(block, 157, 100),
  };
}

/** `<len> key=value\n` records, as pax extended headers carry them. */
function readPax(text, where) {
  const values = {};
  let rest = text;
  while (rest.length > 0) {
    const space = rest.indexOf(" ");
    if (space < 0) throw new Unreadable(`${where}: truncated pax record`);
    const length = Number.parseInt(rest.slice(0, space), 10);
    if (!Number.isFinite(length) || length <= 0 || length > rest.length) {
      throw new Unreadable(`${where}: pax record length ${rest.slice(0, space)} does not fit the header`);
    }
    const record = rest.slice(0, length);
    const equals = record.indexOf("=");
    if (equals < 0) throw new Unreadable(`${where}: pax record without a value`);
    values[record.slice(space + 1, equals)] = record.slice(equals + 1).replace(/\n$/, "");
    rest = rest.slice(length);
  }
  return values;
}

/**
 * An entry name as a caller compares it: relative, slash-separated, and then
 * checked for the one thing a name may not be. `pkg/…` is kept rather than
 * stripped, since both archives of one tree carry the same prefix and a prefix
 * only one of them carries is itself a difference worth seeing.
 */
function normaliseName(name, where) {
  let clean = name.replace(/\\/g, "/");
  while (clean.startsWith("./")) clean = clean.slice(2);
  clean = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.split("/").includes("..")) {
    throw new Unreadable(`${where}: entry ${name} would land outside the archive's own tree`);
  }
  return clean;
}

/** The name a header block claims, for an error message raised before parsing. */
function headerName(block) {
  const name = cstr(block, 0, 100);
  return name === "" ? "(unnamed)" : name;
}

/** Every entry of a gzipped tar, keyed by its normalised name. */
export function readArchive(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (error) {
    throw new Unreadable(`cannot read ${file}: ${error.code ?? error.message}`);
  }

  let buffer;
  try {
    buffer = gunzipSync(raw);
  } catch (error) {
    throw new Unreadable(`${file}: not a gzipped tar (${error.code ?? error.message})`);
  }

  const entries = new Map();
  let offset = 0;
  let nextPax = null;
  let nextName = null;

  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;

    const header = readHeader(`${file}: ${headerName(block)}`, block);
    const where = `${file}: ${header.name}`;

    if (header.typeflag === "x" || header.typeflag === "g") {
      const end = offset + 512 + header.size;
      if (end > buffer.length) throw new Unreadable(`${where}: pax header runs past the end of the archive`);
      const values = readPax(buffer.subarray(offset + 512, end).toString("utf8"), where);
      if (header.typeflag === "x") nextPax = values;
      offset += 512 + Math.ceil(header.size / 512) * 512;
      continue;
    }
    if (header.typeflag === "L" || header.typeflag === "K") {
      const end = offset + 512 + header.size;
      if (end > buffer.length) throw new Unreadable(`${where}: extended name runs past the end of the archive`);
      if (header.typeflag === "L") nextName = buffer.subarray(offset + 512, end).toString("utf8").replace(/\0+$/, "");
      offset += 512 + Math.ceil(header.size / 512) * 512;
      continue;
    }

    // A pax header may carry the real size, which the fixed field cannot hold.
    let size = header.size;
    if (nextPax && nextPax.size !== undefined) {
      size = Number.parseInt(nextPax.size, 10);
      if (!Number.isFinite(size) || size < 0) throw new Unreadable(`${where}: pax size ${nextPax.size} is not a length`);
    }
    const start = offset + 512;
    if (start + size > buffer.length) throw new Unreadable(`${where}: entry runs past the end of the archive`);
    const data = buffer.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;

    const rawName = nextPax?.path ?? nextName ?? (header.prefix ? `${header.prefix}/${header.name}` : header.name);
    nextPax = null;
    nextName = null;
    const name = normaliseName(rawName, file);
    if (name === "") continue;

    switch (header.typeflag) {
      case "0":
      case "7":
        entries.set(name, { kind: "file", data });
        break;
      case "5":
        break;
      case "1":
      case "2":
        entries.set(name, {
          kind: header.typeflag === "2" ? "symlink" : "hardlink",
          data: Buffer.from(header.linkname),
        });
        break;
      default:
        throw new Unreadable(`${file}: entry ${name} has type "${header.typeflag}", which this reader does not know`);
    }
  }

  if (entries.size === 0) throw new Unreadable(`${file}: the archive holds no entries`);
  return entries;
}
