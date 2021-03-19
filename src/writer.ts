import * as fs from 'fs'
import * as path from 'path'
import { readPackageJson, PackageJson } from './package'
import * as os from 'os'
import { EdgeBuilder, VertexBuilder } from './graph'
import * as tss from './typescripts'
import {
    Edge,
    Vertex,
    Id,
    Moniker,
    PackageInformation,
    packageInformation,
    EdgeLabels,
    ElementTypes,
    VertexLabels,
    MonikerKind,
} from 'lsif-protocol'
import * as Is from './util'

const sanitizeMonikerPath = (packageJson: PackageJson, path: string): string =>
    path !== packageJson.main && path !== packageJson.typings ? '' : path

const createMoniker = (
    packageJson: PackageJson,
    moniker: { name: string; path?: string }
): string => {
    const path = sanitizeMonikerPath(packageJson, moniker.path || '')
    return [packageJson.name, path.replace(/:/g, '::'), moniker.name].join(':')
}

interface PackageDataPair {
    packageInfo: PackageInformation
    packageJson: PackageJson
}

export class Emitter {
    private _id = 0
    private _fd: number
    private _vertex: VertexBuilder
    private _edge: EdgeBuilder

    private packageInformation: PackageInformation | undefined
    private packageData: Map<string, PackageDataPair | null>

    public constructor(
        filename: string,
        private projectRoot: string,
        private packageJson?: PackageJson
    ) {
        this._fd = fs.openSync(filename, 'w')
        this._vertex = new VertexBuilder(this.nextId.bind(this))
        this._edge = new EdgeBuilder(this.nextId.bind(this))
        this.packageData = new Map()
    }

    private nextId(): number {
        return this._id++
    }

    public get vertex(): VertexBuilder {
        return this._vertex
    }

    public get edge(): EdgeBuilder {
        return this._edge
    }

    public emit(element: Vertex | Edge): void {
        const buffer = Buffer.from(
            JSON.stringify(element, undefined, 0) + os.EOL,
            'utf8'
        )

        let offset = 0
        while (offset < buffer.length) {
            offset += fs.writeSync(this._fd, buffer, offset)
        }
    }

    public handleImportMoniker(
        xpath: string,
        symbol?: string
    ): Moniker | undefined {
        const tscMoniker = tss.parseIdentifier(xpath, symbol)
        if (!tscMoniker.path) {
            return undefined
        }

        const { packagePath, monikerPath } = this.getMonikerPaths(
            tscMoniker.path
        )
        if (!packagePath || !monikerPath || monikerPath.length === 0) {
            return undefined
        }

        const packageData = this.getOrCreatePackageData(packagePath)
        if (!packageData) {
            return undefined
        }

        return this.emitMoniker(
            createMoniker(packageData.packageJson, tscMoniker),
            MonikerKind.import,
            packageData.packageInfo.id
        )
    }

    public handleExportMoniker(
        path: string,
        symbol?: string
    ): Moniker | undefined {
        const tscMoniker = tss.parseIdentifier(path, symbol)
        if (!tscMoniker.path) {
            return undefined
        }

        const packageInformation = this.ensurePackageInformation()
        if (!this.packageJson || !packageInformation) {
            return undefined
        }

        // Note from original msft/lsif-node/tsc implementation:
        //
        // This needs to consult the .npmignore file and checks if the
        // document is actually published via npm. For now we return
        // true for all documents.
        // const uri = path.join(this.projectRoot, tscMoniker.path)

        return this.emitMoniker(
            createMoniker(this.packageJson, tscMoniker),
            MonikerKind.export,
            packageInformation.id
        )
    }

    private getMonikerPaths(
        identifier: string
    ): {
        packagePath?: string
        monikerPath?: string
    } {
        //
        // TODO - clean this up
        //

        const parts = identifier.split('/')
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i] !== 'node_modules') {
                continue
            }

            // End is exclusive and one for the name
            const packageIndex = i + (parts[i + 1].startsWith('@') ? 3 : 2)

            return {
                packagePath: path.join(
                    this.projectRoot,
                    ...parts.slice(0, packageIndex),
                    `package.json`
                ),
                monikerPath: parts.slice(packageIndex).join('/'),
            }
        }

        return { packagePath: undefined, monikerPath: undefined }
    }

    private getOrCreatePackageData(
        packagePath: string
    ): PackageDataPair | undefined {
        const cachedPackageData = this.packageData.get(packagePath)
        if (cachedPackageData) {
            return cachedPackageData || undefined
        }

        const packageJson = readPackageJson(packagePath)
        const packageData = packageJson
            ? { packageInfo: this.createPackageData(packageJson), packageJson }
            : null
        this.packageData.set(packagePath, packageData)
        return packageData || undefined
    }

    private createPackageData(packageJson: PackageJson): PackageInformation {
        const repositoryFields = Is.string(packageJson.repository?.url)
            ? { repository: packageJson.repository }
            : {}

        const packageInfo: PackageInformation = {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.packageInformation,
            name: packageJson.name,
            manager: 'npm',
            version: packageJson.version,
            ...repositoryFields,
        }

        this.emit(packageInfo)
        return packageInfo
    }

    private ensurePackageInformation(): PackageInformation | undefined {
        if (!this.packageJson || this.packageInformation !== undefined) {
            return this.packageInformation
        }

        this.packageInformation = {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.packageInformation,
            name: this.packageJson.name,
            manager: 'npm',
            version: this.packageJson.version,
            ...(Is.string(this.packageJson.repository?.url)
                ? { repository: this.packageJson.repository }
                : {}),
        }

        this.emit(this.packageInformation)
        return this.packageInformation
    }

    private emitMoniker(
        identifier: string,
        kind: MonikerKind,
        packageInformationId: Id
    ): Moniker {
        const npmMoniker: Moniker = {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.moniker,
            kind,
            scheme: 'npm',
            identifier,
        }
        const packageInformation: packageInformation = {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.packageInformation,
            outV: npmMoniker.id,
            inV: packageInformationId,
        }

        this.emit(npmMoniker)
        this.emit(packageInformation)
        return npmMoniker
    }
}
