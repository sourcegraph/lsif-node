import { lsp } from 'lsif-protocol'
import ts from 'typescript-lsif'

export const phantomPosition = { line: 0, character: 0 }
export const phantomRange = { start: phantomPosition, end: phantomPosition }

export const rangeFromNode = (
    file: ts.SourceFile,
    node: ts.Node,
    includeJsDocComment?: boolean
): lsp.Range => ({
    start:
        file === node
            ? phantomPosition
            : file.getLineAndCharacterOfPosition(
                  node.getStart(file, includeJsDocComment)
              ),
    end: file.getLineAndCharacterOfPosition(node.getEnd()),
})
