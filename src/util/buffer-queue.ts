export class BufferQueue {
  private buffers: Buffer[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private totalLength = 0;
  private cache: { globalPos: number; bufferIndex: number; bufferOffset: number } | undefined;

  push(buffer: Buffer): void {
    if (!buffer.length) return;
    this.buffers.push(buffer);
    this.totalLength += buffer.length;
  }

  get length(): number {
    return this.totalLength;
  }

  consume(bytes: number): void {
    if (bytes <= 0) return;
    if (bytes > this.totalLength) {
      throw new RangeError(
        `Cannot consume ${bytes} bytes from buffer of length ${this.totalLength}.`,
      );
    }

    this.cache = undefined;
    this.totalLength -= bytes;

    let remaining = bytes;
    while (remaining > 0) {
      const head = this.buffers[this.headIndex];
      const headRemaining = head.length - this.headOffset;
      if (remaining < headRemaining) {
        this.headOffset += remaining;
        remaining = 0;
        break;
      }

      remaining -= headRemaining;
      this.headIndex += 1;
      this.headOffset = 0;
    }

    if (this.totalLength === 0) {
      this.buffers = [];
      this.headIndex = 0;
      this.headOffset = 0;
      return;
    }

    if (this.headIndex > 64 && this.headOffset === 0) {
      this.buffers = this.buffers.slice(this.headIndex);
      this.headIndex = 0;
    }
  }

  slice(start: number, end: number): Buffer {
    if (start < 0 || end < 0 || start > end) {
      throw new RangeError(`Invalid slice range: start=${start}, end=${end}.`);
    }
    if (end > this.totalLength) {
      throw new RangeError(`Slice range end=${end} exceeds buffer length ${this.totalLength}.`);
    }

    const length = end - start;
    if (length === 0) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(length);
    let outputOffset = 0;

    let bufferIndex = this.headIndex;
    let bufferOffset = this.headOffset;
    let skip = start;

    while (skip > 0) {
      const current = this.buffers[bufferIndex];
      const available = current.length - bufferOffset;
      if (skip < available) {
        bufferOffset += skip;
        skip = 0;
        break;
      }
      skip -= available;
      bufferIndex += 1;
      bufferOffset = 0;
    }

    let remaining = length;
    while (remaining > 0) {
      const current = this.buffers[bufferIndex];
      const available = current.length - bufferOffset;
      const toCopy = Math.min(available, remaining);
      current.copy(output, outputOffset, bufferOffset, bufferOffset + toCopy);
      outputOffset += toCopy;
      remaining -= toCopy;
      bufferIndex += 1;
      bufferOffset = 0;
    }

    return output;
  }

  startsWith(prefix: Buffer, offset = 0): boolean {
    if (offset < 0) return false;
    if (prefix.length + offset > this.totalLength) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (this.byteAt(offset + i) !== prefix[i]) return false;
    }
    return true;
  }

  byteAt(pos: number): number {
    if (pos < 0 || pos >= this.totalLength) {
      throw new RangeError(`byteAt(${pos}) is out of range for length ${this.totalLength}.`);
    }

    let bufferIndex: number;
    let bufferOffset: number;
    let remaining: number;

    if (this.cache && pos >= this.cache.globalPos) {
      bufferIndex = this.cache.bufferIndex;
      bufferOffset = this.cache.bufferOffset;
      remaining = pos - this.cache.globalPos;
    } else {
      bufferIndex = this.headIndex;
      bufferOffset = this.headOffset;
      remaining = pos;
    }

    while (bufferIndex < this.buffers.length) {
      const current = this.buffers[bufferIndex];
      const available = current.length - bufferOffset;
      if (remaining < available) {
        const resolvedOffset = bufferOffset + remaining;
        this.cache = { globalPos: pos, bufferIndex, bufferOffset: resolvedOffset };
        return current[resolvedOffset];
      }
      remaining -= available;
      bufferIndex += 1;
      bufferOffset = 0;
    }

    throw new RangeError(`byteAt(${pos}) could not resolve within queued buffers.`);
  }

  indexOf(needle: Buffer, from = 0): number {
    if (from < 0) from = 0;
    if (!needle.length) return Math.min(from, this.totalLength);
    if (this.totalLength - from < needle.length) return -1;

    const first = needle[0];
    const lastStart = this.totalLength - needle.length;
    for (let i = from; i <= lastStart; i++) {
      if (this.byteAt(i) !== first) continue;
      let matches = true;
      for (let j = 1; j < needle.length; j++) {
        if (this.byteAt(i + j) !== needle[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return i;
    }
    return -1;
  }
}
