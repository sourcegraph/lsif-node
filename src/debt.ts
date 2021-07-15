import * as crypto from 'crypto'
import * as _fs from 'fs'
import LRUCache from 'lru-cache'
import { commands, load } from 'npm'
import * as path from 'path'
import ts from 'typescript-lsif'
import { promisify } from 'util'

export function string(value: any): value is string {
    return typeof value === 'string' || value instanceof String
}

type Disposable = () => void

enum LocationKind {
    tsLibrary = 1,
    module = 2,
    global = 3,
}

interface SymbolAlias {
    /**
     * The alias symbol. For example the symbol representing `default` in
     * a statement like `export default product` or the symbol representing
     * `MyTypeName` in a type declarartion statement like `type MyTypeName = { x: number }`
     */
    alias: ts.Symbol
    name: string
}

//
// TODO - extract
//

export class Symbols {
    private baseSymbolCache: LRUCache<string, ts.Symbol[]>
    private baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>
    private exportedPaths: LRUCache<ts.Symbol, string | null>
    private symbolAliases: Map<string, SymbolAlias>
    private parents: Map<string, ts.Symbol>
    private exports: Map<string, Set<string>>
    private sourceFilesContainingAmbientDeclarations: Set<string>

    constructor(
        private program: ts.Program,
        private typeChecker: ts.TypeChecker
    ) {
        this.baseSymbolCache = new LRUCache(2048)
        this.baseMemberCache = new LRUCache(2048)
        this.exportedPaths = new LRUCache(2048)
        this.symbolAliases = new Map()
        this.parents = new Map()
        this.exports = new Map()
        this.sourceFilesContainingAmbientDeclarations = new Set()

        const ambientModules = this.typeChecker.getAmbientModules()
        for (let module of ambientModules) {
            const declarations = module.getDeclarations()
            if (declarations !== undefined) {
                for (let declarartion of declarations) {
                    const sourceFile = declarartion.getSourceFile()
                    this.sourceFilesContainingAmbientDeclarations.add(
                        sourceFile.fileName
                    )
                }
            }
        }
    }

    public storeSymbolAlias(symbol: ts.Symbol, typeAlias: SymbolAlias): void {
        const key = createSymbolKey(this.typeChecker, symbol)
        this.symbolAliases.set(key, typeAlias)
    }

    public hasSymbolAlias(symbol: ts.Symbol): boolean {
        const key = createSymbolKey(this.typeChecker, symbol)
        return this.symbolAliases.has(key)
    }

    public deleteSymbolAlias(symbol: ts.Symbol): void {
        const key = createSymbolKey(this.typeChecker, symbol)
        this.symbolAliases.delete(key)
    }

    public addParent(symbol: ts.Symbol, parent: ts.Symbol): Disposable {
        const key = createSymbolKey(this.typeChecker, symbol)
        this.parents.set(key, parent)
        return () => {
            this.parents.delete(key)
        }
    }

    private getParent(symbol: ts.Symbol): ts.Symbol | undefined {
        let result = getSymbolParent(symbol)
        if (result !== undefined) {
            return result
        }
        return this.parents.get(createSymbolKey(this.typeChecker, symbol))
    }

    public addExport(parent: ts.Symbol, symbol: ts.Symbol): Disposable {
        const parentKey = createSymbolKey(this.typeChecker, parent)
        const symbolKey = createSymbolKey(this.typeChecker, symbol)
        let values = this.exports.get(parentKey)
        if (values === undefined) {
            values = new Set()
            this.exports.set(parentKey, values)
        }
        values.add(symbolKey)
        return () => {
            let values = this.exports.get(parentKey)
            if (values === undefined) {
                return
            }
            values.delete(symbolKey)
            if (values.size === 0) {
                this.exports.delete(parentKey)
            }
        }
    }

    private isExported(parent: ts.Symbol, symbol: ts.Symbol): boolean {
        if (
            parent.exports !== undefined &&
            parent.exports.has(symbol.getName() as ts.__String)
        ) {
            return true
        }
        let exports = this.exports.get(
            createSymbolKey(this.typeChecker, parent)
        )
        return (
            exports !== undefined &&
            exports.has(createSymbolKey(this.typeChecker, symbol))
        )
    }

    public getBaseSymbols(symbol: ts.Symbol): ts.Symbol[] | undefined {
        const key = createSymbolKey(this.typeChecker, symbol)
        let result = this.baseSymbolCache.get(key)
        if (result === undefined) {
            if (isTypeLiteral(symbol)) {
                // ToDo@dirk: compute base symbols for type literals.
                return undefined
            } else if (isInterface(symbol)) {
                result = this.computeBaseSymbolsForInterface(symbol)
            } else if (isClass(symbol)) {
                result = this.computeBaseSymbolsForClass(symbol)
            }
            if (result !== undefined) {
                this.baseSymbolCache.set(key, result)
            }
        }
        return result
    }

    private computeBaseSymbolsForClass(
        symbol: ts.Symbol
    ): ts.Symbol[] | undefined {
        let result: ts.Symbol[] = []
        let declarations = symbol.getDeclarations()
        if (declarations === undefined) {
            return undefined
        }
        let typeChecker = this.typeChecker
        for (let declaration of declarations) {
            if (ts.isClassDeclaration(declaration)) {
                let heritageClauses = declaration.heritageClauses
                if (heritageClauses) {
                    for (let heritageClause of heritageClauses) {
                        for (let type of heritageClause.types) {
                            let tsType = typeChecker.getTypeAtLocation(
                                type.expression
                            )
                            if (tsType !== undefined) {
                                let baseSymbol = tsType.getSymbol()
                                if (
                                    baseSymbol !== undefined &&
                                    baseSymbol !== symbol
                                ) {
                                    result.push(baseSymbol)
                                }
                            }
                        }
                    }
                }
            }
        }
        return result.length === 0 ? undefined : result
    }

    private computeBaseSymbolsForInterface(
        symbol: ts.Symbol
    ): ts.Symbol[] | undefined {
        let result: ts.Symbol[] = []
        let tsType = this.typeChecker.getDeclaredTypeOfSymbol(symbol)
        if (tsType === undefined) {
            return undefined
        }
        let baseTypes = tsType.getBaseTypes()
        if (baseTypes !== undefined) {
            for (let base of baseTypes) {
                let symbol = base.getSymbol()
                if (symbol) {
                    result.push(symbol)
                }
            }
        }
        return result.length === 0 ? undefined : result
    }

    public findBaseMembers(
        symbol: ts.Symbol,
        memberName: string
    ): ts.Symbol[] | undefined {
        let key = createSymbolKey(this.typeChecker, symbol)
        let cache = this.baseMemberCache.get(key)
        if (cache === undefined) {
            cache = new LRUCache(64)
            this.baseMemberCache.set(key, cache)
        }
        let result: ts.Symbol[] | undefined = cache.get(memberName)
        if (result === undefined) {
            let baseSymbols = this.getBaseSymbols(symbol)
            if (baseSymbols !== undefined) {
                for (let base of baseSymbols) {
                    if (!base.members) {
                        continue
                    }
                    let method = base.members.get(memberName as ts.__String)
                    if (method !== undefined) {
                        if (result === undefined) {
                            result = [method]
                        } else {
                            result.push(method)
                        }
                    } else {
                        let baseResult = this.findBaseMembers(base, memberName)
                        if (baseResult !== undefined) {
                            if (result === undefined) {
                                result = baseResult
                            } else {
                                result.push(...baseResult)
                            }
                        }
                    }
                }
            }
            if (result !== undefined) {
                cache.set(memberName, result)
            } else {
                cache.set(memberName, [])
            }
        } else if (result.length === 0) {
            return undefined
        }
        return result
    }

    public getExportPath(
        symbol: ts.Symbol,
        kind: LocationKind | undefined
    ): string | undefined {
        let result = this.exportedPaths.get(symbol)
        if (result !== undefined) {
            return result === null ? undefined : result
        }
        if (isSourceFile(symbol)) {
            this.exportedPaths.set(symbol, '')
            return ''
        }
        let parent = this.getParent(symbol)
        if (parent === undefined) {
            if (
                isValueModule(symbol) ||
                kind === LocationKind.tsLibrary ||
                kind === LocationKind.global
            ) {
                this.exportedPaths.set(symbol, symbol.getName())
                return symbol.getName()
            }
            const typeAlias = this.symbolAliases.get(
                createSymbolKey(this.typeChecker, symbol)
            )
            if (
                typeAlias !== undefined &&
                this.getExportPath(typeAlias.alias, kind) !== undefined
            ) {
                this.exportedPaths.set(symbol, typeAlias.name)
                return typeAlias.name
            }
            this.exportedPaths.set(symbol, null)
            return undefined
        } else {
            let parentValue = this.getExportPath(parent, kind)
            // The parent is not exported so any member isn't either
            if (parentValue === undefined) {
                this.exportedPaths.set(symbol, null)
                return undefined
            } else {
                if (
                    isInterface(parent) ||
                    isClass(parent) ||
                    isTypeLiteral(parent)
                ) {
                    result = `${parentValue}.${symbol.getName()}`
                    this.exportedPaths.set(symbol, result)
                    return result
                } else if (this.isExported(parent, symbol)) {
                    result =
                        parentValue.length > 0
                            ? `${parentValue}.${symbol.getName()}`
                            : symbol.getName()
                    this.exportedPaths.set(symbol, result)
                    return result
                } else {
                    this.exportedPaths.set(symbol, null)
                    return undefined
                }
            }
        }
    }

    public getLocationKind(
        sourceFiles: ts.SourceFile[]
    ): LocationKind | undefined {
        if (sourceFiles.length === 0) {
            return undefined
        }
        let tsLibraryCount: number = 0
        let moduleCount: number = 0
        let externalLibraryCount: number = 0
        let declarationFileCount: number = 0
        for (let sourceFile of sourceFiles) {
            if (
                this.typeChecker.getSymbolAtLocation(sourceFile) !== undefined
            ) {
                moduleCount++
                continue
            }
            if (Program.isSourceFileDefaultLibrary(this.program, sourceFile)) {
                tsLibraryCount++
                continue
            }
            if (
                Program.isSourceFileFromExternalLibrary(
                    this.program,
                    sourceFile
                )
            ) {
                externalLibraryCount++
                continue
            }
            if (
                sourceFile.isDeclarationFile &&
                !this.sourceFilesContainingAmbientDeclarations.has(
                    sourceFile.fileName
                )
            ) {
                declarationFileCount++
                continue
            }
        }
        const numberOfFiles = sourceFiles.length
        if (moduleCount === numberOfFiles) {
            return LocationKind.module
        }
        if (tsLibraryCount === numberOfFiles) {
            return LocationKind.tsLibrary
        }
        if (
            (externalLibraryCount === numberOfFiles ||
                declarationFileCount === numberOfFiles) &&
            moduleCount === 0
        ) {
            return LocationKind.global
        }
        return undefined
    }
}

namespace fs {
    export const exist = promisify(_fs.exists)
    export const readFile = promisify(_fs.readFile)
    export const stat = promisify(_fs.stat)
    export const Stats = _fs.Stats
}

interface Dictionary<T> {
    [key: string]: T
}

type CommandCallback = (
    err?: Error,
    result?: any,
    result2?: any,
    result3?: any,
    result4?: any
) => void

interface ViewSignature {
    (args: string[], callback: CommandCallback): void
    (args: string[], silent: boolean, callback: CommandCallback): void
}

interface PackageJson {
    devDependencies: Dictionary<string>
    dependencies: Dictionary<string>
}

function stripComments(content: string): string {
    const regexp = /("(?:[^\\"]*(?:\\.)?)*")|('(?:[^\\']*(?:\\.)?)*')|(\/\*(?:\r?\n|.)*?\*\/)|(\/{2,}.*?(?:(?:\r?\n)|$))/g

    return content.replace(regexp, function (match, m1, m2, m3, m4) {
        // Only one of m1, m2, m3, m4 matches
        if (m3) {
            // A block comment. Replace with nothing
            return ''
        } else if (m4) {
            // A line comment. If it ends in \r?\n then keep it.
            const length_1 = m4.length
            if (length_1 > 2 && m4[length_1 - 1] === '\n') {
                return m4[length_1 - 2] === '\r' ? '\r\n' : '\n'
            } else {
                return ''
            }
        } else {
            // We match a string
            return match
        }
    })
}

class TypingsInstaller {
    private handledPackages: Set<string>
    private handledTsConfig: Set<string>

    constructor() {
        this.handledPackages = new Set()
        this.handledTsConfig = new Set()
    }

    private static ensureSeparator(directory: string): string {
        return directory[directory.length - 1] !== path.sep
            ? `${directory}${path.sep}`
            : directory
    }

    public async installTypings(
        projectRoot: string,
        start: string,
        typings: string[]
    ): Promise<void> {
        if (typings.length === 0) {
            return
        }
        let stat = await fs.stat(start)
        let startDirectory: string
        let key: string

        if (stat.isDirectory()) {
            startDirectory = start
            // this has a very very rare possibility of a clash
            key = path.join(start, typings.join(':'))
        } else if (stat.isFile()) {
            startDirectory = path.dirname(start)
            key = start
        } else {
            return
        }

        if (this.handledTsConfig.has(key)) {
            return
        }
        if (startDirectory.length < projectRoot.length) {
            return
        }
        projectRoot = path.normalize(projectRoot)

        typings = typings.map((typing) =>
            typing.startsWith('@types/') ? typing : `@types/${typing}`
        )

        while (startDirectory.length >= projectRoot.length) {
            let packageFile = path.join(startDirectory, 'package.json')
            if (await fs.exist(packageFile)) {
                typings = await this.filterTypingsToInstall(
                    packageFile,
                    typings
                )
                if (typings.length === 0) {
                    return
                }
                await this.loadNpm(packageFile)
                await this.doInstallTypingsFromNpm(
                    await this.validateTypingsOnNpm(typings)
                )
                this.handledTsConfig.add(key)
                return
            }
            startDirectory = path.dirname(startDirectory)
        }
    }

    public async guessTypings(
        projectRoot: string,
        startDirectory: string
    ): Promise<void> {
        if (startDirectory.length < projectRoot.length) {
            return
        }
        projectRoot = path.normalize(projectRoot)
        startDirectory = path.normalize(startDirectory)

        if (
            !TypingsInstaller.ensureSeparator(startDirectory).startsWith(
                TypingsInstaller.ensureSeparator(projectRoot)
            )
        ) {
            return
        }

        while (startDirectory.length >= projectRoot.length) {
            let packageFile = path.join(startDirectory, 'package.json')
            if (this.handledPackages.has(packageFile)) {
                return
            }
            if (await fs.exist(packageFile)) {
                let typings = await this.findTypingsToInstall(packageFile)
                if (typings.length === 0) {
                    continue
                }
                await this.loadNpm(packageFile)
                await this.doInstallTypingsFromNpm(
                    await this.validateTypingsOnNpm(typings)
                )
                this.handledPackages.add(packageFile)
            }
            startDirectory = path.dirname(startDirectory)
        }
    }

    private async findTypingsToInstall(packageFile: string): Promise<string[]> {
        const typings: Set<string> = new Set()
        const toInstall: string[] = []
        const packageJson: PackageJson = JSON.parse(
            stripComments(await fs.readFile(packageFile, 'utf8'))
        )

        if (packageJson.devDependencies) {
            for (let pack of Object.keys(packageJson.devDependencies)) {
                if (pack.startsWith('@types/')) {
                    typings.add(pack)
                }
            }
        }
        if (packageJson.dependencies !== undefined) {
            for (let pack of Object.keys(packageJson.dependencies)) {
                if (pack.startsWith('@types/')) {
                    typings.add(pack)
                }
            }
            for (let pack of Object.keys(packageJson.dependencies)) {
                if (pack.startsWith('@types/')) {
                    continue
                }
                const typing = `@types/${pack}`
                if (!typings.has(typing)) {
                    toInstall.push(typing)
                }
            }
        }

        if (toInstall.length === 0) {
            return []
        }
        return toInstall
    }

    private async filterTypingsToInstall(
        packageFile: string,
        toInstall: string[]
    ): Promise<string[]> {
        const typings: Set<string> = new Set()
        const packageJson: PackageJson = JSON.parse(
            stripComments(await fs.readFile(packageFile, 'utf8'))
        )

        if (packageJson.devDependencies) {
            for (let pack of Object.keys(packageJson.devDependencies)) {
                if (pack.startsWith('@types/')) {
                    typings.add(pack)
                }
            }
        }
        if (packageJson.dependencies !== undefined) {
            for (let pack of Object.keys(packageJson.dependencies)) {
                if (pack.startsWith('@types/')) {
                    typings.add(pack)
                }
            }
        }
        let result: string[] = []
        for (let typing of toInstall) {
            if (!typings.has(typing)) {
                result.push(typing)
            }
        }
        return result
    }

    private async loadNpm(packageFile: string): Promise<void> {
        const prefix = path.dirname(packageFile)
        // let npm = await import('npm');
        await new Promise((resolve, reject) => {
            /* npm. */ load(
                { json: true, save: false, 'save-dev': false, prefix: prefix },
                (error, config) => {
                    if (error) {
                        reject(error)
                    } else {
                        resolve(config)
                    }
                }
            )
        })
    }

    private async validateTypingsOnNpm(typings: string[]): Promise<string[]> {
        if (typings.length === 0) {
            return typings
        }
        const promises: Promise<string | undefined>[] = []
        // let npm = await import('npm');
        for (let typing of typings) {
            try {
                promises.push(
                    new Promise<string | undefined>((resolve, reject) => {
                        /* npm. */ ;(commands.view as ViewSignature)(
                            [typing],
                            true,
                            (
                                error: Error | undefined | null,
                                result: object
                            ) => {
                                if (error) {
                                    resolve(undefined)
                                }
                                resolve(typing)
                            }
                        )
                    })
                )
            } catch (error) {
                // typing doesn't exist. Ignore the error
            }
        }
        const all = await Promise.all(promises)
        const result: string[] = []
        for (let elem of all) {
            if (elem !== undefined) {
                result.push(elem)
            }
        }
        return result
    }

    private async doInstallTypingsFromNpm(typings: string[]): Promise<void> {
        if (typings.length === 0) {
            return
        }
        // let npm = await import('npm');
        return new Promise((resolve, reject) => {
            /* npm. */ commands.install(typings, (error, result) => {
                if (error) {
                    reject(error)
                }
                resolve(result)
            })
        })
    }
}

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

export function isNamedDeclaration(
    node: ts.Node
): node is ts.NamedDeclaration & { name: ts.DeclarationName } {
    const candidate = node as ts.NamedDeclaration
    return candidate !== undefined && candidate.name !== undefined
}

export function getDefaultCompilerOptions(configFileName?: string) {
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

const isWindows = process.platform === 'win32'
export function normalizePath(value: string): string {
    const result = path.posix.normalize(
        isWindows ? value.replace(/\\/g, '/') : value
    )
    return result.length > 0 && result.charAt(result.length - 1) === '/'
        ? result.substr(0, result.length - 1)
        : result
}

export function makeAbsolute(p: string, root?: string): string {
    if (path.isAbsolute(p)) {
        return normalizePath(p)
    }
    if (root === undefined) {
        return normalizePath(path.join(process.cwd(), p))
    }

    return normalizePath(path.join(root, p))
}

export function toOutLocation(
    path: string,
    rootDir: string,
    outDir: string
): string {
    if (!path.startsWith(rootDir)) {
        return path
    }
    return `${outDir}${path.substr(rootDir.length)}`
}

export function computeMonikerPath(from: string, to: string): string {
    const result = path.posix.relative(from, to)
    if (result.endsWith('.d.ts')) {
        return result.substring(0, result.length - 5)
    }
    if (result.endsWith('.ts') || result.endsWith('.js')) {
        return result.substring(0, result.length - 3)
    }

    return result
}

export function createMonikerIdentifier(
    path: string,
    symbol: string | undefined
): string
export function createMonikerIdentifier(
    path: string | undefined,
    symbol: string
): string
export function createMonikerIdentifier(
    path: string | undefined,
    symbol: string | undefined
): string {
    if (path === undefined) {
        if (symbol === undefined || symbol.length === 0) {
            throw new Error(`Either path or symbol must be provided.`)
        }
        return symbol
    }
    if (symbol === undefined || symbol.length === 0) {
        return `${path.replace(/\:/g, '::')}:`
    }
    return `${path.replace(/\:/g, '::')}:${symbol}`
}

export function parseIdentifier(
    path: string,
    symbol?: string
): { name: string; path?: string } {
    const identifier = createMonikerIdentifier(path, symbol)
    const index = identifier.lastIndexOf(':')
    if (index === -1) {
        return { name: identifier }
    }
    return {
        name: identifier.substring(index + 1),
        path: identifier.substr(0, index).replace(/::/g, ':'),
    }
}

export interface InternalSymbol extends ts.Symbol {
    parent?: ts.Symbol
    containingType?: ts.UnionOrIntersectionType
    __symbol__data__key__: string | undefined
}

export function getSymbolParent(symbol: ts.Symbol): ts.Symbol | undefined {
    return (symbol as InternalSymbol).parent
}

interface InternalNode extends ts.Node {
    symbol?: ts.Symbol
}

export function getSymbolFromNode(node: ts.Node): ts.Symbol | undefined {
    return (node as InternalNode).symbol
}

export interface InternalSourceFile extends ts.SourceFile {
    resolvedModules?: ts.Map<ts.ResolvedModuleFull | undefined>
}

const Unknown = 'unkown'
const Undefined = 'undefined'
const None = 'none'
export function createSymbolKey(
    typeChecker: ts.TypeChecker,
    symbol: ts.Symbol
): string {
    let result: string | undefined = (symbol as InternalSymbol)
        .__symbol__data__key__
    if (result !== undefined) {
        return result
    }
    const declarations = symbol.getDeclarations()
    if (declarations === undefined) {
        if (typeChecker.isUnknownSymbol(symbol)) {
            return Unknown
        }
        if (typeChecker.isUndefinedSymbol(symbol)) {
            return Undefined
        }

        return None
    }
    const fragments: { f: string; s: number; e: number }[] = []
    for (const declaration of declarations) {
        fragments.push({
            f: declaration.getSourceFile().fileName,
            s: declaration.getStart(),
            e: declaration.getEnd(),
        })
    }
    const hash = crypto.createHash('md5')
    hash.update(JSON.stringify(fragments, undefined, 0))
    result = hash.digest('base64')
    ;(symbol as InternalSymbol).__symbol__data__key__ = result
    return result
}

//
// TODO - simplify
//

export interface DefinitionInfo {
    file: string
    start: number
    end: number
}

export namespace DefinitionInfo {
    export function equals(a: DefinitionInfo, b: DefinitionInfo): boolean {
        return a.file === b.file && a.start === b.start && a.end === b.end
    }
}

export function createDefinitionInfo(
    sourceFile: ts.SourceFile,
    node: ts.Node
): DefinitionInfo {
    return {
        file: sourceFile.fileName,
        start: node.getStart(),
        end: node.getEnd(),
    }
}

export function isSourceFile(symbol: ts.Symbol): boolean {
    const declarations = symbol.getDeclarations()
    return (
        declarations !== undefined &&
        declarations.length === 1 &&
        ts.isSourceFile(declarations[0])
    )
}

function isClass(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Class) !== 0
    )
}

function isInterface(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined &&
        (symbol.getFlags() & ts.SymbolFlags.Interface) !== 0
    )
}

function isTypeLiteral(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined &&
        (symbol.getFlags() & ts.SymbolFlags.TypeLiteral) !== 0
    )
}

export function isMethodSymbol(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined &&
        (symbol.getFlags() & ts.SymbolFlags.Method) !== 0
    )
}

export function isAliasSymbol(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0
    )
}

export function isValueModule(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined &&
        (symbol.getFlags() & ts.SymbolFlags.ValueModule) !== 0
    )
}

export function isTransient(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined &&
        (symbol.getFlags() & ts.SymbolFlags.Transient) !== 0
    )
}

export function isTypeAlias(symbol?: ts.Symbol): boolean {
    return (
        symbol !== undefined &&
        (symbol.getFlags() & ts.SymbolFlags.TypeAlias) !== 0
    )
}

export function isComposite(
    typeChecker: ts.TypeChecker,
    symbol: ts.Symbol,
    location?: ts.Node
): boolean {
    const containingType = (symbol as InternalSymbol).containingType
    if (
        containingType !== undefined &&
        containingType.isUnionOrIntersection()
    ) {
        return true
    }

    if (location !== undefined) {
        const type = typeChecker.getTypeOfSymbolAtLocation(symbol, location)
        if (type.isUnionOrIntersection()) {
            return true
        }
    }

    return false
}

export function getCompositeSymbols(
    typeChecker: ts.TypeChecker,
    symbol: ts.Symbol,
    location?: ts.Node
): ts.Symbol[] | undefined {
    // We have something like x: { prop: number} | { prop: string };
    const containingType = (symbol as InternalSymbol).containingType
    if (containingType !== undefined) {
        const result: ts.Symbol[] = []
        for (const typeElem of containingType.types) {
            const symbolElem = typeElem.getProperty(symbol.getName())
            if (symbolElem !== undefined) {
                result.push(symbolElem)
            }
        }
        return result.length > 0 ? result : undefined
    }
    if (location !== undefined) {
        const type = typeChecker.getTypeOfSymbolAtLocation(symbol, location)
        // we have something like x: A | B;
        if (type.isUnionOrIntersection()) {
            const result: ts.Symbol[] = []
            for (const typeElem of type.types) {
                const symbolElem = typeElem.symbol
                // This happens for base types like undefined, number, ....
                if (symbolElem !== undefined) {
                    result.push(symbolElem)
                }
            }
            return result
        }
    }
    return undefined
}

export function getUniqueSourceFiles(
    declarations: ts.Declaration[] | undefined
): Set<ts.SourceFile> {
    const result: Set<ts.SourceFile> = new Set()
    if (declarations === undefined || declarations.length === 0) {
        return result
    }
    for (const declaration of declarations) {
        result.add(declaration.getSourceFile())
    }
    return result
}

export const EmitBoundaries: Set<number> = new Set<number>([
    ts.SyntaxKind.TypeParameter,
    ts.SyntaxKind.Parameter,
    ts.SyntaxKind.PropertyDeclaration,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.CallSignature,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.ClassExpression,
    ts.SyntaxKind.VariableDeclaration,
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.EnumDeclaration,
    ts.SyntaxKind.ModuleDeclaration,
    ts.SyntaxKind.SourceFile,
])

interface InternalProgram extends ts.Program {
    getCommonSourceDirectory(): string
    isSourceFileFromExternalLibrary(sourceFile: ts.SourceFile): boolean
    isSourceFileDefaultLibrary(sourceFile: ts.SourceFile): boolean
}

//
// TODO - extract
//

export namespace Program {
    export function getCommonSourceDirectory(program: ts.Program): string {
        const interal: InternalProgram = program as InternalProgram
        return interal.getCommonSourceDirectory()
    }

    export function isSourceFileFromExternalLibrary(
        program: ts.Program,
        sourceFile: ts.SourceFile
    ): boolean {
        const interal: InternalProgram = program as InternalProgram
        return interal.isSourceFileFromExternalLibrary(sourceFile)
    }

    export function isSourceFileDefaultLibrary(
        program: ts.Program,
        sourceFile: ts.SourceFile
    ): boolean {
        const interal: InternalProgram = program as InternalProgram

        return interal.isSourceFileDefaultLibrary(sourceFile)
    }
}
