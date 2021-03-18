#!/usr/bin/env node

import { main } from './v2/main'

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
