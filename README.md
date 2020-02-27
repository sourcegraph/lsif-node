# TypeScript LSIF indexer

Visit https://lsif.dev/ to learn about LSIF.

## Prerequisites

- [Node.js](https://nodejs.org/en/) at least `10.x.x`

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

Use `lsif-tsc --help` for more information.

# Legal Notices

This project began as a bugfix fork of [microsoft/lsif-node](https://github.com/microsoft/lsif-node) and therefore was originally authored by Microsoft. This code was originally and continues to be released under the [MIT License](./LICENSE).
