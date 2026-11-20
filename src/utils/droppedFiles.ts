/**
 * Flattens a drag-and-drop payload into files. `dataTransfer.files` only yields a folder as an opaque
 * zero-byte entry, so directories are walked through the (webkit) FileSystem entry API. Each file keeps
 * its folder path in `webkitRelativePath` so same-named meshes in different folders stay distinguishable.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dataTransfer.items ?? [])) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return Array.from(dataTransfer.files)

  const out: File[] = []
  const readAll = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const all: FileSystemEntry[] = []
      const next = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(all)
          else {
            all.push(...batch)
            next() // readEntries returns at most ~100 entries per call
          }
        }, reject)
      next()
    })
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      const relative = entry.fullPath.replace(/^\/+/, '')
      if (relative.includes('/')) {
        Object.defineProperty(file, 'webkitRelativePath', { value: relative, configurable: true })
      }
      out.push(file)
    } else if (entry.isDirectory) {
      for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(child)
    }
  }
  for (const entry of entries) await walk(entry)
  return out
}
