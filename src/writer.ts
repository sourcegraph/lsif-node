/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import { writeSync } from 'fs';

export interface Writer {
	writeln(...data: string[]): void;
}

export class FileWriter implements Writer{
	public constructor(private fd: number) {}

	writeln(...data: string[]): void {
		for (let chunk of data) {
			this.writeBuffer(Buffer.from(chunk, 'utf8'));
		}
		this.writeBuffer(Buffer.from(os.EOL, 'utf8'));
	}

	private writeBuffer(buffer: Buffer): void {
		let offset: number = 0;
		while (offset < buffer.length) {
			offset += writeSync(this.fd, buffer, offset);
		}
	}
}
