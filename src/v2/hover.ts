import { lsp } from 'lsif-protocol'
import ts from 'typescript-lsif'

const joinTexts = (parts: { text: string }[] | undefined): string =>
  (parts || []).map((part) => part.text).join('')

type MarkedString = string | { language: string; value: string }

export const getHover = (
  languageService: ts.LanguageService,
  node: ts.DeclarationName,
  sourceFile: ts.SourceFile = node.getSourceFile()
): lsp.Hover | undefined => {
  try {
    const quickInfo = languageService.getQuickInfoAtPosition(node, sourceFile)
    if (quickInfo !== undefined) {
      const contents: MarkedString[] = []
      if (quickInfo.displayParts) {
        contents.push({
          language: 'typescript',
          value: joinTexts(quickInfo.displayParts),
        })
      }
      if (quickInfo.documentation && quickInfo.documentation.length > 0) {
        contents.push(joinTexts(quickInfo.documentation))
      }

      return { contents }
    }
  } catch (err) {
    // fallthrough
  }

  return undefined
}
