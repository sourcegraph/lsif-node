import * as fs from 'fs'
import {
    Edge,
    EdgeLabels,
    ElementTypes,
    Id,
    Moniker,
    MonikerKind,
    PackageInformation,
    packageInformation,
    Vertex,
    VertexLabels,
} from 'lsif-protocol'
import * as os from 'os'
import * as path from 'path'
import { parseIdentifier, string as isString } from './debt'
import { PackageJson, readPackageJson } from './package'

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
    private id = 0
    private fd: number
    private packageInformation?: PackageInformation
    private packageData: Map<string, PackageDataPair | null>

    public constructor(
        filename: string,
        private projectRoot: string,
        private packageJson?: PackageJson
    ) {
        this.fd = fs.openSync(filename, 'w')
        this.packageData = new Map()
    }

    public emit<T extends Vertex | Edge>(element: Omit<T, 'id'>): T {
        const id: T['id'] = this.id++
        const elementWithId = { ...element, id } as T

        const buffer = Buffer.from(
            JSON.stringify(elementWithId, undefined, 0) + os.EOL,
            'utf8'
        )

        let offset = 0
        while (offset < buffer.length) {
            offset += fs.writeSync(this.fd, buffer, offset)
        }

        return elementWithId
    }

    public handleImportMoniker(
        xpath: string,
        symbol?: string
    ): Moniker | undefined {
        const tscMoniker = parseIdentifier(xpath, symbol)
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
        const tscMoniker = parseIdentifier(path, symbol)
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

    private ensurePackageInformation(): PackageInformation | undefined {
        if (!this.packageJson) {
            return undefined
        }

        if (this.packageInformation === undefined) {
            this.packageInformation = this.createPackageData(this.packageJson)
        }

        return this.packageInformation
    }

    private createPackageData(packageJson: PackageJson): PackageInformation {
        return this.emit<PackageInformation>({
            type: ElementTypes.vertex,
            label: VertexLabels.packageInformation,
            name: packageJson.name,
            manager: 'npm',
            version: packageJson.version,
            ...(isString(packageJson.repository?.url)
                ? { repository: packageJson.repository }
                : {}),
        })
    }

    private emitMoniker(
        identifier: string,
        kind: MonikerKind,
        packageInformationId: Id
    ): Moniker {
        const npmMoniker = this.emit<Moniker>({
            type: ElementTypes.vertex,
            label: VertexLabels.moniker,
            kind,
            scheme: 'npm',
            identifier,
        })

        this.emit<packageInformation>({
            type: ElementTypes.edge,
            label: EdgeLabels.packageInformation,
            outV: npmMoniker.id,
            inV: packageInformationId,
        })

        return npmMoniker
    }
}
