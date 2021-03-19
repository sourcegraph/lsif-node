import * as fs from 'fs'
import { string as isString } from './debt'

export interface PackageJson {
    name: string
    main: string
    typings: string
    version?: string
    repository?: { type: string; url: string }
}

const sanitizePath = (value: string): string => {
    for (const ext of ['.ts', '.js', '.d']) {
        if (value.endsWith(ext)) {
            return value.substring(0, value.length - ext.length)
        }
    }

    return value.replace(/\\/g, '/')
}

const readPackageJsonInternal = (filename: string): PackageJson | undefined => {
    if (!fs.existsSync(filename)) {
        return undefined
    }

    const content = fs.readFileSync(filename, { encoding: 'utf8' })
    const { name, version, repository, main, typings } = JSON.parse(
        content
    ) as Partial<PackageJson>

    if (!isString(name)) {
        return undefined
    }

    return {
        name,
        version,
        repository,
        main: sanitizePath(main || 'index'),
        typings: sanitizePath(typings || 'index'),
    }
}

export const readPackageJson = (filename: string): PackageJson | undefined => {
    try {
        return readPackageJsonInternal(filename)
    } catch {
        return undefined
    }
}
