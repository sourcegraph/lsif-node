import * as fs from 'fs'
import { create as createEmitter, Emitter } from '../emitter'
import { Builder } from '../graph'
import { ExportLinker, ImportLinker } from '../linker'
import PackageJson from '../package'
import { FileWriter } from '../writer'

export interface WriterContext {
    builder: Builder
    emitter: Emitter
    importLinker: ImportLinker
    exportLinker?: ExportLinker
}

export const makeWriterContext = (
    filename: string,
    projectRoot: string,
    packageJson?: PackageJson
): WriterContext => {
    let counter = 1
    const idGenerator = () => counter++
    const emitter = createEmitter(new FileWriter(fs.openSync(filename, 'w')))

    return {
        emitter,
        builder: new Builder({ idGenerator, emitSource: false }),
        importLinker: new ImportLinker(projectRoot, emitter, idGenerator),
        exportLinker:
            packageJson &&
            new ExportLinker(projectRoot, packageJson, emitter, idGenerator),
    }
}
