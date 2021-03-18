import * as fs from 'fs'
import PackageJson from './package'
import * as os from 'os'
import { EdgeBuilder, VertexBuilder } from './graph'
import * as path from 'path'
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

export class Emitter {
    private _id = 0
    private _fd: number
    private _vertex: VertexBuilder
    private _edge: EdgeBuilder

    private packageInformation: PackageInformation | undefined
    private packageData: Map<
        string,
        { packageInfo: PackageInformation; packageJson: PackageJson } | null
    >

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

    public handleImportMoniker(identifier: string): Moniker | undefined {
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

    public handleExportMoniker(identifier: string): Moniker | undefined {
        if (!this.packageJson) {
            return undefined
        }

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

    private isPackaged(uri: string): boolean {
        // This needs to consult the .npmignore file and checks if the
        // document is actually published via npm. For now we return
        // true for all documents.
        return true
    }

    private ensurePackageInformation(): void {
        if (this.packageJson && this.packageInformation === undefined) {
            this.packageInformation = this.createPackageInformation(
                this.packageJson
            )
            this.emit(this.packageInformation)
        }
    }

    private createPackageInformation(
        packageJson: PackageJson
    ): PackageInformation {
        let result: PackageInformation = {
            id: this.nextId(),
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

    private createMoniker(
        identifier: string,
        kind: MonikerKind,
        scheme: string
    ): Moniker {
        return {
            id: this.nextId(),
            type: ElementTypes.vertex,
            label: VertexLabels.moniker,
            kind,
            scheme,
            identifier,
        }
    }

    // private createNextMonikerEdge(outV: Id, inV: Id): nextMoniker {
    //     return {
    //         id: this.nextId(),
    //         type: ElementTypes.edge,
    //         label: EdgeLabels.nextMoniker,
    //         outV,
    //         inV,
    //     }
    // }

    private createPackageInformationEdge(
        outV: Id,
        inV: Id
    ): packageInformation {
        return {
            id: this.nextId(),
            type: ElementTypes.edge,
            label: EdgeLabels.packageInformation,
            outV,
            inV,
        }
    }
}

export const separator: string = ':'

export interface TscMoniker {
    /**
     * The symbol name of the moniker.
     */
    name: string

    /**
     * The path of the moniker;
     */
    path?: string
}

export namespace TscMoniker {
    export const scheme: string = 'tsc'

    export function parse(identifier: string): TscMoniker {
        let index = identifier.lastIndexOf(separator)
        if (index === -1) {
            return { name: identifier }
        }
        return {
            name: identifier.substring(index + 1),
            path: identifier.substr(0, index).replace(/::/g, ':'),
        }
    }

    export function create(name: string, path?: string): string {
        if (!path) {
            return name
        }
        return `${escape(path)}${separator}${name}`
    }

    export function hasPath(
        moniker: TscMoniker
    ): moniker is TscMoniker & { path: string } {
        return !!moniker.path
    }
}

export namespace NpmMoniker {
    export const scheme: string = 'npm'

    export function create(
        module: string,
        path: string | undefined,
        name: string
    ): string {
        return `${module}${separator}${
            path !== undefined ? escape(path) : ''
        }${separator}${name}`
    }
}

function escape(value: string): string {
    return value.replace(/:/g, '::')
}
