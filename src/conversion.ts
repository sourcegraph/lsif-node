/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { lsp } from 'lsif-protocol'
import * as ts from 'typescript-lsif'

export function rangeFromNode(
  this: void,
  file: ts.SourceFile,
  node: ts.Node,
  includeJsDocComment?: boolean
): lsp.Range {
  let start: ts.LineAndCharacter
  if (file === node) {
    start = { line: 0, character: 0 }
  } else {
    start = file.getLineAndCharacterOfPosition(
      node.getStart(file, includeJsDocComment)
    )
  }
  const end = file.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  }
}

const symbolKindMap: Map<number, lsp.SymbolKind> = new Map<
  number,
  lsp.SymbolKind
>([
  [ts.SyntaxKind.ClassDeclaration, lsp.SymbolKind.Class],
  [ts.SyntaxKind.InterfaceDeclaration, lsp.SymbolKind.Interface],
  [ts.SyntaxKind.TypeParameter, lsp.SymbolKind.TypeParameter],
  [ts.SyntaxKind.MethodDeclaration, lsp.SymbolKind.Method],
  [ts.SyntaxKind.FunctionDeclaration, lsp.SymbolKind.Function],
])

export function asSymbolKind(this: void, node: ts.Node): lsp.SymbolKind {
  let result: lsp.SymbolKind | undefined = symbolKindMap.get(node.kind)
  if (result === undefined) {
    result = lsp.SymbolKind.Property
  }
  return result
}

export function asHover(
  this: void,
  file: ts.SourceFile,
  value: ts.QuickInfo
): lsp.Hover {
  const content: lsp.MarkedString[] = []
  if (value.displayParts !== undefined) {
    content.push({
      language: 'typescript',
      value: displayPartsToString(value.displayParts),
    })
  }
  if (value.documentation && value.documentation.length > 0) {
    content.push(displayPartsToString(value.documentation))
  }
  return {
    contents: content,
  }
}

function displayPartsToString(
  this: void,
  displayParts: ts.SymbolDisplayPart[] | undefined
): string {
  if (displayParts) {
    return displayParts.map(displayPart => displayPart.text).join('')
  }
  return ''
}
