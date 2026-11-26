import { describe, expect, it } from 'vitest';
import type { ExtractResult } from '../../../src/knowledge/extractors/common.ts';
import * as cfamily from '../../../src/knowledge/extractors/cfamily.ts';
import * as config from '../../../src/knowledge/extractors/config.ts';
import * as csharp from '../../../src/knowledge/extractors/csharp.ts';
import * as go from '../../../src/knowledge/extractors/go.ts';
import * as jvm from '../../../src/knowledge/extractors/jvm.ts';
import * as markdown from '../../../src/knowledge/extractors/markdown.ts';
import * as python from '../../../src/knowledge/extractors/python.ts';
import * as rust from '../../../src/knowledge/extractors/rust.ts';
import * as sql from '../../../src/knowledge/extractors/sql.ts';
import * as ts from '../../../src/knowledge/extractors/typescript.ts';
import { detectLanguage } from '../../../src/knowledge/languages.ts';

const exists = (...files: string[]) => ({ fileExists: (rel: string) => files.includes(rel) });
const sym = (r: ExtractResult, name: string) => r.symbols.find((s) => s.name === name);
const edge = (r: ExtractResult, src: string, rel: string, dst: string) => r.edges.find((e) => e.src === src && e.rel === rel && e.dst === dst);

function expectHeuristic(r: ExtractResult): void {
  for (const e of r.edges) {
    expect(e.confidence).toBeGreaterThan(0);
    expect(e.confidence).toBeLessThan(1);
  }
}

describe('all extractors', () => {
  it.each([cfamily, config, csharp, go, jvm, markdown, python, rust, sql, ts])('export an integer PARSER_VERSION', (m) => {
    expect(Number.isInteger(m.PARSER_VERSION)).toBe(true);
    expect(m.PARSER_VERSION).toBeGreaterThan(0);
  });
});

describe('languages', () => {
  it.each([
    ['a.ts', 'typescript'], ['a.tsx', 'tsx'], ['a.mjs', 'javascript'], ['a.cjs', 'javascript'], ['a.jsx', 'jsx'], ['a.py', 'python'],
    ['a.go', 'go'], ['a.rs', 'rust'], ['A.java', 'java'], ['a.kt', 'kotlin'], ['a.h', 'c'], ['a.hpp', 'cpp'], ['a.cc', 'cpp'],
    ['a.cs', 'csharp'], ['a.rb', 'ruby'], ['a.php', 'php'], ['a.sql', 'sql'], ['a.mdx', 'markdown'], ['a.rst', 'rst'], ['a.txt', 'text'],
    ['a.json', 'json'], ['a.yml', 'yaml'], ['a.toml', 'toml'], ['ops/Dockerfile', 'dockerfile'], ['Dockerfile.dev', 'dockerfile'],
    ['main.tf', 'terraform'], ['a.pdf', 'pdf'], ['Makefile', 'other'],
  ])('%s → %s', (rel, lang) => expect(detectLanguage(rel)).toBe(lang));
});

describe('TS/JS extractor', () => {
  const src = `
import { Base, type Shape } from './base';
import * as util from "../lib/util.js";
import express from 'express';
const fs = require('node:fs');
// import { ghost } from './commented';
/* class Hidden {} */

export interface Repo<T> extends Shape, Iterable<T> {
  find(id: string): T;
}
export type Id = string;
export function helper(a: number): number {
  return a;
}
const internal = async (x: number) => x * 2;
export const LIMIT = 10;

export class Service extends Base implements Repo<string> {
  private count = 0;
  constructor(private readonly x: number) { super(); }
  async load(id: string): Promise<void> {
    if (id) { return; }
  }
  handler = (req: unknown) => req;
}

const app = express();
app.get('/health', (req, res) => res.send('ok'));
router.post("/users/:id", handler);
`;
  const r = ts.extract('src/service.ts', src, exists('src/base.ts', 'lib/util.ts'));

  it('extracts declarations with export flags', () => {
    expect(sym(r, 'Repo')).toMatchObject({ kind: 'interface', exported: true });
    expect(sym(r, 'Id')).toMatchObject({ kind: 'type', exported: true });
    expect(sym(r, 'helper')).toMatchObject({ kind: 'function', exported: true, lineStart: 13, lineEnd: 15 });
    expect(sym(r, 'internal')).toMatchObject({ kind: 'function', exported: false });
    expect(sym(r, 'LIMIT')).toMatchObject({ kind: 'variable', exported: true });
    expect(sym(r, 'Service')).toMatchObject({ kind: 'class', exported: true });
    expect(sym(r, 'Service.load')).toMatchObject({ kind: 'method' });
    expect(sym(r, 'Service.handler')).toMatchObject({ kind: 'method' });
    expect(sym(r, 'Hidden')).toBeUndefined();
  });

  it('resolves relative imports to files, others to modules', () => {
    expect(edge(r, 'file:src/service.ts', 'IMPORTS', 'file:src/base.ts')).toBeDefined();
    expect(edge(r, 'file:src/service.ts', 'IMPORTS', 'file:lib/util.ts')).toBeDefined();
    expect(edge(r, 'file:src/service.ts', 'IMPORTS', 'module:express')).toBeDefined();
    expect(edge(r, 'file:src/service.ts', 'IMPORTS', 'module:node:fs')).toBeDefined();
    expect(r.edges.some((e) => e.dst.includes('commented'))).toBe(false);
  });

  it('records extends/implements with resolved targets', () => {
    expect(edge(r, 'symbol:src/service.ts#Service', 'EXTENDS', 'symbol:src/base.ts#Base')).toBeDefined();
    expect(edge(r, 'symbol:src/service.ts#Service', 'IMPLEMENTS', 'symbol:src/service.ts#Repo')).toBeDefined();
    expect(edge(r, 'symbol:src/service.ts#Repo', 'EXTENDS', 'symbol:src/base.ts#Shape')).toBeDefined();
  });

  it('turns Express routes into endpoints', () => {
    expect(sym(r, 'GET /health')).toMatchObject({ kind: 'endpoint' });
    expect(edge(r, 'file:src/service.ts', 'DEFINES', 'endpoint:POST /users/:id')).toBeDefined();
    expectHeuristic(r);
  });

  it('falls back to module refs when nothing resolves', () => {
    const out = ts.extract('a.ts', "import x from './missing';\n");
    expect(out.edges[0]?.dst).toBe('module:./missing');
  });
});

describe('Python extractor', () => {
  const src = `
"""Module docstring mentioning class Fake: and def fake():"""
from fastapi import APIRouter
from .base import Model as BaseModel
from django.db import models
import app.util

router = APIRouter(prefix="/items")

class Item(BaseModel, metaclass=Meta):
    def price(self, qty):
        return qty

    async def _hidden(self):
        pass

@router.get("/{item_id}")
async def read_item(item_id: int):
    return item_id

class Customer(models.Model):
    email = models.CharField(max_length=100)
    account = models.ForeignKey('Account', on_delete=models.CASCADE)

    class Meta:
        db_table = "crm_customer"

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    customer_id = Column(Integer, ForeignKey("customers.customer_id"))
`;
  const r = python.extract('app/items.py', src, exists('app/base.py', 'app/util.py'));

  it('extracts classes, methods and functions', () => {
    expect(sym(r, 'Item')).toMatchObject({ kind: 'class', exported: true });
    expect(sym(r, 'Item.price')).toMatchObject({ kind: 'method', exported: true });
    expect(sym(r, 'Item._hidden')).toMatchObject({ kind: 'method', exported: false });
    expect(sym(r, 'read_item')).toMatchObject({ kind: 'function' });
    expect(sym(r, 'Fake')).toBeUndefined();
  });

  it('resolves imports and base classes', () => {
    expect(edge(r, 'file:app/items.py', 'IMPORTS', 'file:app/base.py')).toBeDefined();
    expect(edge(r, 'file:app/items.py', 'IMPORTS', 'file:app/util.py')).toBeDefined();
    expect(edge(r, 'file:app/items.py', 'IMPORTS', 'module:fastapi')).toBeDefined();
    expect(edge(r, 'symbol:app/items.py#Item', 'EXTENDS', 'symbol:app/base.py#Model')).toBeDefined();
    expect(r.edges.some((e) => e.dst.includes('Meta') && e.rel === 'EXTENDS' && e.src.endsWith('#Item'))).toBe(false);
  });

  it('extracts FastAPI endpoints with router prefix', () => {
    expect(sym(r, 'GET /items/{item_id}')).toMatchObject({ kind: 'endpoint' });
    expect(edge(r, 'file:app/items.py', 'DEFINES', 'endpoint:GET /items/{item_id}')).toBeDefined();
  });

  it('maps Django and SQLAlchemy models to columns with low confidence', () => {
    const dj = edge(r, 'symbol:app/items.py#Customer', 'READS', 'column:crm_customer.email');
    expect(dj?.confidence).toBeLessThanOrEqual(0.6);
    expect(edge(r, 'symbol:app/items.py#Customer', 'READS', 'column:crm_customer.account_id')).toBeDefined();
    expect(edge(r, 'column:crm_customer.account_id', 'REFERENCES', 'table:account')).toBeDefined();
    expect(edge(r, 'symbol:app/items.py#Order', 'READS', 'column:orders.customer_id')).toBeDefined();
    expect(edge(r, 'column:orders.customer_id', 'REFERENCES', 'column:customers.customer_id')).toBeDefined();
    expectHeuristic(r);
  });

  it('extracts Django url patterns and Flask routes', () => {
    const urls = python.extract('app/urls.py', "urlpatterns = [\n    path('customers/<int:pk>/', views.detail),\n]\n");
    expect(sym(urls, 'ANY /customers/<int:pk>/')).toMatchObject({ kind: 'endpoint' });
    const flask = python.extract('app/web.py', "@app.route('/login', methods=['GET', 'POST'])\ndef login():\n    pass\n");
    expect(flask.symbols.filter((s) => s.kind === 'endpoint').map((s) => s.name)).toEqual(['GET /login', 'POST /login']);
  });
});

describe('SQL extractor', () => {
  const src = `
-- CREATE TABLE ghost (id int);
CREATE TABLE IF NOT EXISTS "public"."Customers" (
  customer_id SERIAL PRIMARY KEY,
  email TEXT NOT NULL
);
create table orders (
  id int primary key,
  customer_id int not null references customers(customer_id),
  [shipper_id] int,
  CONSTRAINT fk_ship FOREIGN KEY (shipper_id) REFERENCES \`shippers\` (\`id\`)
);
ALTER TABLE orders ADD COLUMN note TEXT, ADD COLUMN IF NOT EXISTS total NUMERIC(10,2);
ALTER TABLE orders DROP COLUMN legacy;
CREATE UNIQUE INDEX idx_orders_customer ON orders USING btree (customer_id, id DESC);
CREATE OR REPLACE VIEW customer_orders AS SELECT * FROM customers c JOIN orders o ON o.customer_id = c.customer_id;
`;
  const r = sql.extract('db/migrations/002.sql', src);

  it('extracts tables and columns with DEFINES edges', () => {
    expect(sym(r, 'customers')).toMatchObject({ kind: 'table', lineStart: 3, lineEnd: 6 });
    expect(sym(r, 'customers.customer_id')).toMatchObject({ kind: 'column', lineStart: 4 });
    expect(sym(r, 'orders.shipper_id')).toBeDefined();
    expect(sym(r, 'ghost')).toBeUndefined();
    expect(edge(r, 'file:db/migrations/002.sql', 'DEFINES', 'table:customers')).toBeDefined();
    expect(edge(r, 'table:customers', 'DEFINES', 'column:customers.email')).toBeDefined();
  });

  it('extracts inline and table-level foreign keys', () => {
    expect(edge(r, 'column:orders.customer_id', 'REFERENCES', 'column:customers.customer_id')).toBeDefined();
    expect(edge(r, 'column:orders.shipper_id', 'REFERENCES', 'column:shippers.id')).toBeDefined();
  });

  it('records migrations, indexes and views', () => {
    expect(edge(r, 'file:db/migrations/002.sql', 'MIGRATES_TO', 'column:orders.note')).toBeDefined();
    expect(edge(r, 'file:db/migrations/002.sql', 'MIGRATES_TO', 'column:orders.total')).toBeDefined();
    expect(edge(r, 'table:orders', 'DEFINES', 'column:orders.total')).toBeDefined();
    expect(edge(r, 'file:db/migrations/002.sql', 'MIGRATES_TO', 'column:orders.legacy')).toBeDefined();
    expect(edge(r, 'symbol:db/migrations/002.sql#idx_orders_customer', 'REFERENCES', 'column:orders.customer_id')).toBeDefined();
    expect(edge(r, 'symbol:db/migrations/002.sql#idx_orders_customer', 'REFERENCES', 'column:orders.id')).toBeDefined();
    expect(sym(r, 'customer_orders')).toMatchObject({ kind: 'table' });
    expect(edge(r, 'table:customer_orders', 'READS', 'table:customers')).toBeDefined();
    expect(edge(r, 'table:customer_orders', 'READS', 'table:orders')).toBeDefined();
    expectHeuristic(r);
  });

  it('normalizes quoted and qualified identifiers', () => {
    expect(sql.normIdent('"Public"."Customers"')).toBe('customers');
    expect(sql.normIdent('[dbo].[Orders]')).toBe('orders');
    expect(sql.normIdent('`t`')).toBe('t');
  });
});

describe('Markdown / rst extractor', () => {
  const src = [
    '# Guide',
    'See [the schema](../db/schema.sql#L3) and [site](https://example.com).',
    '## Setup',
    '```',
    '# not a heading',
    '[nope](../db/schema.sql)',
    '```',
    '[ref]: ./other.md',
    '### Deep',
    '# Second',
    '[missing](./nope.md)',
  ].join('\n');
  const r = markdown.extract('docs/guide.md', src, exists('db/schema.sql', 'docs/other.md'));

  it('extracts headings with section extents', () => {
    expect(r.symbols.map((s) => s.name)).toEqual(['Guide', 'Setup', 'Deep', 'Second']);
    expect(sym(r, 'Guide')).toMatchObject({ kind: 'heading', lineStart: 1, lineEnd: 9 });
    expect(sym(r, 'Setup')).toMatchObject({ lineStart: 3, lineEnd: 9 });
  });

  it('links to existing repo files only', () => {
    expect(edge(r, 'doc:docs/guide.md', 'DOCUMENTS', 'file:db/schema.sql')).toMatchObject({ line: 2 });
    expect(edge(r, 'doc:docs/guide.md', 'DOCUMENTS', 'file:docs/other.md')).toBeDefined();
    expect(r.edges).toHaveLength(2);
    expectHeuristic(r);
  });

  it('handles rst underline headings and directives', () => {
    const rst = markdown.extract('docs/a.rst', 'Title\n=====\n\nPart\n----\n.. include:: ../README.md\n', exists('README.md'));
    expect(rst.symbols.map((s) => [s.name, s.signature])).toEqual([['Title', '# Title'], ['Part', '## Part']]);
    expect(edge(rst, 'doc:docs/a.rst', 'DOCUMENTS', 'file:README.md')).toBeDefined();
  });
});

describe('Config extractor', () => {
  it('extracts package.json keys and dependencies', () => {
    const pkg = JSON.stringify({ name: 'x', scripts: { build: 'tsc' }, dependencies: { react: '^18' }, devDependencies: { vitest: '^5' } }, null, 2);
    const r = config.extract('package.json', pkg);
    expect(r.symbols.map((s) => s.name)).toEqual(['name', 'scripts', 'dependencies', 'devDependencies']);
    expect(edge(r, 'file:package.json', 'DEPENDS_ON', 'module:react')).toMatchObject({ line: 7 });
    expect(edge(r, 'file:package.json', 'DEPENDS_ON', 'module:vitest')).toBeDefined();
    expect(r.edges.some((e) => e.dst === 'module:build')).toBe(false);
    expectHeuristic(r);
  });

  it('tolerates JSONC comments', () => {
    const r = config.extract('tsconfig.json', '{\n  // "ghost": 1,\n  "compilerOptions": { "strict": true }\n}\n');
    expect(r.symbols.map((s) => s.name)).toEqual(['compilerOptions']);
  });

  it('extracts docker-compose services and connections', () => {
    const yml = 'version: "3"\nservices:\n  web:\n    image: node:22\n    depends_on:\n      - db\n      - cache\n  db:\n    image: postgres:16\n  cache:\n    image: redis\n';
    const r = config.extract('docker-compose.yml', yml);
    expect(r.symbols.filter((s) => s.kind === 'key').map((s) => s.name)).toEqual(['version', 'services']);
    expect(edge(r, 'symbol:docker-compose.yml#web', 'CONNECTS_TO', 'symbol:docker-compose.yml#db')).toBeDefined();
    expect(edge(r, 'symbol:docker-compose.yml#web', 'CONNECTS_TO', 'symbol:docker-compose.yml#cache')).toBeDefined();
    expect(edge(r, 'symbol:docker-compose.yml#db', 'DEPENDS_ON', 'module:postgres:16')).toBeDefined();
  });

  it('extracts Dockerfile base images, skipping stage aliases', () => {
    const r = config.extract('Dockerfile', 'FROM node:22 AS build\nRUN npm ci\nFROM build AS test\nFROM gcr.io/distroless/nodejs22\n');
    expect(r.edges.map((e) => e.dst)).toEqual(['module:node:22', 'module:gcr.io/distroless/nodejs22']);
  });

  it('extracts TOML tables and dependencies', () => {
    const r = config.extract('pyproject.toml', 'name = "x"\n[project]\ndependencies = [\n  "fastapi>=0.100",\n  "sqlalchemy",\n]\n[tool.poetry.dependencies]\npython = "^3.12"\nrequests = "*"\n');
    expect(r.symbols.map((s) => s.name)).toEqual(['name', 'project', 'tool.poetry.dependencies']);
    expect(r.edges.map((e) => e.dst).sort()).toEqual(['module:fastapi', 'module:requests', 'module:sqlalchemy']);
  });
});

describe('systems-language extractors', () => {
  it('Go: funcs, methods, types, imports', () => {
    const r = go.extract('pkg/user.go', 'package pkg\n\nimport (\n\t"fmt"\n\tdb "example.com/db"\n)\n\ntype User struct {\n\tName string\n}\n\nfunc (u *User) Greet() string {\n\treturn fmt.Sprint(u.Name)\n}\n\nfunc helper() {}\n');
    expect(sym(r, 'User')).toMatchObject({ kind: 'class', exported: true, lineEnd: 10 });
    expect(sym(r, 'User.Greet')).toMatchObject({ kind: 'method', exported: true });
    expect(sym(r, 'helper')).toMatchObject({ kind: 'function', exported: false });
    expect(r.edges.map((e) => e.dst)).toEqual(['module:fmt', 'module:example.com/db']);
  });

  it('Rust: fns, impl methods, traits, use, mod', () => {
    const r = rust.extract('src/lib.rs', "mod util;\nuse std::collections::HashMap;\npub struct Cache<'a> { m: &'a str }\npub trait Store {}\nimpl Store for Cache<'_> {\n    fn get(&self) {}\n}\npub fn new() {}\n", exists('src/util.rs'));
    expect(sym(r, 'Cache')).toMatchObject({ kind: 'class', exported: true });
    expect(sym(r, 'Store')).toMatchObject({ kind: 'interface' });
    expect(sym(r, 'Cache.get')).toMatchObject({ kind: 'method' });
    expect(sym(r, 'new')).toMatchObject({ kind: 'function', exported: true });
    expect(edge(r, 'file:src/lib.rs', 'IMPORTS', 'file:src/util.rs')).toBeDefined();
    expect(edge(r, 'symbol:src/lib.rs#Cache', 'IMPLEMENTS', 'symbol:src/lib.rs#Store')).toBeDefined();
  });

  it('Java and Kotlin: classes, methods, imports, heritage', () => {
    const j = jvm.extract('src/main/java/a/Svc.java', 'package a;\nimport a.b.Base;\npublic class Svc extends Base implements Runnable {\n  public void run() {}\n}\n', exists('src/main/java/a/b/Base.java'));
    expect(sym(j, 'Svc.run')).toMatchObject({ kind: 'method' });
    expect(edge(j, 'file:src/main/java/a/Svc.java', 'IMPORTS', 'file:src/main/java/a/b/Base.java')).toBeDefined();
    expect(edge(j, 'symbol:src/main/java/a/Svc.java#Svc', 'EXTENDS', 'symbol:src/main/java/a/b/Base.java#Base')).toBeDefined();
    expect(edge(j, 'symbol:src/main/java/a/Svc.java#Svc', 'IMPLEMENTS', 'symbol:?#Runnable')).toBeDefined();
    const k = jvm.extract('src/A.kt', 'import kotlinx.coroutines.flow\ndata class A(val x: Int) : B(), C {\n  fun go(): Int = x\n}\nfun top() {}\n');
    expect(sym(k, 'A.go')).toMatchObject({ kind: 'method' });
    expect(sym(k, 'top')).toMatchObject({ kind: 'function' });
    expect(edge(k, 'symbol:src/A.kt#A', 'EXTENDS', 'symbol:?#B')).toBeDefined();
  });

  it('C/C++: includes, types, functions', () => {
    const r = cfamily.extract('src/a.cpp', '#include "a.h"\n#include <vector>\nnamespace app {\nclass Widget : public Base {\n public:\n  void draw();\n};\nint Widget::size() const {\n  return 1;\n}\n}\nstatic int helper(int x) {\n  return x;\n}\n', exists('src/a.h'));
    expect(edge(r, 'file:src/a.cpp', 'IMPORTS', 'file:src/a.h')).toBeDefined();
    expect(edge(r, 'file:src/a.cpp', 'IMPORTS', 'module:vector')).toBeDefined();
    expect(sym(r, 'Widget')).toMatchObject({ kind: 'class' });
    expect(sym(r, 'Widget.size')).toMatchObject({ kind: 'method' });
    expect(sym(r, 'helper')).toMatchObject({ kind: 'function', exported: false });
    expect(edge(r, 'symbol:src/a.cpp#Widget', 'EXTENDS', 'symbol:?#Base')).toBeDefined();
  });

  it('C#: using, classes, methods, base list', () => {
    const r = csharp.extract('Svc.cs', 'using System.Text;\nnamespace App\n{\n    public class Svc : BaseSvc, IDisposable\n    {\n        public void Dispose() { }\n    }\n}\n');
    expect(edge(r, 'file:Svc.cs', 'IMPORTS', 'module:System.Text')).toBeDefined();
    expect(sym(r, 'Svc')).toMatchObject({ kind: 'class', exported: true });
    expect(sym(r, 'Svc.Dispose')).toMatchObject({ kind: 'method', exported: true });
    expect(edge(r, 'symbol:Svc.cs#Svc', 'EXTENDS', 'symbol:?#BaseSvc')).toBeDefined();
    expect(edge(r, 'symbol:Svc.cs#Svc', 'IMPLEMENTS', 'symbol:?#IDisposable')).toBeDefined();
  });
});
