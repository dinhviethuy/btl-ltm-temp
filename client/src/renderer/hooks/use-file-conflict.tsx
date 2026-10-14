import { useCallback, useRef, useState } from 'react'

import { FileConflictDialog, type FileConflictResolution } from '../components/file-conflict-dialog'

export function useFileConflict(): {
  resolveConflict: (fileName: string) => Promise<FileConflictResolution>
  conflictDialog: React.JSX.Element
} {
  const [fileName, setFileName] = useState<string | null>(null)
  const resolver = useRef<((resolution: FileConflictResolution) => void) | null>(null)

  const resolveConflict = useCallback((nextFileName: string): Promise<FileConflictResolution> => {
    resolver.current?.({ action: 'cancel' })
    setFileName(nextFileName)

    return new Promise((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const handleResolve = (resolution: FileConflictResolution): void => {
    const resolve = resolver.current
    resolver.current = null
    setFileName(null)
    resolve?.(resolution)
  }

  return {
    resolveConflict,
    conflictDialog: <FileConflictDialog fileName={fileName} onResolve={handleResolve} />
  }
}
