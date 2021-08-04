# TypeScript LSIF indexer ![Beta](https://img.shields.io/badge/status-beta-orange?style=flat)

Visit https://lsif.dev/ to learn about LSIF.

## Installation

```
npm install -g @sourcegraph/lsif-tsc
```

## Indexing your repository

After installing `lsif-tsc` onto your PATH, you can invoke it with all of the arguments that are available to `tsc`.

Index a TypeScript project by running the following command in the directory with your `tsconfig.json`.

```
$ lsif-tsc -p .
..............
46 file(s), 2787 symbol(s)
Processed in 3.236s
```

Index a Javascript project by running the following command.

```
$ lsif-tsc **/*.js --AllowJs --checkJs
................................
295 file(s), 65535 symbol(s)
Processed in 51.732s
```

The previous command relies on shell expansion to pass a list of filenames to the underlying TypeScript compiler. There is a limit on the number of files that can be passed as a command line argument, so it may be necessary to first dump the project filenames into a temporary file, and load that, as follows:

```
ls -1 **/*.js > inputs.txt
lsif-tsc @inputs.txt --AllowJs --checkJs
```

Use `lsif-tsc --help` for more information.

# Legal Notices

This project began as a bugfix fork of [microsoft/lsif-node](https://github.com/microsoft/lsif-node) and therefore was originally authored by Microsoft. This code was originally and continues to be released under the [MIT License](./LICENSE).
