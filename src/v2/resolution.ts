import ts from 'typescript-lsif'
import * as tss from '../typescripts'

export type ResolverType =
  | 'alias'
  | 'method'
  | 'standard'
  | 'transient'
  | 'typeAlias'
  | 'unionOrIntersection'

export function getResolverType(
  typeChecker: ts.TypeChecker,
  symbol: ts.Symbol,
  node: ts.Node
): ResolverType {
  if (tss.isTransient(symbol)) {
    if (tss.isComposite(typeChecker, symbol, node)) {
      return 'unionOrIntersection'
    }

    // Problem: Symbols that come from the lib*.d.ts files are marked transient
    // as well. Check if the symbol has some other meaningful flags
    if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) === 0) {
      return 'transient'
    }
  }

  return tss.isTypeAlias(symbol)
    ? 'typeAlias'
    : tss.isAliasSymbol(symbol)
    ? 'alias'
    : tss.isMethodSymbol(symbol)
    ? 'method'
    : 'standard'
}
