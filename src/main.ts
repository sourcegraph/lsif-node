import { execSync } from 'child_process'
import minimist from 'minimist'
import * as path from 'path'
import ts from 'typescript-lsif'
import {
    getDefaultCompilerOptions,
    inferTypings,
    makeAbsolute,
    normalizePath,
    Program,
} from './debt'
import { Emitter } from './emitter'
import { Indexer, version } from './indexer'
import { readPackageJson } from './package'

interface Options {
    help: boolean
    version: boolean
    out: string
    repositoryRoot: string
    inferTypings: boolean
}

const defaults: Options = {
    help: false,
    version: false,
    out: 'dump.lsif',
    repositoryRoot: '',
    inferTypings: false,
}

const minOpts: minimist.Opts = {
    string: ['out', 'repositoryRoot'],
    boolean: ['help', 'version', 'inferTypings'],
    default: { ...defaults },
    alias: { help: ['h'], version: ['v'], out: ['o'] },
}

const helpText = `
usage: lsif-tsc [options] [tsc options]

lsif-tsc is an LSIF indexer for TypeScript.

Options:
  -h, --help            Show help.
  -v, --version         Show application version.
  -o, --out             The output file.
      --repositoryRoot  Specifies the path of the current repository (inferred automatically via git).
      --inferTypings    Infer typings for JavaScript npm modules.
`

export async function main(): Promise<void> {
    return run(ts.sys.args)
}

async function run(args: string[]): Promise<void> {
    const {
        help: showHelp,
        version: showVersion,
        out,
        repositoryRoot: rawRepositoryRoot,
        inferTypings: shouldInferTypings,
    } = {
        ...defaults,
        ...minimist(args, minOpts),
    }

    if (showHelp) {
        console.log(helpText)
        return
    }
    if (showVersion) {
        console.log(version)
        return
    }

    const repositoryRoot = makeAbsolute(
        rawRepositoryRoot ||
            execSync('git rev-parse --show-toplevel').toString().trim()
    )

    await processProject(args, shouldInferTypings, repositoryRoot, out)
}

class LanguageServiceHost implements ts.LanguageServiceHost {
    private scriptSnapshots = new Map<string, ts.IScriptSnapshot | null>()

    constructor(
        private config: ts.ParsedCommandLine,
        private currentDirectory: string
    ) {}

    public getProjectVersion = () => '0'
    public getScriptVersion = () => '0'
    public getCurrentDirectory = () => this.currentDirectory
    public getCompilationSettings = () => this.config.options
    public getProjectReferences = () => this.config.projectReferences
    public getScriptFileNames = () => this.config.fileNames
    public directoryExists = ts.sys.directoryExists.bind(ts.sys)
    public fileExists = ts.sys.fileExists.bind(ts.sys)
    public getDefaultLibFileName = ts.getDefaultLibFilePath.bind(ts)
    public getDirectories = ts.sys.getDirectories.bind(ts.sys)
    public readDirectory = ts.sys.readDirectory.bind(ts.sys)
    public readFile = ts.sys.readFile.bind(ts.sys)

    public getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
        const cachedSnapshot = this.scriptSnapshots.get(fileName)
        if (cachedSnapshot !== undefined) {
            return cachedSnapshot || undefined
        }

        const snapshot = ts.sys.fileExists(fileName)
            ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '')
            : null
        this.scriptSnapshots.set(fileName, snapshot)
        return snapshot || undefined
    }
}

async function processProject(
    args: string[],
    shouldInferTypings: boolean,
    repositoryRoot: string,
    out: string
): Promise<any> {
    const packageFile = makeAbsolute('package.json')
    const projectRoot = makeAbsolute(path.posix.dirname(packageFile))
    const packageJson = readPackageJson(packageFile)

    let tsconfigFileName: string | undefined
    let config = ts.parseCommandLine(args)
    if (config.options.project) {
        //
        // TODO - refactor
        //

        const projectPath = path.resolve(config.options.project)
        tsconfigFileName = ts.sys.directoryExists(projectPath)
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
            newConfig.compilerOptions = getDefaultCompilerOptions(
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
        config = result
    }

    if (config.fileNames.length === 0) {
        // TODO - ok if references as well
        throw new Error(`No input files specified.`)
    }

    const currentDirectory = tsconfigFileName
        ? path.dirname(tsconfigFileName)
        : process.cwd()

    if (shouldInferTypings) {
        await inferTypings(
            config,
            projectRoot,
            tsconfigFileName,
            currentDirectory
        )
    }

    const host = new LanguageServiceHost(config, currentDirectory)
    const languageService = ts.createLanguageService(host)
    const program = languageService.getProgram()
    if (!program) {
        throw new Error(
            "Couldn't create language service with underlying program."
        )
    }
    const typeChecker = program.getTypeChecker()
    const compilerOptions = program.getCompilerOptions()

    const rootDir =
        (compilerOptions.rootDir &&
            makeAbsolute(compilerOptions.rootDir, currentDirectory)) ||
        (compilerOptions.baseUrl &&
            makeAbsolute(compilerOptions.baseUrl, currentDirectory)) ||
        normalizePath(Program.getCommonSourceDirectory(program))

    const outDir =
        (compilerOptions.outDir &&
            makeAbsolute(compilerOptions.outDir, currentDirectory)) ||
        rootDir

    const emitter = new Emitter(out, projectRoot, packageJson)

    // TODO - project references
    // const dependsOn: ProjectInfo[] = [];
    // const references = options.noProjectReferences ? undefined : programContext.program.getResolvedProjectReferences();
    // if (references) {
    // 	for (const reference of references) {
    // 		if (reference) {
    // 			const result = await processProject(reference.commandLine, emitter, typingsInstaller, dataManager, importMonikers, exportMonikers, options);
    // 			if (typeof result === 'number') {
    // 				return result;
    // 			}
    // 			dependsOn.push(result);
    // 		}
    // 	}
    // }

    // TODO - share indexer
    // TODO - need to reload after fetching dependent projects for some reason?

    const indexer = new Indexer(
        emitter,
        languageService,
        program,
        typeChecker,
        projectRoot,
        rootDir,
        outDir,
        repositoryRoot
    )
    indexer.index() // TODO - return type?
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
