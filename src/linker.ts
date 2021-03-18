/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path'

import PackageJson from './package'
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
    nextMoniker,
} from 'lsif-protocol'
import { TscMoniker, NpmMoniker } from './moniker'
import { Emitter } from './emitter'

class Linker {
    constructor(private emitter: Emitter, private idGenerator: () => Id) {}

    protected emit(element: Vertex | Edge): void {
        this.emitter.emit(element)
    }

    protected createPackageInformation(
        packageJson: PackageJson
    ): PackageInformation {
        let result: PackageInformation = {
            id: this.idGenerator(),
            type: ElementTypes.vertex,
            label: VertexLabels.packageInformation,
            name: packageJson.name,
            manager: 'npm',
            version: packageJson.version,
        }
        if (packageJson.hasRepository()) {
            result.repository = packageJson.repository
        }
        return result
    }

    protected createMoniker(
        identifier: string,
        kind: MonikerKind,
        scheme: string
    ): Moniker {
        return {
            id: this.idGenerator(),
            type: ElementTypes.vertex,
            label: VertexLabels.moniker,
            kind: kind,
            scheme: scheme,
            identifier: identifier,
        } as Moniker
    }

    protected createNextMonikerEdge(outV: Id, inV: Id): nextMoniker {
        return {
            id: this.idGenerator(),
            type: ElementTypes.edge,
            label: EdgeLabels.nextMoniker,
            outV: outV,
            inV: inV,
        }
    }

    protected createPackageInformationEdge(
        outV: Id,
        inV: Id
    ): packageInformation {
        return {
            id: this.idGenerator(),
            type: ElementTypes.edge,
            label: EdgeLabels.packageInformation,
            outV: outV,
            inV: inV,
        }
    }
}

export class ExportLinker extends Linker {
    private packageInformation: PackageInformation | undefined

    constructor(
        private projectRoot: string,
        private packageJson: PackageJson,
        emitter: Emitter,
        intIdGenerator: () => Id
    ) {
        super(emitter, intIdGenerator)
    }

    public handleMoniker({ id, identifier }: Moniker): void {
        let tscMoniker: TscMoniker = TscMoniker.parse(identifier)
        if (
            TscMoniker.hasPath(tscMoniker) &&
            this.isPackaged(path.join(this.projectRoot, tscMoniker.path))
        ) {
            this.ensurePackageInformation()
            let npmIdentifier: string
            if (
                this.packageJson.main === tscMoniker.path ||
                this.packageJson.typings === tscMoniker.path
            ) {
                npmIdentifier = NpmMoniker.create(
                    this.packageJson.name,
                    undefined,
                    tscMoniker.name
                )
            } else {
                npmIdentifier = NpmMoniker.create(
                    this.packageJson.name,
                    tscMoniker.path,
                    tscMoniker.name
                )
            }
            let npmMoniker = this.createMoniker(
                npmIdentifier,
                MonikerKind.export,
                NpmMoniker.scheme
            )
            this.emit(npmMoniker)
            this.emit(
                this.createPackageInformationEdge(
                    npmMoniker.id,
                    this.packageInformation!.id
                )
            )
            this.emit(this.createNextMonikerEdge(id, npmMoniker.id))
        }
    }

    public handleMoniker2(identifier: string): Moniker | undefined {
        let tscMoniker: TscMoniker = TscMoniker.parse(identifier)
        if (
            TscMoniker.hasPath(tscMoniker) &&
            this.isPackaged(path.join(this.projectRoot, tscMoniker.path))
        ) {
            this.ensurePackageInformation()
            let npmIdentifier: string
            if (
                this.packageJson.main === tscMoniker.path ||
                this.packageJson.typings === tscMoniker.path
            ) {
                npmIdentifier = NpmMoniker.create(
                    this.packageJson.name,
                    undefined,
                    tscMoniker.name
                )
            } else {
                npmIdentifier = NpmMoniker.create(
                    this.packageJson.name,
                    tscMoniker.path,
                    tscMoniker.name
                )
            }
            let npmMoniker = this.createMoniker(
                npmIdentifier,
                MonikerKind.export,
                NpmMoniker.scheme
            )
            this.emit(npmMoniker)
            this.emit(
                this.createPackageInformationEdge(
                    npmMoniker.id,
                    this.packageInformation!.id
                )
            )
            return npmMoniker
        }

        return undefined
    }

    private isPackaged(uri: string): boolean {
        // This needs to consult the .npmignore file and checks if the
        // document is actually published via npm. For now we return
        // true for all documents.
        return true
    }

    private ensurePackageInformation(): void {
        if (this.packageInformation === undefined) {
            this.packageInformation = this.createPackageInformation(
                this.packageJson
            )
            this.emit(this.packageInformation)
        }
    }
}

export class ImportLinker extends Linker {
    private packageData: Map<
        string,
        { packageInfo: PackageInformation; packageJson: PackageJson } | null
    >

    constructor(
        private projectRoot: string,
        emitter: Emitter,
        intIdGenerator: () => Id
    ) {
        super(emitter, intIdGenerator)
        this.packageData = new Map()
    }

    public handleMoniker({ id, identifier }: Moniker): void {
        const tscMoniker = TscMoniker.parse(identifier)
        if (!TscMoniker.hasPath(tscMoniker)) {
            return
        }
        let parts = tscMoniker.path.split('/')
        let packagePath: string | undefined
        let monikerPath: string | undefined
        for (let i = parts.length - 1; i >= 0; i--) {
            let part = parts[i]
            if (part === 'node_modules') {
                // End is exclusive and one for the name
                const packageIndex = i + (parts[i + 1].startsWith('@') ? 3 : 2)
                packagePath = path.join(
                    this.projectRoot,
                    ...parts.slice(0, packageIndex),
                    `package.json`
                )
                monikerPath = parts.slice(packageIndex).join('/')
                break
            }
        }
        if (
            packagePath === undefined ||
            (monikerPath !== undefined && monikerPath.length === 0)
        ) {
            return
        }
        let packageData = this.packageData.get(packagePath)
        if (packageData === undefined) {
            let packageJson = PackageJson.read(packagePath)
            if (packageJson === undefined) {
                this.packageData.set(packagePath, null)
            } else {
                packageData = {
                    packageInfo: this.createPackageInformation(packageJson),
                    packageJson: packageJson,
                }
                this.emit(packageData.packageInfo)
                this.packageData.set(packagePath, packageData)
            }
        }
        if (packageData !== null && packageData !== undefined) {
            let npmIdentifier: string
            if (
                packageData.packageJson.typings === monikerPath ||
                packageData.packageJson.main === monikerPath
            ) {
                npmIdentifier = NpmMoniker.create(
                    packageData.packageJson.name,
                    undefined,
                    tscMoniker.name
                )
            } else {
                npmIdentifier = NpmMoniker.create(
                    packageData.packageJson.name,
                    monikerPath,
                    tscMoniker.name
                )
            }
            let npmMoniker = this.createMoniker(
                npmIdentifier,
                MonikerKind.import,
                NpmMoniker.scheme
            )
            this.emit(npmMoniker)
            this.emit(
                this.createPackageInformationEdge(
                    npmMoniker.id,
                    packageData.packageInfo.id
                )
            )
            this.emit(this.createNextMonikerEdge(npmMoniker.id, id))
        }
    }

    public handleMoniker2(identifier: string): Moniker | undefined {
        const tscMoniker = TscMoniker.parse(identifier)
        if (!TscMoniker.hasPath(tscMoniker)) {
            return undefined
        }
        let parts = tscMoniker.path.split('/')
        let packagePath: string | undefined
        let monikerPath: string | undefined
        for (let i = parts.length - 1; i >= 0; i--) {
            let part = parts[i]
            if (part === 'node_modules') {
                // End is exclusive and one for the name
                const packageIndex = i + (parts[i + 1].startsWith('@') ? 3 : 2)
                packagePath = path.join(
                    this.projectRoot,
                    ...parts.slice(0, packageIndex),
                    `package.json`
                )
                monikerPath = parts.slice(packageIndex).join('/')
                break
            }
        }
        if (
            packagePath === undefined ||
            (monikerPath !== undefined && monikerPath.length === 0)
        ) {
            return undefined
        }
        let packageData = this.packageData.get(packagePath)
        if (packageData === undefined) {
            let packageJson = PackageJson.read(packagePath)
            if (packageJson === undefined) {
                this.packageData.set(packagePath, null)
            } else {
                packageData = {
                    packageInfo: this.createPackageInformation(packageJson),
                    packageJson: packageJson,
                }
                this.emit(packageData.packageInfo)
                this.packageData.set(packagePath, packageData)
            }
        }
        if (packageData !== null && packageData !== undefined) {
            let npmIdentifier: string
            if (
                packageData.packageJson.typings === monikerPath ||
                packageData.packageJson.main === monikerPath
            ) {
                npmIdentifier = NpmMoniker.create(
                    packageData.packageJson.name,
                    undefined,
                    tscMoniker.name
                )
            } else {
                npmIdentifier = NpmMoniker.create(
                    packageData.packageJson.name,
                    monikerPath,
                    tscMoniker.name
                )
            }
            let npmMoniker = this.createMoniker(
                npmIdentifier,
                MonikerKind.import,
                NpmMoniker.scheme
            )
            this.emit(npmMoniker)
            this.emit(
                this.createPackageInformationEdge(
                    npmMoniker.id,
                    packageData.packageInfo.id
                )
            )
            return npmMoniker
        }

        return undefined
    }
}
