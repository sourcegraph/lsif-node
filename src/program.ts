import ts from 'typescript-lsif'

export class LanguageServiceHost implements ts.LanguageServiceHost {
    private scriptSnapshots = new Map<string, ts.IScriptSnapshot | null>()

    constructor(
        private config: ts.ParsedCommandLine,
        private currentDirectory: string
    ) {}

    public getProjectVersion = () => '0'
    public getScriptVersion = () => '0'
    public getCurrentDirectory = () => this.currentDirectory
    public getCompilationSettings = () => this.config.options
    public getProjectReferences = () => this.config.projectReferences
    public getScriptFileNames = () => this.config.fileNames
    public directoryExists = ts.sys.directoryExists.bind(ts.sys)
    public fileExists = ts.sys.fileExists.bind(ts.sys)
    public getDefaultLibFileName = ts.getDefaultLibFilePath.bind(ts)
    public getDirectories = ts.sys.getDirectories.bind(ts.sys)
    public readDirectory = ts.sys.readDirectory.bind(ts.sys)
    public readFile = ts.sys.readFile.bind(ts.sys)

    public getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
        const cachedSnapshot = this.scriptSnapshots.get(fileName)
        if (cachedSnapshot !== undefined) {
            return cachedSnapshot || undefined
        }

        const snapshot = ts.sys.fileExists(fileName)
            ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || '')
            : null
        this.scriptSnapshots.set(fileName, snapshot)
        return snapshot || undefined
    }
}
