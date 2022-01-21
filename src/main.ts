import * as path from 'path'
import * as ts from 'typescript'
import * as yargs from 'yargs'
import * as lsif from './lsif'
import * as fs from 'fs'

const lsif_typed = lsif.lib.codeintel.lsif_typed

interface DocEntry {
  name?: string
  fileName?: string
  documentation?: string
  type?: string
  constructors?: DocEntry[]
  parameters?: DocEntry[]
  returnType?: string
}

interface Options {
  project: string
  writeIndex: (index: lsif.lib.codeintel.lsif_typed.Index) => void
}

export function main(): void {
  yargs
    .scriptName('lsif-node')
    .usage('$0 <cmd> [args]')
    .command(
      'index [project]',
      'LSIF index a project',
      (yargs) => {
        yargs.positional('project', {
          type: 'string',
          default: '.',
          describe: 'the directory to index',
        })
      },
      (argv) => {
        index({
          project: argv.project as string,
          writeIndex: (index): void => {
            console.log(index)
          },
        })
      }
    )
    .help().argv
}

export function indexToOutputFile(project: string, output: string): void {
  throw new Error('NOT IMPLEMENTED YET')
}

export function index(options: Options): void {
  console.log({ options })
  // console.log("\n==========");
  // console.log({ project: argv.project, args: ts.sys.args });
  let config = ts.parseCommandLine(
    ['-p', options.project],
    (relativePath: string) => {
      console.log({ relativePath })
      return path.resolve(options.project, relativePath)
    }
  )
  let tsconfigFileName: string | undefined
  if (config.options.project) {
    const projectPath = path.resolve(config.options.project)
    if (ts.sys.directoryExists(projectPath)) {
      tsconfigFileName = path.join(projectPath, 'tsconfig.json')
    } else {
      tsconfigFileName = projectPath
    }
    if (!ts.sys.fileExists(tsconfigFileName)) {
      console.error(`no such file: ${tsconfigFileName}`)
      process.exitCode = 1
      return undefined
    }
    config = loadConfigFile(tsconfigFileName)
  }

  // console.log({ tsconfigFileName });

  if (config.fileNames.length === 0) {
    console.error(`no input files`)
    process.exitCode = 1
    return undefined
  }

  new Indexer(config, options).index()
}

if (require.main === module) {
  main()
}

export class Input {
  public lines: string[]
  constructor(public readonly path: string, public readonly text: string) {
    this.lines = text.split('\n')
  }

  public static fromFile(path: string): Input {
    return new Input(path, fs.readFileSync(path).toString())
  }
  public format(range: Range, diagnostic?: string): string {
    const line = this.lines[range.start.line]
    const indent = ' '.repeat(range.start.character)
    const length = range.isSingleLine()
      ? range.end.character - range.start.character
      : line.length - range.start.character
    const carets = length < 0 ? '<negative length>' : '^'.repeat(length)
    const multilineSuffix = !range.isSingleLine()
      ? ` ${range.end.line}:${range.end.character}`
      : ''
    const message = diagnostic ? ' ' + diagnostic : ''
    return `${this.path}:${range.start.line}:${range.start.character}${message}\n${line}\n${indent}${carets}${multilineSuffix}`
  }
  public log(range: Range): void {
    console.log(this.format(range))
  }
}

function compare(a: number, b: number): number {
  return a - b
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
  public compare(other: Position): number {
    if (this.line != other.line) {
      return compare(this.line, other.line)
    }
    return compare(this.character, other.character)
  }
}
export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
  public compare(other: Range): number {
    const byStart = this.start.compare(other.start)
    if (byStart != 0) return byStart
    return this.end.compare(other.end)
  }
  public toLsif(): number[] {
    if (this.isSingleLine())
      return [this.start.line, this.start.character, this.end.character]
    return [
      this.start.line,
      this.start.character,
      this.end.line,
      this.end.character,
    ]
  }
  public static fromLsif(range: number[]): Range {
    const endLine = range.length === 3 ? range[0] : range[2]
    const endCharacter = range.length === 3 ? range[2] : range[3]
    return new Range(
      new Position(range[0], range[1]),
      new Position(endLine, endCharacter)
    )
  }
  static fromNode(node: ts.Node): Range {
    const sourceFile = node.getSourceFile()
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
    return new Range(
      new Position(start.line, start.character),
      new Position(end.line, end.character)
    )
  }
  public isSingleLine(): boolean {
    return this.start.line === this.end.line
  }
}

class Indexer {
  options: Options
  program: ts.Program
  checker: ts.TypeChecker
  output: DocEntry[] = []
  symbolsCache: Map<ts.Node, string> = new Map()
  constructor(public readonly config: ts.ParsedCommandLine, options: Options) {
    this.options = options
    this.program = ts.createProgram(config.fileNames, config.options)
    this.checker = this.program.getTypeChecker()
  }
  public index() {
    this.options.writeIndex(
      new lsif_typed.Index({
        metadata: new lsif_typed.Metadata({
          project_root: this.options.project,
        }),
      })
    )
    // Visit every sourceFile in the program
    for (const sourceFile of this.program.getSourceFiles()) {
      const includes = this.config.fileNames.includes(sourceFile.fileName)
      if (includes) {
        const doc = new lsif.lib.codeintel.lsif_typed.Document({
          relative_path: path.relative(
            this.options.project,
            sourceFile.fileName
          ),
          occurrences: [],
        })
        const input = new Input(sourceFile.fileName, sourceFile.getText())
        const visitor = new Visitor(this.checker, input, doc, this.symbolsCache)
        // console.log({ fileName: sourceFile.fileName });
        visitor.visit(sourceFile)
        if (visitor.doc.occurrences.length > 0) {
          this.options.writeIndex(
            new lsif.lib.codeintel.lsif_typed.Index({
              documents: [visitor.doc],
            })
          )
        }
      }
    }
  }
}

class Visitor {
  private localCounter = 0
  constructor(
    public readonly checker: ts.TypeChecker,
    public readonly input: Input,
    public readonly doc: lsif.lib.codeintel.lsif_typed.Document,
    public readonly symbolsCache: Map<ts.Node, string>
  ) {}
  public visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const range = Range.fromNode(node)
      // this.input.log(range);
      const sym = this.checker.getSymbolAtLocation(node)
      for (const declaration of sym?.declarations || []) {
        const lsifSymbol = this.lsifSymbol(declaration)
        this.doc.occurrences.push(
          new lsif.lib.codeintel.lsif_typed.Occurrence({
            range: range.toLsif(),
            symbol: lsifSymbol,
          })
        )
      }
    }
    ts.forEachChild(node, (node) => this.visit(node))
  }

  private lsifSymbol(declaration: ts.Node): string {
    if (declaration === null || declaration === undefined) {
      return ''
    }
    const fromCache = this.symbolsCache.get(declaration)
    if (fromCache) {
      return fromCache
    }
    const parent = this.lsifSymbol(declaration.parent)
    if (this.isLocalLsifSymbol(parent)) {
      const symbol = `local ${this.localCounter}`
      this.localCounter++
      this.symbolsCache.set(declaration, symbol)
      return symbol
    }

    if (ts.isInterfaceDeclaration(declaration)) {
      declaration.name
    }
    return ''
  }

  private isLocalLsifSymbol(symbol: string): boolean {
    return symbol === '' || symbol.startsWith('local ')
  }
}
function loadConfigFile(file: string): ts.ParsedCommandLine {
  let absolute = path.resolve(file)

  let readResult = ts.readConfigFile(absolute, ts.sys.readFile)
  if (readResult.error) {
    throw new Error(
      ts.formatDiagnostics([readResult.error], ts.createCompilerHost({}))
    )
  }
  let config = readResult.config
  if (config.compilerOptions !== undefined) {
    config.compilerOptions = Object.assign(
      config.compilerOptions,
      getDefaultCompilerOptions(file)
    )
  }
  let result = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(absolute)
  )
  if (result.errors.length > 0) {
    throw new Error(
      ts.formatDiagnostics(result.errors, ts.createCompilerHost({}))
    )
  }
  return result
}

function getDefaultCompilerOptions(configFileName?: string) {
  const options: ts.CompilerOptions =
    configFileName && path.basename(configFileName) === 'jsconfig.json'
      ? {
          allowJs: true,
          maxNodeModuleJsDepth: 2,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          noEmit: true,
        }
      : {}
  return options
}
