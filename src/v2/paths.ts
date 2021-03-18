import ts from 'typescript-lsif'
import * as tss from '../typescripts'
import { execSync } from 'child_process'

export interface PathContext {
  projectRoot: string
  rootDir: string
  outDir: string
  repositoryRoot: string
}

export const makePathContext = (
  program: ts.Program,
  projectRoot: string,
  currentDirectory: string,
  repositoryRoot?: string
): PathContext => {
  const compilerOptions = program.getCompilerOptions()

  const rootDir =
    (compilerOptions.rootDir &&
      tss.makeAbsolute(compilerOptions.rootDir, currentDirectory)) ||
    (compilerOptions.baseUrl &&
      tss.makeAbsolute(compilerOptions.baseUrl, currentDirectory)) ||
    tss.normalizePath(tss.Program.getCommonSourceDirectory(program))

  const outDir =
    (compilerOptions.outDir &&
      tss.makeAbsolute(compilerOptions.outDir, currentDirectory)) ||
    rootDir

  return {
    projectRoot,
    rootDir,
    outDir,
    repositoryRoot:
      repositoryRoot ||
      tss.makeAbsolute(
        execSync('git rev-parse --show-toplevel').toString().trim()
      ),
  }
}
