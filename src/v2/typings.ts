import ts from 'typescript-lsif'
import { TypingsInstaller } from '../typings'
;``
export const inferTypings = async (
  config: ts.ParsedCommandLine,
  projectRoot: string,
  tsconfigFileName: string | undefined,
  currentDirectory: string
): Promise<void> => {
  const typingsInstaller = new TypingsInstaller()

  // TODO - make calls uniform
  await (config.options.types
    ? typingsInstaller.installTypings(
        projectRoot,
        tsconfigFileName || process.cwd(),
        config.options.types
      )
    : typingsInstaller.guessTypings(projectRoot, currentDirectory))
}
