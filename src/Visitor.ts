import * as ts from 'typescript'
import * as lsif from './lsif'
import { Input } from './Input'
import { Range } from './Range'
import { LsifSymbol } from './LsifSymbol'
import { Packages } from './Packages'
import { Descriptor } from './Descriptor'

export class Visitor {
  private localCounter = 0
  private localSymbolCache: Map<ts.Node, LsifSymbol> = new Map()
  constructor(
    public readonly checker: ts.TypeChecker,
    public readonly input: Input,
    public readonly doc: lsif.lib.codeintel.lsif_typed.Document,
    public readonly symbolsCache: Map<ts.Node, LsifSymbol>,
    public readonly packages: Packages,
    public readonly sourceFile: ts.SourceFile
  ) {}
  public index(): void {
    this.visit(this.sourceFile)
  }
  private visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const range = Range.fromNode(node)
      const sym = this.checker.getSymbolAtLocation(node)
      for (const declaration of sym?.declarations || []) {
        const lsifSymbol = this.lsifSymbol(declaration)
        this.doc.occurrences.push(
          new lsif.lib.codeintel.lsif_typed.Occurrence({
            range: range.toLsif(),
            symbol: lsifSymbol.value,
          })
        )
      }
    }
    ts.forEachChild(node, node => this.visit(node))
  }

  private lsifSymbol(node?: ts.Node): LsifSymbol {
    if (!node) {
      return LsifSymbol.empty()
    }
    const fromCache: LsifSymbol | undefined =
      this.symbolsCache.get(node) || this.localSymbolCache.get(node)
    if (fromCache) {
      return fromCache
    }
    if (ts.isBlock(node)) {
      return LsifSymbol.empty()
    }
    if (ts.isSourceFile(node)) {
      const pkg = this.packages.symbol(node.fileName)
      if (!pkg) {
        return this.cached(node, LsifSymbol.empty())
      }
      return this.cached(node, pkg)
    }
    const owner = this.lsifSymbol(node.parent)
    if (owner.isEmptyOrLocal()) {
      return this.newLocalSymbol(node)
    }

    if (isAnonymousContainerOfSymbols(node)) {
      return this.cached(node, this.lsifSymbol(node.parent))
    }
    if (ts.isImportSpecifier(node)) {
      const tpe = this.checker.getTypeAtLocation(node)
      for (const declaration of tpe.symbol.declarations || []) {
        console.log({
          tpe: declaration.getSourceFile().fileName,
        })
        return this.lsifSymbol(declaration)
      }
    }

    const desc = this.descriptor(node)
    if (desc) {
      return this.cached(node, LsifSymbol.global(owner, desc))
    }
    debug(node)
    return this.newLocalSymbol(node)
  }

  private newLocalSymbol(node: ts.Node): LsifSymbol {
    const symbol = LsifSymbol.local(this.localCounter)
    this.localCounter++
    this.localSymbolCache.set(node, symbol)
    return symbol
  }
  private cached(node: ts.Node, sym: LsifSymbol): LsifSymbol {
    this.symbolsCache.set(node, sym)
    return sym
  }
  private descriptor(node: ts.Node): Descriptor | undefined {
    if (ts.isInterfaceDeclaration(node)) {
      return Descriptor.type(node.name.getText())
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodSignature(node)) {
      return Descriptor.method(node.name?.getText() || 'boom', '')
    }
    if (
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isVariableDeclaration(node)
    ) {
      return Descriptor.term(node.name.getText())
    }
    if (ts.isModuleDeclaration(node)) {
      return Descriptor.package(node.name.getText())
    }
    if (ts.isImportSpecifier(node)) {
      const tpe = this.checker.getTypeAtLocation(node)
      for (const declaration of tpe.symbol.declarations || []) {
        console.log({
          tpe: declaration.getSourceFile().fileName,
        })
        return this.descriptor(declaration)
      }
    }
    return undefined
  }
}

function isAnonymousContainerOfSymbols(node: ts.Node): boolean {
  return (
    ts.isModuleBlock(node) ||
    ts.isImportDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isNamedImports(node) ||
    ts.isVariableStatement(node) ||
    ts.isVariableDeclarationList(node)
  )
}

function debug(node: ts.Node): void {
  console.log({ kind: ts.SyntaxKind[node.kind], text: node.getText() })
}
