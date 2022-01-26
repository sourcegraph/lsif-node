import * as ts from 'typescript'
import * as lsif from './lsif'
import { Input } from './Input'
import { Range } from './Range'
import { Sym } from './Sym'

export class Visitor {
  private localCounter = 0
  constructor(
    public readonly checker: ts.TypeChecker,
    public readonly input: Input,
    public readonly doc: lsif.lib.codeintel.lsif_typed.Document,
    public readonly symbolsCache: Map<ts.Node, Sym>
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
            symbol: lsifSymbol.value,
          })
        )
      }
    }
    ts.forEachChild(node, node => this.visit(node))
  }

  private lsifSymbol(declaration?: ts.Node): Sym {
    if (!declaration) {
      return Sym.empty()
    }
    const fromCache = this.symbolsCache.get(declaration)
    if (fromCache) {
      return fromCache
    }
    const parent = this.lsifSymbol(declaration.parent)
    if (parent.isEmptyOrLocal()) {
      const symbol = Sym.local(this.localCounter)
      this.localCounter++
      this.symbolsCache.set(declaration, symbol)
      return symbol
    }

    if (ts.isInterfaceDeclaration(declaration)) {
      console.log(declaration.name)
    }
    return Sym.empty()
  }
}
