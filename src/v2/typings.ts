import ts from 'typescript-lsif'
import { TypingsInstaller } from '../typings'

// TODO - yuck
export const inferTypings = async (
  config: ts.ParsedCommandLine,
  projectRoot: string,
  tsconfigFileName: string | undefined,
  currentDirectory: string
): Promise<void> => {
  const typingsInstaller = new TypingsInstaller()

  // TODO - make parameters match for better interface
  await (config.options.types
    ? typingsInstaller.installTypings(
        projectRoot,
        tsconfigFileName || process.cwd(),
        config.options.types
      )
    : typingsInstaller.guessTypings(projectRoot, currentDirectory))
}
