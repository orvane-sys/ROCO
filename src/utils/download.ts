/** Give the viewer a text file to save. Nothing is uploaded: the file is built in the browser from what is already on the page. */
export function downloadText(name: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** A file-name-safe stamp such as 20261102_1432 for the local time. */
export function fileStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}
