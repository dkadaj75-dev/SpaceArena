const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

function encodeBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >>> 18) & 63]!;
    out += ALPHABET[(n >>> 12) & 63]!;
    out += i + 1 < bytes.length ? ALPHABET[(n >>> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : "=";
  }
  return out;
}

function decodeBytes(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0) throw new Error("invalid base64 length");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const ch = value[i + j]!;
      const isPadding = ch === "=";
      if (isPadding && (i + 4 !== value.length || j < 2 || j < 4 - padding)) {
        throw new Error("invalid base64 padding");
      }
      const code = ch.charCodeAt(0);
      const digit = isPadding ? 0 : code < DECODE.length ? DECODE[code]! : -1;
      if (digit < 0) throw new Error("invalid base64 character");
      n = n * 64 + digit;
    }
    if (offset < out.length) out[offset++] = (n >>> 16) & 255;
    if (offset < out.length) out[offset++] = (n >>> 8) & 255;
    if (offset < out.length) out[offset++] = n & 255;
  }
  return out;
}

function encodeWords(values: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (values instanceof Float32Array) view.setFloat32(i * 4, values[i]!, true);
    else view.setUint32(i * 4, values[i]!, true);
  }
  return encodeBytes(bytes);
}

export function encodeFloat32Array(values: Float32Array): string {
  return encodeWords(values);
}

export function encodeUint32Array(values: Uint32Array): string {
  return encodeWords(values);
}

export function decodeFloat32Array(value: string): Float32Array {
  const bytes = decodeBytes(value);
  if (bytes.length % 4 !== 0) throw new Error("Float32Array byte length must be divisible by 4");
  const out = new Float32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function decodeUint32Array(value: string): Uint32Array {
  const bytes = decodeBytes(value);
  if (bytes.length % 4 !== 0) throw new Error("Uint32Array byte length must be divisible by 4");
  const out = new Uint32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}
