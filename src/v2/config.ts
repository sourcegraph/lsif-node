import * as path from 'path'
import ts from 'typescript-lsif'
import PackageJson from '../package'
import * as tss from '../typescripts'

export const loadPackageJson = (): {
    packageJson?: PackageJson
    projectRoot: string
} => {
    const packageFile = tss.makeAbsolute('package.json')

    return {
        packageJson: PackageJson.read(packageFile),
        projectRoot: tss.makeAbsolute(path.posix.dirname(packageFile)),
    }
}

export const loadProjectConfiguration = (
    config: ts.ParsedCommandLine
): { config: ts.ParsedCommandLine; tsconfigFileName?: string } => {
    if (!config.options.project) {
        return { config }
    }

    const projectPath = path.resolve(config.options.project)
    const tsconfigFileName = ts.sys.directoryExists(projectPath)
        ? path.join(projectPath, 'tsconfig.json')
        : projectPath

    if (!ts.sys.fileExists(tsconfigFileName)) {
        throw new Error(
            `Project configuration file ${tsconfigFileName} does not exist`
        )
    }

    const absolute = path.resolve(tsconfigFileName)
    const { config: newConfig, error } = ts.readConfigFile(
        absolute,
        ts.sys.readFile.bind(ts.sys)
    )
    if (error) {
        throw new Error(
            ts.formatDiagnostics([error], ts.createCompilerHost({}))
        )
    }
    if (!newConfig.compilerOptions) {
        newConfig.compilerOptions = tss.getDefaultCompilerOptions(
            tsconfigFileName
        )
    }
    const result = ts.parseJsonConfigFileContent(
        newConfig,
        ts.sys,
        path.dirname(absolute)
    )
    if (result.errors.length > 0) {
        throw new Error(
            ts.formatDiagnostics(result.errors, ts.createCompilerHost({}))
        )
    }

    return { config: result, tsconfigFileName }
}
