/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict'

import ts from 'typescript-lsif'
import * as tss from './typescripts'
import { execSync } from 'child_process'

export function removeExtension(value: string): string {
    if (value.endsWith('.d.ts')) {
        return value.substring(0, value.length - 5)
    }
    if (value.endsWith('.ts') || value.endsWith('.js')) {
        return value.substring(0, value.length - 3)
    }

    return value
}

export function normalizeSeparator(value: string): string {
    return value.replace(/\\/g, '/')
}

export interface PathContext {
    projectRoot: string
    rootDir: string
    outDir: string
    repositoryRoot: string
}

export const makePathContext = (
    program: ts.Program,
    projectRoot: string,
    currentDirectory: string,
    repositoryRoot?: string
): PathContext => {
    const compilerOptions = program.getCompilerOptions()

    const rootDir =
        (compilerOptions.rootDir &&
            tss.makeAbsolute(compilerOptions.rootDir, currentDirectory)) ||
        (compilerOptions.baseUrl &&
            tss.makeAbsolute(compilerOptions.baseUrl, currentDirectory)) ||
        tss.normalizePath(tss.Program.getCommonSourceDirectory(program))

    const outDir =
        (compilerOptions.outDir &&
            tss.makeAbsolute(compilerOptions.outDir, currentDirectory)) ||
        rootDir

    return {
        projectRoot,
        rootDir,
        outDir,
        repositoryRoot:
            repositoryRoot ||
            tss.makeAbsolute(
                execSync('git rev-parse --show-toplevel').toString().trim()
            ),
    }
}
