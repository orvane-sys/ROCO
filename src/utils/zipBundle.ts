// Unpacks an imported zip in a worker (src/workers/zipWorker.ts) and hands its files to the importer as File objects
// whose `webkitRelativePath` is their path inside the zip, the same shape a folder import has.
import { LIMITS, refuse, refusalMessage, ImportRefused, type RefusalReason } from './importLimits'
import type { ZipReply } from '../workers/zipWorker'

export const isZip = (f: File): boolean => /\.zip$/i.test(f.name)

export async function unpackZip(file: File, onProgress?: (done: number, total: number) => void): Promise<File[]> {
  if (file.size > LIMITS.zipFile) throw refuse('too big', `${file.name}: ${Math.round(file.size / 2 ** 20)} MiB`)
  const buf = await file.arrayBuffer()
  const worker = new Worker(new URL('../workers/zipWorker.ts', import.meta.url), { type: 'module' })
  try {
    const files = await new Promise<{ path: string; buf: ArrayBuffer }[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(refuse('time', file.name)), LIMITS.zipMs)
      const end = (fn: () => void) => {
        clearTimeout(timer)
        fn()
      }
      worker.onmessage = ({ data }: MessageEvent<ZipReply>) => {
        if (data.type === 'progress') onProgress?.(data.done, data.total)
        else if (data.type === 'done') end(() => resolve(data.files))
        else if (data.type === 'refused') {
          const reason = data.reason as RefusalReason
          end(() => reject(new ImportRefused(reason, data.detail, refusalMessage(reason, data.detail))))
        } else end(() => reject(new Error(`The zip could not be unpacked: ${data.detail}`)))
      }
      worker.onerror = (e) => end(() => reject(new Error(`The zip could not be unpacked: ${e.message || 'the unzip worker failed'}`)))
      worker.postMessage({ buf }, [buf])
    })
    return files.map(({ path, buf: bytes }) => {
      const f = new File([bytes], path.split('/').pop() ?? path)
      Object.defineProperty(f, 'webkitRelativePath', { value: path, configurable: true })
      return f
    })
  } finally {
    worker.terminate()
  }
}
