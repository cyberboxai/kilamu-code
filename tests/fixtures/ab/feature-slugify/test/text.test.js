import test from 'node:test';
import assert from 'node:assert/strict';
import { capitalize, slugify } from '../src/text.js';

test('capitalize still works', () => assert.equal(capitalize('kilamu'), 'Kilamu'));
test('slugify lowercases and joins words with dashes', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('slugify strips punctuation', () => assert.equal(slugify('Ready, set... go!'), 'ready-set-go'));
test('slugify collapses separators and trims dashes', () => assert.equal(slugify('  --a   b--  '), 'a-b'));
test('slugify removes accents', () => assert.equal(slugify('Luanda São Paulo Ação'), 'luanda-sao-paulo-acao'));
test('slugify keeps digits', () => assert.equal(slugify('Release 2.0 notes'), 'release-2-0-notes'));
test('slugify of empty input is empty', () => assert.equal(slugify(''), ''));
