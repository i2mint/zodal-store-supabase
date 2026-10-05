/**
 * An in-memory stand-in for the slice of `@supabase/supabase-js` this package uses.
 *
 * Unlike a call recorder, it evaluates queries: the PostgREST builder methods the
 * providers call (eq, neq, gt, gte, lt, lte, in, is, like, ilike, contains,
 * overlaps, not, or, order, range, select with count, insert, update, delete,
 * upsert, single, maybeSingle) run against per-table arrays, with SQL's
 * three-valued NULL logic and PostgREST's logic-tree syntax for `.or()` / `.not()`
 * (`and(...)`, `or(...)`, `not.and(...)`, `field.not.op.value`, quoted values,
 * `(a,b)` lists and `{a,b}` arrays). A malformed tree comes back as a PostgREST
 * error (`PGRST100`), the way the server would answer it.
 *
 * Rows are deep-copied in and out, `insert` refuses a duplicate primary key
 * (`23505`), and `single()` errors with `PGRST116` unless exactly one row matches.
 * `storage.from(bucket)` is a minimal object store for the bifurcated provider.
 */

type Row = Record<string, any>;
/** Three-valued: `null` is SQL's UNKNOWN (a comparison with NULL). */
type Tri = boolean | null;
type Pred = (row: Row) => Tri;

export interface MockSupabaseOptions {
  /** Primary-key column (insert assigns it and refuses duplicates). Default: 'id'. */
  primaryKey?: string;
}

export class PostgrestParseError extends Error {}

const clone = <V>(v: V): V => structuredClone(v);

// ---- three-valued logic -------------------------------------------------------

const and3 = (vals: Tri[]): Tri => (vals.includes(false) ? false : vals.includes(null) ? null : true);
const or3 = (vals: Tri[]): Tri => (vals.includes(true) ? true : vals.includes(null) ? null : false);
const not3 = (v: Tri): Tri => (v === null ? null : !v);

// ---- leaf evaluation ----------------------------------------------------------

/** Coerce a value parsed from a query string to the type of the column value. */
function coerce(v: unknown, like: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (typeof like === 'number') return Number(v);
  if (typeof like === 'boolean') return v === 'true';
  return v;
}

function likeRegex(pattern: string, flags: string): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%' || ch === '*') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, flags);
}

/** `{a,"b,c"}` (a PostgreSQL array literal) or a JS array, as a JS array. */
function arrayValue(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const s = String(v);
  if (!s.startsWith('{') || !s.endsWith('}')) throw new PostgrestParseError(`expected an array literal, got ${s}`);
  const p = new Parser(s.slice(1, -1));
  const out: string[] = [];
  if (p.done()) return out;
  for (;;) {
    out.push(p.peek() === '"' ? p.quoted() : p.until(','));
    if (p.done()) return out;
    p.expect(',');
  }
}

/** One condition: `op` is a PostgREST operator, `value` typed (builder) or a string (parsed). */
function leaf(field: string, op: string, value: unknown): Pred {
  return (row) => {
    const cell = row[field];
    if (op === 'is') {
      const v = value === null ? 'null' : String(value);
      if (v === 'null') return cell == null;
      if (v === 'true') return cell === true;
      if (v === 'false') return cell === false;
      throw new PostgrestParseError(`is.${v}`);
    }
    if (cell == null) return null;
    switch (op) {
      case 'eq': return cell === coerce(value, cell);
      case 'neq': return cell !== coerce(value, cell);
      case 'gt': return cell > (coerce(value, cell) as any);
      case 'gte': return cell >= (coerce(value, cell) as any);
      case 'lt': return cell < (coerce(value, cell) as any);
      case 'lte': return cell <= (coerce(value, cell) as any);
      case 'like': return likeRegex(String(value), '').test(String(cell));
      case 'ilike': return likeRegex(String(value), 'i').test(String(cell));
      case 'in': return (value as unknown[]).some((v) => cell === coerce(v, cell));
      case 'cs': {
        const want = arrayValue(value).map(String);
        return want.every((w) => (cell as unknown[]).some((c) => String(c) === w));
      }
      case 'ov': {
        const want = arrayValue(value).map(String);
        return want.some((w) => (cell as unknown[]).some((c) => String(c) === w));
      }
      default:
        throw new PostgrestParseError(`unknown operator "${op}"`);
    }
  };
}

// ---- PostgREST logic-tree parser ---------------------------------------------

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  done() { return this.i >= this.s.length; }
  peek() { return this.s[this.i]; }
  startsWith(t: string) { return this.s.startsWith(t, this.i); }
  expect(t: string) {
    if (!this.startsWith(t)) throw new PostgrestParseError(`expected "${t}" at ${this.i} in ${this.s}`);
    this.i += t.length;
  }
  until(stops: string): string {
    const start = this.i;
    while (!this.done() && !stops.includes(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i);
  }
  quoted(): string {
    this.expect('"');
    let out = '';
    while (!this.done() && this.peek() !== '"') {
      if (this.peek() === '\\') this.i++;
      out += this.s[this.i++];
    }
    this.expect('"');
    return out;
  }
}

/** A comma-separated list of tree members (the body of `or(...)`). */
function parseMembers(p: Parser, close: string | null): Pred[] {
  const members: Pred[] = [parseMember(p)];
  while (!p.done() && p.peek() === ',') {
    p.i++;
    members.push(parseMember(p));
  }
  if (close) p.expect(close);
  else if (!p.done()) throw new PostgrestParseError(`unexpected "${p.s.slice(p.i)}"`);
  return members;
}

function parseMember(p: Parser): Pred {
  for (const [prefix, neg, combine] of [
    ['not.and(', true, and3], ['not.or(', true, or3], ['and(', false, and3], ['or(', false, or3],
  ] as const) {
    if (p.startsWith(prefix)) {
      p.i += prefix.length;
      const members = parseMembers(p, ')');
      return (row) => {
        const v = combine(members.map((m) => m(row)));
        return neg ? not3(v) : v;
      };
    }
  }
  const field = p.until('.');
  p.expect('.');
  let negate = false;
  if (p.startsWith('not.')) {
    negate = true;
    p.i += 4;
  }
  const op = p.until('.');
  p.expect('.');
  const pred = leaf(field, op, parseValue(p, op));
  return negate ? (row) => not3(pred(row)) : pred;
}

function parseValue(p: Parser, op: string): unknown {
  if (op === 'in') {
    p.expect('(');
    const out: string[] = [];
    if (p.peek() !== ')') {
      for (;;) {
        out.push(p.peek() === '"' ? p.quoted() : p.until(',)'));
        if (p.peek() !== ',') break;
        p.i++;
      }
    }
    p.expect(')');
    return out;
  }
  if (p.peek() === '"') return p.quoted();
  if (p.peek() === '{') {
    const start = p.i;
    p.until('}');
    p.expect('}');
    return p.s.slice(start, p.i);
  }
  return p.until(',)');
}

/** A whole `.or()` argument, `a.eq.1,and(b.gt.2,c.lt.3)`, as one predicate (OR of members). */
export function parseOrClause(clause: string): Pred {
  const members = parseMembers(new Parser(clause), null);
  return (row) => or3(members.map((m) => m(row)));
}

/** The value argument of `.not(column, op, value)`, in PostgREST syntax. */
function parseNotValue(op: string, value: unknown): unknown {
  if (value === null || typeof value !== 'string') return value;
  return parseValue(new Parser(value), op);
}

// ---- the client ----------------------------------------------------------------

export function createMockSupabaseClient(
  initial: Record<string, Row[]> = {},
  options: MockSupabaseOptions = {},
) {
  const pk = options.primaryKey ?? 'id';
  const tables = new Map<string, Row[]>(Object.entries(initial).map(([t, rows]) => [t, clone(rows)]));
  const rowsOf = (table: string) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  let nextId = 1;
  const freshId = (rows: Row[]) => {
    let id: string;
    do id = String(nextId++); while (rows.some((r) => String(r[pk]) === id));
    return id;
  };

  function builder(table: string) {
    type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
    let op: Op = 'select';
    let payload: any;
    let returning = false;
    let count = false;
    let single: 'one' | 'maybe' | null = null;
    let range: [number, number] | null = null;
    const orders: { column: string; ascending: boolean }[] = [];
    const filters: (() => Pred)[] = []; // built lazily, so a parse error becomes a response error

    const where = (make: () => Pred) => {
      filters.push(make);
      return b;
    };

    function run(): { data: any; error: any; count?: number | null } {
      let preds: Pred[];
      try {
        preds = filters.map((f) => f());
      } catch (e) {
        if (e instanceof PostgrestParseError) {
          return { data: null, error: { code: 'PGRST100', message: e.message } };
        }
        throw e;
      }
      const rows = rowsOf(table);
      const matches = (r: Row) => and3(preds.map((p) => p(r))) === true;
      let result: Row[];

      switch (op) {
        case 'select':
          result = rows.filter(matches);
          break;
        case 'insert': {
          result = [];
          for (const item of [payload].flat()) {
            const row = clone(item);
            if (row[pk] == null) row[pk] = freshId(rows);
            else if (rows.some((r) => String(r[pk]) === String(row[pk]))) {
              return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${pk}=${row[pk]})` } };
            }
            rows.push(row);
            result.push(row);
          }
          break;
        }
        case 'upsert': {
          result = [];
          for (const item of [payload].flat()) {
            const i = rows.findIndex((r) => String(r[pk]) === String(item[pk]));
            const row = i >= 0 ? { ...rows[i], ...clone(item) } : clone(item);
            if (i >= 0) rows[i] = row;
            else rows.push(row);
            result.push(row);
          }
          break;
        }
        case 'update':
          result = rows.filter(matches);
          for (const r of result) Object.assign(r, clone(payload));
          break;
        case 'delete':
          result = rows.filter(matches);
          tables.set(table, rows.filter((r) => !result.includes(r)));
          break;
      }

      if (op === 'select' && orders.length) {
        result = [...result].sort((a, b) => {
          for (const { column, ascending } of orders) {
            const x = a[column];
            const y = b[column];
            if (x === y) continue;
            // PostgreSQL: NULLS LAST ascending, NULLS FIRST descending.
            const cmp = x == null ? 1 : y == null ? -1 : x < y ? -1 : 1;
            return ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      const total = result.length;
      if (range) result = result.slice(range[0], range[1] + 1);

      const data = op === 'select' || returning ? result.map(clone) : null;
      const counted = count ? total : null;
      if (single && data) {
        if (data.length === 1) return { data: data[0], error: null, count: counted };
        if (data.length === 0 && single === 'maybe') return { data: null, error: null, count: counted };
        return {
          data: null,
          error: { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned (${data.length})` },
        };
      }
      return { data, error: null, count: counted };
    }

    const b: any = {
      select(_columns?: string, opts?: { count?: string }) {
        if (op === 'select') count = Boolean(opts?.count);
        else returning = true;
        return b;
      },
      insert(data: any) { op = 'insert'; payload = data; return b; },
      upsert(data: any) { op = 'upsert'; payload = data; return b; },
      update(data: any) { op = 'update'; payload = data; return b; },
      delete() { op = 'delete'; return b; },

      eq: (f: string, v: unknown) => where(() => leaf(f, 'eq', v)),
      neq: (f: string, v: unknown) => where(() => leaf(f, 'neq', v)),
      gt: (f: string, v: unknown) => where(() => leaf(f, 'gt', v)),
      gte: (f: string, v: unknown) => where(() => leaf(f, 'gte', v)),
      lt: (f: string, v: unknown) => where(() => leaf(f, 'lt', v)),
      lte: (f: string, v: unknown) => where(() => leaf(f, 'lte', v)),
      like: (f: string, v: string) => where(() => leaf(f, 'like', v)),
      ilike: (f: string, v: string) => where(() => leaf(f, 'ilike', v)),
      in: (f: string, v: unknown[]) => where(() => leaf(f, 'in', v)),
      is: (f: string, v: unknown) => where(() => leaf(f, 'is', v)),
      contains: (f: string, v: unknown) => where(() => leaf(f, 'cs', v)),
      overlaps: (f: string, v: unknown) => where(() => leaf(f, 'ov', v)),
      not: (f: string, o: string, v: unknown) =>
        where(() => {
          const pred = leaf(f, o, parseNotValue(o, v));
          return (row) => not3(pred(row));
        }),
      or: (clause: string) => where(() => parseOrClause(clause)),

      order(column: string, opts: { ascending?: boolean } = {}) {
        orders.push({ column, ascending: opts.ascending ?? true });
        return b;
      },
      range(from: number, to: number) { range = [from, to]; return b; },
      single() { single = 'one'; return b; },
      maybeSingle() { single = 'maybe'; return b; },

      then(onFulfilled?: (v: any) => any, onRejected?: (e: any) => any) {
        return new Promise((resolve) => resolve(run())).then(onFulfilled, onRejected);
      },
    };
    return b;
  }

  const objects = new Map<string, unknown>();
  const storage = {
    from(bucket: string) {
      const key = (path: string) => `${bucket}/${path}`;
      return {
        async upload(path: string, body: unknown) {
          objects.set(key(path), body);
          return { data: { path }, error: null };
        },
        async download(path: string) {
          return objects.has(key(path))
            ? { data: objects.get(key(path)), error: null }
            : { data: null, error: { message: 'Object not found' } };
        },
        async remove(paths: string[]) {
          for (const p of paths) objects.delete(key(p));
          return { data: [], error: null };
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `https://mock.supabase.local/storage/v1/object/public/${key(path)}` } };
        },
      };
    },
  };

  return {
    from: (table: string) => builder(table),
    storage,
    /** The current rows of a table (copies). */
    rows: (table: string) => clone(rowsOf(table)),
  };
}
