// Minimal Borsh reader driven by Anchor IDL type descriptors.
import { base58Encode } from './base58.js';

export class OutOfData extends Error {}

export class BorshReader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.off = offset;
  }
  need(n) {
    if (this.off + n > this.buf.length) throw new OutOfData(`need ${n} bytes at ${this.off}`);
  }
  u8() { this.need(1); return this.view.getUint8(this.off++); }
  bool() { return this.u8() !== 0; }
  u16() { this.need(2); const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.off, true); this.off += 4; return v; }
  // 64-bit values are returned as Number. Lamports and token base units used here stay far
  // below 2^53, so this is exact for everything the analysis relies on.
  u64() { this.need(8); const v = this.view.getBigUint64(this.off, true); this.off += 8; return Number(v); }
  i64() { this.need(8); const v = this.view.getBigInt64(this.off, true); this.off += 8; return Number(v); }
  u128() {
    this.need(16);
    const lo = this.view.getBigUint64(this.off, true);
    const hi = this.view.getBigUint64(this.off + 8, true);
    this.off += 16;
    return Number((hi << 64n) | lo);
  }
  string() {
    const len = this.u32();
    this.need(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.off, this.off + len));
    this.off += len;
    return s;
  }
  pubkey() {
    this.need(32);
    const s = base58Encode(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return s;
  }

  read(type, types) {
    if (typeof type === 'string') {
      switch (type) {
        case 'u8': return this.u8();
        case 'bool': return this.bool();
        case 'u16': return this.u16();
        case 'u32': return this.u32();
        case 'i32': return this.i32();
        case 'u64': return this.u64();
        case 'i64': return this.i64();
        case 'u128': return this.u128();
        case 'string': return this.string();
        case 'pubkey':
        case 'publicKey': return this.pubkey();
        default: throw new Error(`unsupported type ${type}`);
      }
    }
    if (type.vec) {
      const n = this.u32();
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.read(type.vec, types));
      return out;
    }
    if (type.option) return this.u8() ? this.read(type.option, types) : null;
    if (type.array) {
      const [inner, n] = type.array;
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.read(inner, types));
      return out;
    }
    if (type.defined) {
      const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
      const def = types.get(name);
      if (!def) throw new Error(`unknown type ${name}`);
      return this.readStruct(def.type.fields, types).value;
    }
    throw new Error(`unsupported type ${JSON.stringify(type)}`);
  }

  // Reads struct fields in order. When `partial` is true and the payload ends early (an
  // older event version without the newest trailing fields), returns what was read.
  readStruct(fields, types, partial = false) {
    const value = {};
    let complete = true;
    for (const f of fields) {
      try {
        value[f.name] = this.read(f.type, types);
      } catch (e) {
        if (partial && e instanceof OutOfData) { complete = false; break; }
        throw e;
      }
    }
    return { value, complete };
  }
}
