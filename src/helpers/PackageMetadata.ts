import fs from 'fs'
import path from 'path'

interface PackageMetadata {
    version: string
    engines?: {
        node?: string
    }
}

let cachedPackage: PackageMetadata | null = null

function findPackageJson(startDir: string): string | null {
    let current = startDir
    while (true) {
        const candidate = path.join(current, 'package.json')
        if (fs.existsSync(candidate)) return candidate

        const parent = path.dirname(current)
        if (parent === current) return null
        current = parent
    }
}

export function getPackageMetadata(): PackageMetadata {
    if (cachedPackage) return cachedPackage

    const packagePath = findPackageJson(process.cwd()) ?? findPackageJson(__dirname)
    if (!packagePath) {
        throw new Error('Could not find package.json')
    }

    cachedPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as PackageMetadata
    return cachedPackage
}
