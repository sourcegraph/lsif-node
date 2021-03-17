import ts from 'typescript-lsif'

export const makeLanguageServiceHost = (
  config: ts.ParsedCommandLine,
  currentDirectory: string
): ts.LanguageServiceHost => {
  const scriptSnapshots = new Map<string, ts.IScriptSnapshot | null>()

  return {
    getProjectVersion: () => '0',
    getScriptVersion: () => '0',
    getCurrentDirectory: () => currentDirectory,
    getCompilationSettings: () => config.options,
    getProjectReferences: () => config.projectReferences,
    getScriptFileNames: () => config.fileNames,
    directoryExists: ts.sys.directoryExists.bind(ts.sys),
    fileExists: ts.sys.fileExists.bind(ts.sys),
    getDefaultLibFileName: ts.getDefaultLibFilePath.bind(ts),
    getDirectories: ts.sys.getDirectories.bind(ts.sys),
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    readFile: ts.sys.readFile.bind(ts.sys),
    getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
      let snapshot = scriptSnapshots.get(fileName)
      if (snapshot === undefined) {
        snapshot = ts.sys.fileExists(fileName)
          ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '')
          : null
        scriptSnapshots.set(fileName, snapshot)
      }

      return snapshot || undefined
    },
  }
}
