import * as invariant from "invariant";
import * as stripBOM from "strip-bom";

const LOCKFILE_VERSION = 1;
const VERSION_REGEX = /^yarn lockfile v(\d+)$/;

const TOKEN_TYPES = {
	boolean: "BOOLEAN",
	string: "STRING",
	identifier: "IDENTIFIER",
	eof: "EOF",
	colon: "COLON",
	newline: "NEWLINE",
	comment: "COMMENT",
	indent: "INDENT",
	invalid: "INVALID",
	number: "NUMBER",
	comma: "COMMA"
};

const VALID_PROP_VALUE_TOKENS = [
	TOKEN_TYPES.boolean,
	TOKEN_TYPES.string,
	TOKEN_TYPES.number
];

function isValidPropValueToken(token): boolean {
	return VALID_PROP_VALUE_TOKENS.indexOf(token.type) >= 0;
}

type Token = {
	line: number;
	col: number;
	type: string;
	value: boolean | number | string | void;
};

function* tokenise(input: string): Iterator<Token> {
	let lastNewline = false;
	let line = 1;
	let col = 0;

	function buildToken(type, value?): Token {
		return { line, col, type, value };
	}

	while (input.length) {
		let chop = 0;

		if (input[0] === "\n") {
			chop++;
			line++;
			col = 0;
			yield buildToken(TOKEN_TYPES.newline);
		} else if (input[0] === "#") {
			chop++;

			let val = "";
			while (input[chop] !== "\n") {
				val += input[chop];
				chop++;
			}
			yield buildToken(TOKEN_TYPES.comment, val);
		} else if (input[0] === " ") {
			if (lastNewline) {
				let indent = "";
				for (let i = 0; input[i] === " "; i++) {
					indent += input[i];
				}

				if (indent.length % 2) {
					throw new TypeError("Invalid number of spaces");
				} else {
					chop = indent.length;
					yield buildToken(TOKEN_TYPES.indent, indent.length / 2);
				}
			} else {
				chop++;
			}
		} else if (input[0] === '"') {
			let val = "";

			for (let i = 0; ; i++) {
				const currentChar = input[i];
				val += currentChar;

				if (i > 0 && currentChar === '"') {
					const isEscaped =
						input[i - 1] === "\\" && input[i - 2] !== "\\";
					if (!isEscaped) {
						break;
					}
				}
			}

			chop = val.length;

			try {
				yield buildToken(TOKEN_TYPES.string, JSON.parse(val));
			} catch (err) {
				if (err instanceof SyntaxError) {
					yield buildToken(TOKEN_TYPES.invalid);
				} else {
					throw err;
				}
			}
		} else if (/^[0-9]/.test(input)) {
			let val = "";
			for (let i = 0; /^[0-9]$/.test(input[i]); i++) {
				val += input[i];
			}
			chop = val.length;

			yield buildToken(TOKEN_TYPES.number, +val);
		} else if (/^true/.test(input)) {
			yield buildToken(TOKEN_TYPES.boolean, true);
			chop = 4;
		} else if (/^false/.test(input)) {
			yield buildToken(TOKEN_TYPES.boolean, false);
			chop = 5;
		} else if (input[0] === ":") {
			yield buildToken(TOKEN_TYPES.colon);
			chop++;
		} else if (input[0] === ",") {
			yield buildToken(TOKEN_TYPES.comma);
			chop++;
		} else if (/^[a-zA-Z\/-]/g.test(input)) {
			let name = "";
			for (let i = 0; i < input.length; i++) {
				const char = input[i];
				if (
					char === ":" ||
					char === " " ||
					char === "\n" ||
					char === ","
				) {
					break;
				} else {
					name += char;
				}
			}
			chop = name.length;

			yield buildToken(TOKEN_TYPES.string, name);
		} else {
			yield buildToken(TOKEN_TYPES.invalid);
		}

		if (!chop) {
			// will trigger infinite recursion
			yield buildToken(TOKEN_TYPES.invalid);
		}

		col += chop;
		lastNewline = input[0] === "\n";
		input = input.slice(chop);
	}

	yield buildToken(TOKEN_TYPES.eof);
}

export interface PackageInfo {
	dependencies: { [index: string]: string };
	resolved: string;
	version: string;
}

export interface LockInfo {
	[index: string]: PackageInfo;
}

class Parser {
	constructor(input: string, fileLoc: string = "lockfile") {
		this.comments = [];
		this.tokens = tokenise(input);
		this.fileLoc = fileLoc;
	}

	fileLoc: string;
	token: Token;
	tokens: Iterator<Token>;
	comments: Array<string>;

	onComment(token: Token) {
		const value = token.value as string;
		invariant(
			typeof value === "string",
			"expected token value to be a string"
		);

		const comment = value.trim();

		const versionMatch = comment.match(VERSION_REGEX);
		if (versionMatch) {
			const version = +versionMatch[1];
			if (version > LOCKFILE_VERSION) {
				throw `Can't install from a lockfile of version ${version} as you're on an old yarn version that only supports ` +
					`versions up to ${LOCKFILE_VERSION}. Run \`$ yarn self-update\` to upgrade to the latest version.`;
			}
		}

		this.comments.push(comment);
	}

	next(): Token {
		const item = this.tokens.next();
		invariant(item, "expected a token");

		const { done, value } = item;
		if (done || !value) {
			throw new Error("No more tokens");
		} else if (value.type === TOKEN_TYPES.comment) {
			this.onComment(value);
			return this.next();
		} else {
			return (this.token = value);
		}
	}

	unexpected(msg: string = "Unexpected token") {
		throw new SyntaxError(
			`${msg} ${this.token.line}:${this.token.col} in ${this.fileLoc}`
		);
	}

	parse(indent: number = 0): LockInfo {
		const obj = {};

		while (true) {
			const propToken = this.token;

			if (propToken.type === TOKEN_TYPES.newline) {
				const nextToken = this.next();
				if (!indent) {
					// if we have 0 indentation then the next token doesn't matter
					continue;
				}

				if (nextToken.type !== TOKEN_TYPES.indent) {
					// if we have no indentation after a newline then we've gone down a level
					break;
				}

				if (nextToken.value === indent) {
					// all is good, the indent is on our level
					this.next();
				} else {
					// the indentation is less than our level
					break;
				}
			} else if (propToken.type === TOKEN_TYPES.indent) {
				if (propToken.value === indent) {
					this.next();
				} else {
					break;
				}
			} else if (propToken.type === TOKEN_TYPES.eof) {
				break;
			} else if (propToken.type === TOKEN_TYPES.string) {
				// property key
				const key = propToken.value as string;
				invariant(key, "Expected a key");

				const keys = [key];
				this.next();

				// support multiple keys
				while (this.token.type === TOKEN_TYPES.comma) {
					this.next(); // skip comma

					const keyToken = this.token;
					if (keyToken.type !== TOKEN_TYPES.string) {
						this.unexpected("Expected string");
					}

					const key = keyToken.value as string;
					invariant(key, "Expected a key");
					keys.push(key);
					this.next();
				}

				const valToken = this.token;

				if (valToken.type === TOKEN_TYPES.colon) {
					// object
					this.next();

					// parse object
					const val = this.parse(indent + 1);

					for (const key of keys) {
						obj[key] = val;
					}

					if (indent && this.token.type !== TOKEN_TYPES.indent) {
						break;
					}
				} else if (isValidPropValueToken(valToken)) {
					// plain value
					for (const key of keys) {
						obj[key] = valToken.value;
					}

					this.next();
				} else {
					this.unexpected("Invalid value type");
				}
			} else {
				this.unexpected("Unknown token");
			}
		}

		return obj;
	}
}

export function parse(str: string, fileLoc: string = "lockfile"): LockInfo {
	str = stripBOM(str);
	const parser = new Parser(str, fileLoc);
	parser.next();
	return parser.parse();
}
