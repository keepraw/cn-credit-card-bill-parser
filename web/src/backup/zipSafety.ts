import type JSZip from 'jszip'

export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_JSON_BYTES = 32 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 20_000

export async function readArchiveBytes(file: Blob): Promise<ArrayBuffer> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('备份压缩包过大')
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('无法读取备份压缩包'))
    reader.readAsArrayBuffer(file)
  })
}

/** Inspect the standard ZIP directory before JSZip can normalize duplicate paths. */
export function validateZipDirectory(buffer: ArrayBuffer): void {
  const data = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (data.getUint32(end, true) === 0x06054b50 && end + 22 + data.getUint16(end + 20, true) === bytes.length) break
  }
  if (end < 0 || end < bytes.length - 65557) throw new Error('ZIP 目录损坏')
  const count = data.getUint16(end + 10, true)
  let offset = data.getUint32(end + 16, true)
  const directoryEnd = offset + data.getUint32(end + 12, true)
  if (data.getUint16(end + 4, true) !== 0 || data.getUint16(end + 6, true) !== 0 ||
    data.getUint16(end + 8, true) !== count || count === 65535 || count > MAX_ZIP_ENTRIES ||
    directoryEnd > end || offset > directoryEnd) throw new Error('ZIP 目录不受支持或过大')
  const names = new Set<string>()
  let expanded = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || data.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const length = data.getUint16(offset + 28, true)
    const next = offset + 46 + length + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true)
    if (next > directoryEnd) throw new Error('ZIP 目录损坏')
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length))
    if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('ZIP 包含重复或不安全路径')
    names.add(name)
    const size = data.getUint32(offset + 24, true)
    expanded += size
    const limit = name === 'database.json' || name === 'manifest.json' ? MAX_JSON_BYTES : MAX_ENTRY_BYTES
    if (size > limit || expanded > MAX_EXPANDED_BYTES) throw new Error('ZIP 解压内容过大')
    offset = next
  }
  if (offset !== directoryEnd) throw new Error('ZIP 目录损坏')
}

// JSZip documents file.internalStream, but omits it from its 3.10 type declarations.
type StreamingEntry = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>
}

/** Bound actual decompression too, rather than trusting declared directory sizes. */
export function readZipEntry(entry: JSZip.JSZipObject, limit: number, budget: { remaining: number }): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    const stream = (entry as StreamingEntry).internalStream('uint8array')
    stream.on('data', (chunk) => {
      size += chunk.byteLength
      budget.remaining -= chunk.byteLength
      if (size > limit || budget.remaining < 0) {
        stream.pause()
        reject(new Error('ZIP 解压内容过大'))
        return
      }
      chunks.push(chunk)
    }).on('error', reject).on('end', () => {
      const result = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
      resolve(result.buffer)
    }).resume()
  })
}
