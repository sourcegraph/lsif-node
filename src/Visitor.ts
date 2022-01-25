import * as ts from 'typescript'
import * as lsif from './lsif'
import { Input } from './Input'
import { Range } from './Range'
import { Symbol } from './Symbol'

export class Visitor {
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
      const symbol = Symbol.local(this.localCounter).value
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
