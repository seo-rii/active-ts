import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MemoryCacheAdapter,
	MemoryStoreAdapter,
	Model,
	createActiveTs,
	createCodecCacheAdapter,
	createFunctionCache,
	defineModel
} from '../src/index.js';
import type { CacheAdapter, CacheVersionedEntry } from '../src/index.js';
import { createRedisValkeyCacheAdapter } from '../src/adapters/cache/redis-valkey.js';
import { createPostgresStoreAdapter } from '../src/adapters/store/postgresql.js';
import { createFirestoreStoreAdapter } from '../src/adapters/store/firestore.js';
import {
	normalizeCacheVersionedEntries,
	normalizeCacheVersionedSetResult,
	normalizeCacheVersionedValues
} from '../src/core/cache-versioning.js';
import { cacheAdapterSource } from '../src/core/cache-utils.js';
import { storeAdapterSource } from '../src/core/store-utils.js';

type SharedEpochData = {
	id: number;
	value: string;
};

class SharedEpochRecord extends Model<SharedEpochData> {}
class DistributedEpochRecord extends Model<SharedEpochData> {}

defineModel<SharedEpochData>({
	name: 'shared_epoch_record',
	cache: { ttl: 60 }
})
	.id('id')
	.validate((input) => input as SharedEpochData)
	.attach(SharedEpochRecord);

defineModel<SharedEpochData>({
	name: 'distributed_epoch_record',
	cache: { ttl: 60, consistency: 'distributed' }
})
	.id('id')
	.validate((input) => input as SharedEpochData)
	.attach(DistributedEpochRecord);

type SharedVersionedBackend = {
	values: Map<string, unknown>;
	versions: Map<string, number>;
};

class SharedVersionedCache implements CacheAdapter {
	readonly kind = 'shared-versioned';
	setManyCalls = 0;
	setManyVersionedCalls = 0;
	invalidateManyCalls = 0;

	constructor(protected readonly backend: SharedVersionedBackend) {}

	async getMany(keys: string[]) {
		return keys.map((key) => structuredClone(this.backend.values.get(key)));
	}

	async setMany(entries: Array<[string, unknown]>) {
		this.setManyCalls++;
		for (const [key, value] of entries) {
			this.backend.versions.set(key, (this.backend.versions.get(key) ?? 0) + 1);
			this.backend.values.set(key, structuredClone(value));
		}
	}

	async deleteMany(keys: string[]) {
		for (const key of keys) {
			this.backend.versions.set(key, (this.backend.versions.get(key) ?? 0) + 1);
			this.backend.values.delete(key);
		}
	}

	async getManyVersioned(keys: string[]) {
		return keys.map((key) => ({
			value: structuredClone(this.backend.values.get(key)),
			version: String(this.backend.versions.get(key) ?? 0)
		}));
	}

	async setManyVersioned(entries: CacheVersionedEntry[]) {
		this.setManyVersionedCalls++;
		return entries.map(([key, value, version]) => {
			if (String(this.backend.versions.get(key) ?? 0) !== version) return false;
			this.backend.values.set(key, structuredClone(value));
			return true;
		});
	}

	async invalidateMany(keys: string[]) {
		this.invalidateManyCalls++;
		for (const key of keys) {
			this.backend.versions.set(key, (this.backend.versions.get(key) ?? 0) + 1);
			this.backend.values.delete(key);
		}
	}
}

type FakeRedisEntry = { value: string | Buffer; expiresAt?: number };
type FakeRedisLuaValue = string | Buffer | number | boolean | FakeRedisLuaValue[];
type FakeRedisLuaToken =
	| { type: 'ident'; value: string }
	| { type: 'string'; value: string }
	| { type: 'number'; value: number }
	| { type: 'op'; value: string };
type FakeRedisLuaExpr =
	| { kind: 'literal'; value: string | number | boolean }
	| { kind: 'var'; name: string }
	| { kind: 'index'; target: 'KEYS' | 'ARGV'; index: FakeRedisLuaExpr }
	| { kind: 'call'; args: FakeRedisLuaExpr[] }
	| { kind: 'table'; items: FakeRedisLuaExpr[] }
	| { kind: 'unary'; op: 'not' | '-'; operand: FakeRedisLuaExpr }
	| { kind: 'binary'; op: 'and' | '==' | '~=' | '<' | '<=' | '>' | '>=' | '..'; left: FakeRedisLuaExpr; right: FakeRedisLuaExpr };
type FakeRedisLuaStmt =
	| { kind: 'local'; name: string; expr: FakeRedisLuaExpr }
	| { kind: 'assign'; name: string; expr: FakeRedisLuaExpr }
	| { kind: 'if'; branches: Array<{ condition: FakeRedisLuaExpr; body: FakeRedisLuaStmt[] }>; elseBody?: FakeRedisLuaStmt[] }
	| { kind: 'return'; expr: FakeRedisLuaExpr }
	| { kind: 'expr'; expr: FakeRedisLuaExpr };

function tokenizeFakeRedisLua(script: string): FakeRedisLuaToken[] {
	const tokens: FakeRedisLuaToken[] = [];
	let index = 0;
	while (index < script.length) {
		const ch = script[index];
		if (/\s/.test(ch)) {
			index++;
			continue;
		}
		if (ch === "'") {
			let value = '';
			index++;
			while (index < script.length && script[index] !== "'") {
				if (script[index] === '\\' && index + 1 < script.length) {
					index++;
				}
				value += script[index++];
			}
			if (script[index] !== "'") throw new Error('Unterminated Lua string literal.');
			index++;
			tokens.push({ type: 'string', value });
			continue;
		}
		if (/[0-9]/.test(ch)) {
			let end = index + 1;
			while (end < script.length && /[0-9]/.test(script[end])) end++;
			tokens.push({ type: 'number', value: Number(script.slice(index, end)) });
			index = end;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let end = index + 1;
			while (end < script.length && /[A-Za-z0-9_]/.test(script[end])) end++;
			tokens.push({ type: 'ident', value: script.slice(index, end) });
			index = end;
			continue;
		}
		const two = script.slice(index, index + 2);
		if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '..') {
			tokens.push({ type: 'op', value: two });
			index += 2;
			continue;
		}
		if ('=<>-()[]{},.'.includes(ch)) {
			tokens.push({ type: 'op', value: ch });
			index++;
			continue;
		}
		throw new Error(`Unexpected Lua token near: ${script.slice(index, index + 20)}`);
	}
	return tokens;
}

function parseFakeRedisLua(script: string): FakeRedisLuaStmt[] {
	const tokens = tokenizeFakeRedisLua(script);
	let pos = 0;
	const peek = (offset = 0) => tokens[pos + offset];
	const next = () => tokens[pos++];
	const matchIdent = (word: string) => {
		const token = peek();
		if (token?.type === 'ident' && token.value === word) {
			pos++;
			return true;
		}
		return false;
	};
	const expectIdent = (word: string) => {
		if (!matchIdent(word)) throw new Error(`Expected Lua keyword "${word}".`);
	};
	const matchOp = (op: string) => {
		const token = peek();
		if (token?.type === 'op' && token.value === op) {
			pos++;
			return true;
		}
		return false;
	};
	const expectOp = (op: string) => {
		if (!matchOp(op)) throw new Error(`Expected Lua operator "${op}".`);
	};
	const parseBlock = (stopWords: readonly string[]): FakeRedisLuaStmt[] => {
		const statements: FakeRedisLuaStmt[] = [];
		while (pos < tokens.length) {
			const token = peek();
			if (token?.type === 'ident' && stopWords.includes(token.value)) break;
			statements.push(parseStatement());
		}
		return statements;
	};
	const parseStatement = (): FakeRedisLuaStmt => {
		if (matchIdent('local')) {
			const name = next();
			if (name?.type !== 'ident') throw new Error('Expected identifier after local.');
			expectOp('=');
			return { kind: 'local', name: name.value, expr: parseExpr() };
		}
		if (matchIdent('if')) {
			const branches: Array<{ condition: FakeRedisLuaExpr; body: FakeRedisLuaStmt[] }> = [];
			const condition = parseExpr();
			expectIdent('then');
			branches.push({ condition, body: parseBlock(['elseif', 'else', 'end']) });
			while (matchIdent('elseif')) {
				const branchCondition = parseExpr();
				expectIdent('then');
				branches.push({ condition: branchCondition, body: parseBlock(['elseif', 'else', 'end']) });
			}
			let elseBody: FakeRedisLuaStmt[] | undefined;
			if (matchIdent('else')) {
				elseBody = parseBlock(['end']);
			}
			expectIdent('end');
			return { kind: 'if', branches, elseBody };
		}
		if (matchIdent('return')) {
			return { kind: 'return', expr: parseExpr() };
		}
		if (peek()?.type === 'ident' && peek(1)?.type === 'op' && peek(1)?.value === '=') {
			const name = (next() as { type: 'ident'; value: string }).value;
			expectOp('=');
			return { kind: 'assign', name, expr: parseExpr() };
		}
		return { kind: 'expr', expr: parseExpr() };
	};
	const parseExpr = (): FakeRedisLuaExpr => parseAnd();
	const parseAnd = (): FakeRedisLuaExpr => {
		let left = parseComparison();
		while (matchIdent('and')) {
			left = { kind: 'binary', op: 'and', left, right: parseComparison() };
		}
		return left;
	};
	const parseComparison = (): FakeRedisLuaExpr => {
		let left = parseConcat();
		const token = peek();
		if (token?.type === 'op' && (token.value === '==' || token.value === '~=' || token.value === '<' || token.value === '<=' || token.value === '>' || token.value === '>=')) {
			next();
			left = { kind: 'binary', op: token.value as '==' | '~=' | '<' | '<=' | '>' | '>=', left, right: parseConcat() };
		}
		return left;
	};
	const parseConcat = (): FakeRedisLuaExpr => {
		let left = parseUnary();
		while (matchOp('..')) {
			left = { kind: 'binary', op: '..', left, right: parseUnary() };
		}
		return left;
	};
	const parseUnary = (): FakeRedisLuaExpr => {
		if (matchIdent('not')) return { kind: 'unary', op: 'not', operand: parseUnary() };
		if (matchOp('-')) return { kind: 'unary', op: '-', operand: parseUnary() };
		return parsePrimary();
	};
	const parsePrimary = (): FakeRedisLuaExpr => {
		const token = next();
		if (!token) throw new Error('Unexpected end of Lua script.');
		if (token.type === 'string' || token.type === 'number') {
			return { kind: 'literal', value: token.value };
		}
		if (token.type === 'op' && token.value === '{') {
			const items: FakeRedisLuaExpr[] = [];
			if (!matchOp('}')) {
				do {
					items.push(parseExpr());
				} while (matchOp(','));
				expectOp('}');
			}
			return { kind: 'table', items };
		}
		if (token.type === 'ident') {
			if (token.value === 'true') return { kind: 'literal', value: true };
			if (token.value === 'false') return { kind: 'literal', value: false };
			if ((token.value === 'KEYS' || token.value === 'ARGV') && matchOp('[')) {
				const index = parseExpr();
				expectOp(']');
				return { kind: 'index', target: token.value, index };
			}
			if (token.value === 'redis' && matchOp('.')) {
				expectIdent('call');
				expectOp('(');
				const args: FakeRedisLuaExpr[] = [];
				if (!matchOp(')')) {
					do {
						args.push(parseExpr());
					} while (matchOp(','));
					expectOp(')');
				}
				return { kind: 'call', args };
			}
			return { kind: 'var', name: token.value };
		}
		throw new Error(`Unexpected Lua primary token: ${JSON.stringify(token)}`);
	};
	const body = parseBlock([]);
	if (pos !== tokens.length) throw new Error('Unparsed trailing Lua tokens.');
	return body;
}

function luaTruthy(value: FakeRedisLuaValue | undefined): boolean {
	return value !== false && value !== undefined;
}

function luaText(value: FakeRedisLuaValue | undefined): string {
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	return String(value ?? '');
}

function luaEquals(left: FakeRedisLuaValue | undefined, right: FakeRedisLuaValue | undefined): boolean {
	if (typeof left === 'number' && typeof right === 'number') return left === right;
	if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
	if ((typeof left === 'string' || Buffer.isBuffer(left)) && (typeof right === 'string' || Buffer.isBuffer(right))) {
		return luaText(left) === luaText(right);
	}
	return left === right;
}

class FakeEvalRedisClient {
	readonly entries = new Map<string, FakeRedisEntry>();
	readonly evalCalls: Array<{ script: string; keys: string[]; arguments: Array<string | Buffer> }> = [];
	readonly redisCalls: Array<{ command: string; args: Array<string | Buffer | number> }> = [];
	onPttl?: (key: string, defaultPttl: number) => number;
	private now = 1_000;

	currentTime() {
		return this.now;
	}

	advance(milliseconds: number) {
		this.now += milliseconds;
	}

	async mGet(keys: string[]) {
		return keys.map((key) => this.read(key));
	}

	async mSet(entries: Array<string | Buffer>) {
		for (let index = 0; index < entries.length; index += 2) {
			this.entries.set(String(entries[index]), { value: entries[index + 1] });
		}
		return 'OK';
	}

	multi() {
		const writes: Array<{ key: string; value: string | Buffer; ttl?: number }> = [];
		return {
			set: (key: string, value: string | Buffer, options?: { EX?: number }) => {
				writes.push({ key, value, ttl: options?.EX });
				return this;
			},
			exec: async () => {
				for (const write of writes) this.write(write.key, write.value, write.ttl);
				return writes.map(() => 'OK');
			}
		};
	}

	async del(keys: string[]) {
		let deleted = 0;
		for (const key of keys) {
			if (this.entries.delete(key)) deleted++;
		}
		return deleted;
	}

	async eval(script: string, options: { keys: string[]; arguments: Array<string | Buffer> }) {
		this.evalCalls.push({ script, keys: [...options.keys], arguments: [...options.arguments] });
		const ast = parseFakeRedisLua(script);
		const scopes: Array<Map<string, FakeRedisLuaValue>> = [new Map()];
		const lookup = (name: string): FakeRedisLuaValue => {
			for (let index = scopes.length - 1; index >= 0; index--) {
				if (scopes[index].has(name)) return scopes[index].get(name)!;
			}
			return false;
		};
		const assign = (name: string, value: FakeRedisLuaValue) => {
			for (let index = scopes.length - 1; index >= 0; index--) {
				if (scopes[index].has(name)) {
					scopes[index].set(name, value);
					return;
				}
			}
			scopes[0].set(name, value);
		};
		const evalExpr = (expr: FakeRedisLuaExpr): FakeRedisLuaValue => {
			switch (expr.kind) {
				case 'literal':
					return expr.value;
				case 'var':
					return lookup(expr.name);
				case 'index': {
					const idx = Number(evalExpr(expr.index)) - 1;
					const list = expr.target === 'KEYS' ? options.keys : options.arguments;
					return list[idx] ?? false;
				}
				case 'table':
					return expr.items.map((item) => evalExpr(item));
				case 'unary': {
					const value = evalExpr(expr.operand);
					return expr.op === 'not' ? !luaTruthy(value) : -Number(value);
				}
				case 'binary': {
					const left = evalExpr(expr.left);
					if (expr.op === 'and') return luaTruthy(left) ? evalExpr(expr.right) : left;
					const right = evalExpr(expr.right);
					switch (expr.op) {
						case '==': return luaEquals(left, right);
						case '~=': return !luaEquals(left, right);
						case '<': return Number(left) < Number(right);
						case '<=': return Number(left) <= Number(right);
						case '>': return Number(left) > Number(right);
						case '>=': return Number(left) >= Number(right);
						case '..': return `${luaText(left)}${luaText(right)}`;
					}
				}
				case 'call': {
					const evaluated = expr.args.map((arg) => evalExpr(arg));
					const command = luaText(evaluated[0]).toUpperCase();
					return this.executeRedisCommand(command, evaluated.slice(1) as Array<string | Buffer | number>);
				}
			}
		};
		const execBlock = (statements: FakeRedisLuaStmt[]): { returned: boolean; value?: FakeRedisLuaValue } => {
			scopes.push(new Map());
			try {
				for (const stmt of statements) {
					switch (stmt.kind) {
						case 'local':
							scopes[scopes.length - 1].set(stmt.name, evalExpr(stmt.expr));
							break;
						case 'assign':
							assign(stmt.name, evalExpr(stmt.expr));
							break;
						case 'expr':
							evalExpr(stmt.expr);
							break;
						case 'return':
							return { returned: true, value: evalExpr(stmt.expr) };
						case 'if': {
							let matched = false;
							for (const branch of stmt.branches) {
								if (luaTruthy(evalExpr(branch.condition))) {
									matched = true;
									const result = execBlock(branch.body);
									if (result.returned) return result;
									break;
								}
							}
							if (!matched && stmt.elseBody) {
								const result = execBlock(stmt.elseBody);
								if (result.returned) return result;
							}
							break;
						}
					}
				}
				return { returned: false };
			} finally {
				scopes.pop();
			}
		};
		const result = execBlock(ast);
		if (!result.returned) return null;
		return this.toNodeRedisReply(result.value!);
	}

	private toNodeRedisReply(value: FakeRedisLuaValue): any {
		if (value === false) return null;
		if (Array.isArray(value)) return value.map((item) => this.toNodeRedisReply(item));
		return value;
	}

	private executeRedisCommand(command: string, args: Array<string | Buffer | number>): FakeRedisLuaValue {
		this.redisCalls.push({ command, args: [...args] });
		switch (command) {
			case 'GET': {
				const value = this.read(luaText(args[0]));
				return value === null ? false : value;
			}
			case 'SET': {
				const key = luaText(args[0]);
				const value = args[1] as string | Buffer;
				if (args.length === 2) {
					this.entries.set(key, { value, expiresAt: undefined });
					return 'OK';
				}
				if (args.length === 4) {
					const unit = luaText(args[2]).toUpperCase();
					const rawTtl = Number(luaText(args[3]));
					if (!Number.isSafeInteger(rawTtl) || rawTtl <= 0) {
						throw new Error("ERR invalid expire time in 'set' command");
					}
					if (unit === 'EX') {
						this.entries.set(key, { value, expiresAt: this.now + rawTtl * 1_000 });
						return 'OK';
					}
					if (unit === 'PX') {
						this.entries.set(key, { value, expiresAt: this.now + rawTtl });
						return 'OK';
					}
				}
				throw new Error(`Unsupported SET arguments: ${JSON.stringify(args)}`);
			}
			case 'PTTL': {
				const key = luaText(args[0]);
				const defaultPttl = this.remainingMilliseconds(key);
				return this.onPttl ? this.onPttl(key, defaultPttl) : defaultPttl;
			}
			case 'TTL': {
				const pttl = this.remainingMilliseconds(luaText(args[0]));
				if (pttl < 0) return pttl;
				return Math.floor(pttl / 1_000);
			}
			case 'PEXPIRE': {
				const key = luaText(args[0]);
				const ms = Number(luaText(args[1]));
				if (this.read(key) === null) return 0;
				if (ms <= 0) {
					this.entries.delete(key);
					return 1;
				}
				this.entries.get(key)!.expiresAt = this.now + ms;
				return 1;
			}
			case 'EXPIRE': {
				const key = luaText(args[0]);
				const seconds = Number(luaText(args[1]));
				if (this.read(key) === null) return 0;
				if (seconds <= 0) {
					this.entries.delete(key);
					return 1;
				}
				this.entries.get(key)!.expiresAt = this.now + seconds * 1_000;
				return 1;
			}
			case 'PERSIST': {
				const key = luaText(args[0]);
				if (this.read(key) === null) return 0;
				const entry = this.entries.get(key)!;
				if (entry.expiresAt === undefined) return 0;
				entry.expiresAt = undefined;
				return 1;
			}
			case 'DEL': {
				const key = luaText(args[0]);
				return this.entries.delete(key) ? 1 : 0;
			}
			default:
				throw new Error(`Unexpected Redis command "${command}".`);
		}
	}

	private read(key: string) {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
			this.entries.delete(key);
			return null;
		}
		return entry.value;
	}

	private write(key: string, value: string | Buffer, ttl?: number) {
		this.entries.set(key, {
			value,
			expiresAt: ttl === undefined ? undefined : this.now + ttl * 1_000
		});
	}

	private remainingMilliseconds(key: string) {
		if (this.read(key) === null) return -2;
		const expiresAt = this.entries.get(key)?.expiresAt;
		return expiresAt === undefined ? -1 : expiresAt - this.now;
	}
}

function redisClusterHashInput(key: string) {
	const start = key.indexOf('{');
	const end = key.indexOf('}', start + 1);
	return start >= 0 && end > start + 1 ? key.slice(start + 1, end) : key;
}

test('independent contexts sharing a cache cannot restore an invalidated stale read', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	let releaseRead!: () => void;
	let markRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markRead = resolve;
	});
	const readMayReturn = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const originalGetMany = store.getMany.bind(store);
	let delayNextRead = true;
	store.getMany = async (model, ids, options) => {
		const rows = await originalGetMany(model, ids, options);
		if (delayNextRead) {
			delayNextRead = false;
			markRead();
			await readMayReturn;
		}
		return rows;
	};

	const firstContext = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const secondContext = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const FirstRecord = SharedEpochRecord.use(firstContext) as unknown as typeof SharedEpochRecord;
	const SecondRecord = SharedEpochRecord.use(secondContext) as unknown as typeof SharedEpochRecord;
	const meta = firstContext.meta(SharedEpochRecord);
	await store.seed(meta, [{ id: 1, value: 'before' }]);

	const staleRead = FirstRecord.find(1).load();
	await readStarted;
	await store.update(meta, 1, { id: 1, value: 'after' });
	await secondContext.invalidate(secondContext.meta(SharedEpochRecord), 1);
	releaseRead();

	assert.equal((await staleRead)?.data.value, 'before');
	assert.deepEqual(cache.snapshot(), {});
	assert.equal((await SecondRecord.find(1).load())?.data.value, 'after');
});

test('independent physical stores cannot alias entity entries in a shared cache', async () => {
	const firstStore = new MemoryStoreAdapter();
	const secondStore = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const firstContext = createActiveTs({ stores: { default: firstStore }, caches: { default: cache } });
	const secondContext = createActiveTs({ stores: { default: secondStore }, caches: { default: cache } });
	const FirstRecord = SharedEpochRecord.use(firstContext) as unknown as typeof SharedEpochRecord;
	const SecondRecord = SharedEpochRecord.use(secondContext) as unknown as typeof SharedEpochRecord;
	await firstStore.seed(firstContext.meta(SharedEpochRecord), [{ id: 2, value: 'first store' }]);
	await secondStore.seed(secondContext.meta(SharedEpochRecord), [{ id: 2, value: 'second store' }]);

	assert.equal((await FirstRecord.find(2).load())?.data.value, 'first store');
	assert.equal((await SecondRecord.find(2).load())?.data.value, 'second store');
	assert.equal(Object.keys(cache.snapshot()).length, 2);
});

test('physical store cache isolation does not depend on matching route names', async () => {
	const firstStore = new MemoryStoreAdapter();
	const secondStore = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	const firstContext = createActiveTs({
		stores: { primary: firstStore },
		caches: { default: cache },
		defaultStore: 'primary'
	});
	const secondContext = createActiveTs({
		stores: { secondary: secondStore },
		caches: { default: cache },
		defaultStore: 'secondary'
	});
	const FirstRecord = SharedEpochRecord.use(firstContext) as unknown as typeof SharedEpochRecord;
	const SecondRecord = SharedEpochRecord.use(secondContext) as unknown as typeof SharedEpochRecord;
	await firstStore.seed(firstContext.meta(SharedEpochRecord), [{ id: 4, value: 'primary store' }]);
	await secondStore.seed(secondContext.meta(SharedEpochRecord), [{ id: 4, value: 'secondary store' }]);

	assert.equal((await FirstRecord.find(4).load())?.data.value, 'primary store');
	assert.equal((await SecondRecord.find(4).load())?.data.value, 'secondary store');
	assert.equal(Object.keys(cache.snapshot()).length, 2);
});

test('generated local store scopes cannot collide with explicit cache scopes', async () => {
	const cache = new MemoryCacheAdapter();
	const primaryStore = new MemoryStoreAdapter();
	const generatedStore = new MemoryStoreAdapter();
	const primaryContext = createActiveTs({ stores: { default: primaryStore }, caches: { default: cache } });
	const generatedContext = createActiveTs({ stores: { default: generatedStore }, caches: { default: cache } });
	const PrimaryRecord = SharedEpochRecord.use(primaryContext) as unknown as typeof SharedEpochRecord;
	const GeneratedRecord = SharedEpochRecord.use(generatedContext) as unknown as typeof SharedEpochRecord;
	await primaryStore.seed(primaryContext.meta(SharedEpochRecord), [{ id: 6, value: 'primary' }]);
	await generatedStore.seed(generatedContext.meta(SharedEpochRecord), [{ id: 6, value: 'generated' }]);
	assert.equal((await PrimaryRecord.find(6).load())?.data.value, 'primary');
	assert.equal((await GeneratedRecord.find(6).load())?.data.value, 'generated');

	const generatedKey = Object.keys(cache.snapshot()).find((key) => key.includes(':local-scope:'));
	assert.ok(generatedKey);
	const generatedScope = /:local-scope:\d+:(local-\d+):/.exec(generatedKey)?.[1];
	assert.ok(generatedScope);
	const explicitStore = new MemoryStoreAdapter({ cacheScope: generatedScope });
	const explicitContext = createActiveTs({ stores: { default: explicitStore }, caches: { default: cache } });
	const ExplicitRecord = SharedEpochRecord.use(explicitContext) as unknown as typeof SharedEpochRecord;
	await explicitStore.seed(explicitContext.meta(SharedEpochRecord), [{ id: 6, value: 'explicit' }]);

	assert.equal((await ExplicitRecord.find(6).load())?.data.value, 'explicit');
	assert.equal(Object.keys(cache.snapshot()).length, 3);
});

test('transaction cache wrappers retain the root physical cache source', async () => {
	const context = createActiveTs({
		stores: { default: new MemoryStoreAdapter() },
		caches: { default: new MemoryCacheAdapter() }
	});
	const rootCache = context.cache('default')!;
	await context.transaction(async (transaction) => {
		assert.equal(
			cacheAdapterSource(transaction.cache('default')!),
			cacheAdapterSource(rootCache)
		);
	});
});

test('transaction non-target stores retain their root physical source', async () => {
	const context = createActiveTs({
		defaultStore: 'primary',
		stores: {
			primary: new MemoryStoreAdapter(),
			secondary: new MemoryStoreAdapter()
		},
		caches: { default: new MemoryCacheAdapter() }
	});
	const rootSecondary = context.store('secondary');
	await context.transaction(async (transaction) => {
		assert.equal(
			storeAdapterSource(transaction.store('secondary')),
			storeAdapterSource(rootSecondary)
		);
	}, { store: 'primary' });
});

test('pruned shared invalidation epochs still fence stale cache backfills', async () => {
	const store = new MemoryStoreAdapter();
	const cache = new MemoryCacheAdapter();
	let releaseRead!: () => void;
	let markRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markRead = resolve;
	});
	const readMayReturn = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const originalGetMany = store.getMany.bind(store);
	store.getMany = async (model, ids, options) => {
		const rows = await originalGetMany(model, ids, options);
		markRead();
		await readMayReturn;
		return rows;
	};
	const context = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const Record = SharedEpochRecord.use(context) as unknown as typeof SharedEpochRecord;
	const meta = context.meta(SharedEpochRecord);
	await store.seed(meta, [{ id: 7, value: 'stale' }]);

	const staleRead = Record.find(7).load();
	await readStarted;
	await context.invalidate(meta, 7);
	for (let id = 10_000; id <= 14_096; id++) await context.invalidate(meta, id);
	releaseRead();

	assert.equal((await staleRead)?.data.value, 'stale');
	assert.equal(cache.snapshot()['shared_epoch_record:number:7'], undefined);
});

test('distributed cache versions reject stale backfills from another adapter instance', async () => {
	const store = new MemoryStoreAdapter({ cacheScope: 'shared-store' });
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const firstCache = new SharedVersionedCache(backend);
	const secondCache = new SharedVersionedCache(backend);
	let releaseRead!: () => void;
	let markRead!: () => void;
	const readStarted = new Promise<void>((resolve) => {
		markRead = resolve;
	});
	const readMayReturn = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	const originalGetMany = store.getMany.bind(store);
	let delayNextRead = true;
	store.getMany = async (model, ids, options) => {
		const rows = await originalGetMany(model, ids, options);
		if (delayNextRead) {
			delayNextRead = false;
			markRead();
			await readMayReturn;
		}
		return rows;
	};

	const firstContext = createActiveTs({ stores: { default: store }, caches: { default: firstCache } });
	const secondContext = createActiveTs({ stores: { default: store }, caches: { default: secondCache } });
	const FirstRecord = DistributedEpochRecord.use(firstContext) as unknown as typeof DistributedEpochRecord;
	const SecondRecord = DistributedEpochRecord.use(secondContext) as unknown as typeof DistributedEpochRecord;
	const meta = firstContext.meta(DistributedEpochRecord);
	await store.seed(meta, [{ id: 3, value: 'before' }]);

	const staleRead = FirstRecord.find(3).load();
	await readStarted;
	await store.update(meta, 3, { id: 3, value: 'after' });
	await secondContext.invalidate(secondContext.meta(DistributedEpochRecord), 3);
	releaseRead();

	assert.equal((await staleRead)?.data.value, 'before');
	assert.equal(backend.values.size, 0);
	assert.equal((await SecondRecord.find(3).load())?.data.value, 'after');
});

test('distributed cache configuration fails before a durable model write', async () => {
	const store = new MemoryStoreAdapter();
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const context = createActiveTs({
		stores: { default: store },
		caches: { default: new SharedVersionedCache(backend) }
	});
	const Record = DistributedEpochRecord.use(context) as unknown as typeof DistributedEpochRecord;

	await assert.rejects(
		() => Record.create({ id: 30, value: 'must not commit' }),
		/must expose an explicit cacheScope/
	);
	assert.deepEqual(store.dump('distributed_epoch_record'), []);
});

test('distributed invalidation failures recover through an authoritative CAS backfill', async () => {
	class RecoveringVersionedCache extends SharedVersionedCache {
		failInvalidation = true;

		override async invalidateMany(keys: string[]) {
			if (this.failInvalidation) {
				this.failInvalidation = false;
				throw new Error('temporary invalidation failure');
			}
			await super.invalidateMany(keys);
		}
	}

	const store = new MemoryStoreAdapter({ cacheScope: 'recovery-store' });
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const cache = new RecoveringVersionedCache(backend);
	const context = createActiveTs({ stores: { default: store }, caches: { default: cache } });
	const Record = DistributedEpochRecord.use(context) as unknown as typeof DistributedEpochRecord;
	const meta = context.meta(DistributedEpochRecord);
	const key = 'store:7:default:scope:14:recovery-store:distributed_epoch_record:number:31';
	await store.seed(meta, [{ id: 31, value: 'authoritative' }]);
	backend.values.set(key, { id: 31, value: 'stale' });

	await assert.rejects(() => context.invalidate(meta, 31), /temporary invalidation failure/);
	assert.equal((await Record.find(31).load())?.data.value, 'authoritative');
	assert.equal(store.stats.getMany, 1);
	assert.equal((await Record.find(31).load())?.data.value, 'authoritative');
	assert.equal(store.stats.getMany, 1);
	assert.deepEqual(backend.values.get(key), { id: 31, value: 'authoritative' });
});

test('distributed function caches reject stale factories across adapter instances', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	let source = 'before';
	let releaseFactory!: () => void;
	let markFactory!: () => void;
	const factoryStarted = new Promise<void>((resolve) => {
		markFactory = resolve;
	});
	const factoryMayReturn = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const first = createFunctionCache<number, string>({
		prefix: 'distributed-function',
		cache: new SharedVersionedCache(backend),
		consistency: 'distributed',
		memory: false,
		factory: async () => {
			const value = source;
			markFactory();
			await factoryMayReturn;
			return value;
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'distributed-function',
		cache: new SharedVersionedCache(backend),
		consistency: 'distributed',
		memory: false,
		factory: async () => source
	});

	const stale = first.get(1);
	await factoryStarted;
	source = 'after';
	await second.invalidate(1);
	releaseFactory();

	assert.equal(await stale, 'before');
	assert.equal(backend.values.size, 0);
	assert.equal(await second.get(1), 'after');
});

test('distributed function cache explicit set fences an older factory without invalidate-read races', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	let releaseFactory!: () => void;
	let markFactory!: () => void;
	const factoryStarted = new Promise<void>((resolve) => {
		markFactory = resolve;
	});
	const factoryMayReturn = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const firstAdapter = new SharedVersionedCache(backend);
	const secondAdapter = new SharedVersionedCache(backend);
	const first = createFunctionCache<number, string>({
		prefix: 'distributed-explicit-set',
		cache: firstAdapter,
		consistency: 'distributed',
		memory: false,
		factory: async () => {
			markFactory();
			await factoryMayReturn;
			return 'stale';
		}
	});
	const second = createFunctionCache<number, string>({
		prefix: 'distributed-explicit-set',
		cache: secondAdapter,
		consistency: 'distributed',
		memory: false,
		factory: async () => 'unused'
	});

	const stale = first.get(1);
	await factoryStarted;
	await second.set(1, 'authoritative');
	releaseFactory();

	assert.equal(await stale, 'stale');
	assert.equal(await second.peek(1), 'authoritative');
	assert.equal(secondAdapter.invalidateManyCalls, 0);
	assert.equal(secondAdapter.setManyCalls, 1);
	assert.equal(firstAdapter.setManyVersionedCalls, 0);
});

test('distributed function cache does not treat a missing read version as an authoritative write', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	let releaseInvalidation!: () => void;
	let markInvalidation!: () => void;
	const invalidationStarted = new Promise<void>((resolve) => {
		markInvalidation = resolve;
	});
	const invalidationMayFinish = new Promise<void>((resolve) => {
		releaseInvalidation = resolve;
	});
	class BlockingInvalidationCache extends SharedVersionedCache {
		override async invalidateMany(keys: string[]) {
			markInvalidation();
			await invalidationMayFinish;
			await super.invalidateMany(keys);
		}
	}
	const invalidator = createFunctionCache<number, string>({
		prefix: 'distributed-pending-invalidation',
		cache: new BlockingInvalidationCache(backend),
		consistency: 'distributed',
		memory: false,
		factory: async () => 'unused'
	});
	const readerAdapter = new SharedVersionedCache(backend);
	const reader = createFunctionCache<number, string>({
		prefix: 'distributed-pending-invalidation',
		cache: readerAdapter,
		consistency: 'distributed',
		memory: false,
		factory: async () => 'computed'
	});

	const invalidation = invalidator.invalidate(1);
	await invalidationStarted;
	assert.equal(await reader.get(1), 'computed');
	assert.equal(readerAdapter.setManyCalls, 0);
	assert.equal(readerAdapter.setManyVersionedCalls, 0);
	releaseInvalidation();
	await invalidation;
});

test('Redis versioned cache mixes ordinary writes and deletes without reopening stale CAS', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'coherence' });
	assert.ok(cache.getManyVersioned && cache.setManyVersioned && cache.invalidateMany);

	const initial = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(initial.value, undefined);
	await cache.setMany([['entry', { value: 'fresh' }]], { ttl: 2 });
	const afterSet = (await cache.getManyVersioned(['entry']))[0];
	assert.deepEqual(afterSet.value, { value: 'fresh' });
	assert.notEqual(afterSet.version, initial.version);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale' }, initial.version]]), [false]);

	client.advance(2_000);
	const expired = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(expired.value, undefined);
	assert.notEqual(expired.version, afterSet.version);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'expired stale' }, afterSet.version]]), [false]);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'refreshed' }, expired.version]]), [true]);

	await cache.deleteMany(['entry']);
	const afterDelete = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(afterDelete.value, undefined);
	assert.notEqual(afterDelete.version, expired.version);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale again' }, expired.version]]), [false]);
	for (const call of client.evalCalls) {
		assert.equal(call.keys.length, 2);
		assert.equal(redisClusterHashInput(call.keys[0]), redisClusterHashInput(call.keys[1]));
	}
});

test('Redis version tombstone expiry rejects an old CAS token and initializes a new fence', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'bounded' });
	assert.ok(cache.getManyVersioned && cache.setManyVersioned);

	const missing = (await cache.getManyVersioned(['entry']))[0];
	client.advance(24 * 60 * 60 * 1_000 + 1);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale' }, missing.version]]), [false]);

	const afterExpiry = (await cache.getManyVersioned(['entry']))[0];
	assert.equal(afterExpiry.value, undefined);
	assert.notEqual(afterExpiry.version, missing.version);
	assert.deepEqual(await cache.getMany(['entry']), [undefined]);
});

test('Redis versioning preserves legacy value keys and hashes version keys with the exact value key', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'legacy' });
	const valueKey = `active-ts:${Buffer.from('legacy').toString('base64url')}:${Buffer.from('entry').toString('base64url')}`;

	assert.equal(cache.codecKey?.('entry'), valueKey);
	await cache.getManyVersioned?.(['entry']);
	const [call] = client.evalCalls;
	assert.equal(call.keys[0], valueKey);
	assert.equal(call.keys[1], `active-ts:version:{${valueKey}}`);
	assert.equal(redisClusterHashInput(call.keys[0]), redisClusterHashInput(call.keys[1]));
});

test('Redis keeps the legacy physical key format when versioning is unavailable', async () => {
	const client = {
		mGet: async () => [],
		mSet: async () => 'OK',
		multi: () => ({ set: () => undefined, exec: async () => [] }),
		del: async () => 0
	};
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'legacy' });
	assert.equal(
		cache.codecKey?.('entry'),
		`active-ts:${Buffer.from('legacy').toString('base64url')}:${Buffer.from('entry').toString('base64url')}`
	);
	assert.equal(cache.getManyVersioned, undefined);
});

for (const ttl of [undefined, 60] as const) {
	test(`Redis VERSIONED_SET_SCRIPT rotates version on CAS success (${ttl === undefined ? 'no ttl' : 'with ttl'}) to prevent concurrent overwrites`, async () => {
		const client = new FakeEvalRedisClient();
		const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'cas-rotate' });
		assert.ok(cache.getManyVersioned && cache.setManyVersioned);

		// Two concurrent writers read the same missing key and receive the same fence version.
		const [writerARead] = await cache.getManyVersioned(['entry']);
		const [writerBRead] = await cache.getManyVersioned(['entry']);
		assert.equal(writerARead.value, undefined);
		assert.equal(writerBRead.version, writerARead.version);

		const options = ttl === undefined ? {} : { ttl };
		assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'fresh-winner' }, writerARead.version]], options), [true]);

		const [afterWinner] = await cache.getManyVersioned(['entry']);
		assert.deepEqual(afterWinner.value, { value: 'fresh-winner' });
		assert.notEqual(afterWinner.version, writerARead.version);

		// The slower writer holding the original expected version must be rejected.
		assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale-loser' }, writerBRead.version]], options), [false]);
		assert.deepEqual(await cache.getMany(['entry']), [{ value: 'fresh-winner' }]);

		// A subsequent CAS write using the rotated version succeeds and rotates again.
		assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'next-winner' }, afterWinner.version]], options), [true]);
		const [afterNext] = await cache.getManyVersioned(['entry']);
		assert.deepEqual(afterNext.value, { value: 'next-winner' });
		assert.notEqual(afterNext.version, afterWinner.version);
		assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'stale-second' }, afterWinner.version]], options), [false]);
		assert.deepEqual(await cache.getMany(['entry']), [{ value: 'next-winner' }]);
	});
}

test('Redis VERSIONED_SET_SCRIPT appends :rotated if replacement token collides with ARGV[1]', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'cas-collision' });
	assert.ok(cache.getManyVersioned && cache.setManyVersioned);

	const [initial] = await cache.getManyVersioned(['entry']);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'seed' }, initial.version]]), [true]);
	const versionedSetCall = client.evalCalls.find((call) => call.script.includes('if version ~= ARGV[1]'));
	assert.ok(versionedSetCall);
	const [valueKey, versionKey] = versionedSetCall.keys;

	for (const ttlArg of ['', '30']) {
		client.entries.set(versionKey, { value: 'same-token' });
		const firstReply = await client.eval(versionedSetCall.script, {
			keys: [valueKey, versionKey],
			arguments: ['same-token', JSON.stringify({ value: 'winner' }), ttlArg, 'same-token', '86400']
		});
		assert.equal(firstReply, 1);
		assert.equal(client.entries.get(versionKey)?.value, 'same-token:rotated');
		if (ttlArg === '') {
			assert.equal(client.entries.get(versionKey)?.expiresAt, undefined);
		} else {
			assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + 30_000);
		}

		// A second concurrent writer holding 'same-token' must fail now that KEYS[2] rotated.
		const secondReply = await client.eval(versionedSetCall.script, {
			keys: [valueKey, versionKey],
			arguments: ['same-token', JSON.stringify({ value: 'stale-overwrite' }), ttlArg, 'other-token', '86400']
		});
		assert.equal(secondReply, 0);
		assert.equal(client.entries.get(valueKey)?.value, JSON.stringify({ value: 'winner' }));
	}
});

test('Redis distributed function caches prevent a slower concurrent factory from overwriting a fresher backfill', async () => {
	const client = new FakeEvalRedisClient();
	let markSlowStarted!: () => void;
	let releaseSlow!: () => void;
	const slowStarted = new Promise<void>((resolve) => {
		markSlowStarted = resolve;
	});
	const slowMayFinish = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});

	const slow = createFunctionCache<number, string>({
		prefix: 'redis-cas-race',
		cache: await createRedisValkeyCacheAdapter({ client, prefix: 'race' }),
		consistency: 'distributed',
		memory: false,
		ttl: 60,
		factory: async () => {
			markSlowStarted();
			await slowMayFinish;
			return 'stale-slow';
		}
	});
	const fast = createFunctionCache<number, string>({
		prefix: 'redis-cas-race',
		cache: await createRedisValkeyCacheAdapter({ client, prefix: 'race' }),
		consistency: 'distributed',
		memory: false,
		ttl: 60,
		factory: async () => 'fresh-fast'
	});

	const slowPromise = slow.get(1);
	await slowStarted;
	assert.equal(await fast.get(1), 'fresh-fast');
	releaseSlow();
	assert.equal(await slowPromise, 'stale-slow');
	assert.equal(await fast.peek(1), 'fresh-fast');
});

test('Redis VERSIONED_GET_SCRIPT clamps PTTL == 0 to 1ms instead of failing SET PX 0 or deleting via PEXPIRE 0', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'pttl-zero' });
	assert.ok(cache.getManyVersioned && cache.setManyVersioned);
	const valueKey = cache.codecKey!('entry');
	const versionKey = `active-ts:version:{${valueKey}}`;

	// Branch 1: version key missing, value key at PTTL == 0 boundary.
	client.entries.set(valueKey, { value: JSON.stringify({ value: 'boundary-missing-version' }), expiresAt: client.currentTime() + 1 });
	client.onPttl = (key, fallback) => (key === valueKey ? 0 : fallback);

	const [missingVersionRead] = await cache.getManyVersioned(['entry']);
	assert.deepEqual(missingVersionRead.value, { value: 'boundary-missing-version' });
	assert.ok(missingVersionRead.version);
	assert.equal(client.entries.get(versionKey)?.value, missingVersionRead.version);
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + 1);
	const setVersionCall = client.redisCalls.find((call) => call.command === 'SET' && call.args[0] === versionKey);
	assert.deepEqual(setVersionCall, {
		command: 'SET',
		args: [versionKey, missingVersionRead.version, 'PX', 1]
	});

	// Branch 2: version key already exists, value key at PTTL == 0 boundary.
	client.redisCalls.length = 0;
	client.entries.set(versionKey, { value: 'existing-version', expiresAt: client.currentTime() + 5_000 });
	const [existingVersionRead] = await cache.getManyVersioned(['entry']);
	assert.deepEqual(existingVersionRead.value, { value: 'boundary-missing-version' });
	assert.equal(existingVersionRead.version, 'existing-version');
	// Version key must NOT be deleted immediately; it must be clamped to 1ms.
	assert.equal(client.entries.get(versionKey)?.value, 'existing-version');
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + 1);
	const pexpireCall = client.redisCalls.find((call) => call.command === 'PEXPIRE' && call.args[0] === versionKey);
	assert.deepEqual(pexpireCall, {
		command: 'PEXPIRE',
		args: [versionKey, 1]
	});

	// After 1ms elapses, the clamped version key expires cleanly.
	client.onPttl = undefined;
	client.advance(1);
	assert.deepEqual(await cache.setManyVersioned([['entry', { value: 'late' }, 'existing-version']]), [false]);
});

test('Redis VERSIONED_GET_SCRIPT handles PTTL == -2 expiry between GET and PTTL without persisting version keys', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'pttl-missing' });
	assert.ok(cache.getManyVersioned);
	const valueKey = cache.codecKey!('entry');
	const versionKey = `active-ts:version:{${valueKey}}`;
	const tombstoneMs = 24 * 60 * 60 * 1_000;

	const expireOnPttl = (key: string, fallback: number) => {
		if (key !== valueKey) return fallback;
		client.entries.delete(valueKey);
		return -2;
	};

	// Branch 1: version key missing, value key expires between GET and PTTL.
	client.entries.set(valueKey, { value: JSON.stringify({ value: 'vanishing' }), expiresAt: client.currentTime() + 1 });
	client.onPttl = expireOnPttl;
	const [missingVersionRead] = await cache.getManyVersioned(['entry']);
	assert.equal(missingVersionRead.value, undefined);
	assert.ok(missingVersionRead.version);
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + tombstoneMs);
	assert.deepEqual(
		client.redisCalls.find((call) => call.command === 'SET' && call.args[0] === versionKey),
		{ command: 'SET', args: [versionKey, missingVersionRead.version, 'EX', String(24 * 60 * 60)] }
	);

	// Branch 2a: existing persistent version key must be bounded with EXPIRE, not left persistent.
	client.redisCalls.length = 0;
	client.entries.set(valueKey, { value: JSON.stringify({ value: 'vanishing-2' }), expiresAt: client.currentTime() + 1 });
	client.entries.set(versionKey, { value: 'persistent-version', expiresAt: undefined });
	const [persistentVersionRead] = await cache.getManyVersioned(['entry']);
	assert.equal(persistentVersionRead.value, undefined);
	assert.equal(persistentVersionRead.version, 'persistent-version');
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + tombstoneMs);
	assert.equal(client.redisCalls.some((call) => call.command === 'PERSIST'), false);
	assert.deepEqual(
		client.redisCalls.find((call) => call.command === 'EXPIRE' && call.args[0] === versionKey),
		{ command: 'EXPIRE', args: [versionKey, String(24 * 60 * 60)] }
	);

	// Branch 2b: existing version key with finite TTL keeps its finite TTL and is never persisted.
	client.redisCalls.length = 0;
	client.entries.set(valueKey, { value: JSON.stringify({ value: 'vanishing-3' }), expiresAt: client.currentTime() + 1 });
	client.entries.set(versionKey, { value: 'bounded-version', expiresAt: client.currentTime() + 500 });
	const [boundedVersionRead] = await cache.getManyVersioned(['entry']);
	assert.equal(boundedVersionRead.value, undefined);
	assert.equal(boundedVersionRead.version, 'bounded-version');
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + 500);
	assert.equal(client.redisCalls.some((call) => call.command === 'PERSIST'), false);
	assert.equal(client.redisCalls.some((call) => call.command === 'EXPIRE'), false);
});

test('Redis VERSIONED_GET_SCRIPT aligns version TTL for PTTL == -1 persistent keys and positive PTTL keys', async () => {
	const client = new FakeEvalRedisClient();
	const cache = await createRedisValkeyCacheAdapter({ client, prefix: 'pttl-align' });
	assert.ok(cache.getManyVersioned);
	const valueKey = cache.codecKey!('entry');
	const versionKey = `active-ts:version:{${valueKey}}`;

	// Persistent value (PTTL == -1) with missing version -> persistent SET.
	client.entries.set(valueKey, { value: JSON.stringify({ value: 'persistent' }), expiresAt: undefined });
	const [persistentNew] = await cache.getManyVersioned(['entry']);
	assert.deepEqual(persistentNew.value, { value: 'persistent' });
	assert.equal(client.entries.get(versionKey)?.expiresAt, undefined);

	// Persistent value (PTTL == -1) with expiring version -> PERSIST.
	client.redisCalls.length = 0;
	client.entries.set(versionKey, { value: 'expiring-version', expiresAt: client.currentTime() + 5_000 });
	const [persistentExisting] = await cache.getManyVersioned(['entry']);
	assert.equal(persistentExisting.version, 'expiring-version');
	assert.equal(client.entries.get(versionKey)?.expiresAt, undefined);
	assert.deepEqual(
		client.redisCalls.find((call) => call.command === 'PERSIST'),
		{ command: 'PERSIST', args: [versionKey] }
	);

	// Positive PTTL value with missing version -> SET PX valueTtl.
	client.redisCalls.length = 0;
	client.entries.delete(versionKey);
	client.entries.set(valueKey, { value: JSON.stringify({ value: 'expiring' }), expiresAt: client.currentTime() + 4_321 });
	const [positiveNew] = await cache.getManyVersioned(['entry']);
	assert.deepEqual(positiveNew.value, { value: 'expiring' });
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + 4_321);
	assert.deepEqual(
		client.redisCalls.find((call) => call.command === 'SET' && call.args[0] === versionKey),
		{ command: 'SET', args: [versionKey, positiveNew.version, 'PX', 4_321] }
	);

	// Positive PTTL value with existing persistent version -> PEXPIRE valueTtl.
	client.redisCalls.length = 0;
	client.entries.set(versionKey, { value: 'unbounded-version', expiresAt: undefined });
	const [positiveExisting] = await cache.getManyVersioned(['entry']);
	assert.equal(positiveExisting.version, 'unbounded-version');
	assert.equal(client.entries.get(versionKey)?.expiresAt, client.currentTime() + 4_321);
	assert.deepEqual(
		client.redisCalls.find((call) => call.command === 'PEXPIRE'),
		{ command: 'PEXPIRE', args: [versionKey, 4_321] }
	);
});

test('codec cache adapters preserve version snapshots and conditional write results', async () => {
	const backend: SharedVersionedBackend = { values: new Map(), versions: new Map() };
	const cache = createCodecCacheAdapter(new SharedVersionedCache(backend), {
		name: 'tagged',
		encode: (value) => ({ encoded: value }),
		decode: (value: any) => value.encoded
	});
	assert.ok(cache.getManyVersioned && cache.setManyVersioned && cache.invalidateMany);
	const before = (await cache.getManyVersioned(['codec']))[0];
	assert.deepEqual(await cache.setManyVersioned([['codec', { answer: 42 }, before.version]]), [true]);
	assert.deepEqual((await cache.getManyVersioned(['codec']))[0].value, { answer: 42 });
});

test('cache version validators reject extra fields and detach accepted inputs', () => {
	const tuple = ['key', { nested: { value: 1 } }, 'version'] as unknown[];
	Object.defineProperty(tuple, 'map', { value: () => undefined, enumerable: true });
	assert.throws(() => normalizeCacheVersionedEntries([tuple], 'entries'), /non-index array property "map"/);

	const results = [true];
	Object.defineProperty(results, 'filter', { value: () => undefined, enumerable: true });
	assert.throws(() => normalizeCacheVersionedSetResult(results, 1, 'results'), /non-index array property "filter"/);

	const rows = [{ value: { nested: { value: 1 } }, version: 'version' }];
	Object.defineProperty(rows, 'forEach', { value: () => undefined, enumerable: true });
	assert.throws(() => normalizeCacheVersionedValues(rows, 1, 'rows'), /non-index array property "forEach"/);
	assert.throws(
		() => normalizeCacheVersionedValues([{ value: 1, version: 'version', extra: true }], 1, 'rows'),
		/unknown field "extra"/
	);

	const source = { nested: { value: 1 } };
	const normalized = normalizeCacheVersionedEntries([['key', source, 'version']], 'entries');
	source.nested.value = 2;
	assert.equal((normalized[0][1] as typeof source).nested.value, 1);
	assert.throws(
		() => normalizeCacheVersionedValues([{ get value() { return 1; }, version: 'version' }], 1, 'rows'),
		/enumerable data property/
	);
});

test('store cacheScope options are explicit, validated, and absent by default', async () => {
	assert.equal(new MemoryStoreAdapter().cacheScope, undefined);
	assert.equal(new MemoryStoreAdapter({ cacheScope: 'memory:tenant' }).cacheScope, 'memory:tenant');
	assert.throws(() => new MemoryStoreAdapter({ cacheScope: '' }), /cacheScope must be a non-empty string/);
	assert.throws(
		() => new MemoryStoreAdapter({ cacheScope: 'memory:tenant', typo: true } as any),
		/unknown option "typo"/
	);

	const postgres = await createPostgresStoreAdapter({
		pool: { query: async () => ({ rows: [] }) },
		cacheScope: 'postgres:tenant'
	});
	assert.equal(postgres.cacheScope, 'postgres:tenant');
	await assert.rejects(
		() => createPostgresStoreAdapter({ pool: { query: async () => ({ rows: [] }) }, cacheScope: '' }),
		/cacheScope must be a non-empty string/
	);

	const firestoreClient = {
		collection: () => ({}),
		getAll: async () => [],
		runTransaction: async () => undefined
	};
	const firestore = await createFirestoreStoreAdapter({ client: firestoreClient, cacheScope: 'firestore:tenant' });
	assert.equal(firestore.cacheScope, 'firestore:tenant');
	await assert.rejects(
		() => createFirestoreStoreAdapter({ client: firestoreClient, cacheScope: '\0' }),
		/cacheScope must be a non-empty string/
	);
});
