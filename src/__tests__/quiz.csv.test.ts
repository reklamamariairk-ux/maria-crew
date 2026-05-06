// Юнит-тесты CSV-парсера квиза (без БД).
// importQuestionsFromCsv делает реальные INSERT, поэтому здесь тестируется только parseCsv.
import { parseCsv } from '../services/quiz.service';

describe('parseCsv', () => {
  it('парсит простой CSV без кавычек', () => {
    const out = parseCsv('a,b,c\n1,2,3\n');
    expect(out).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('обрабатывает Windows-окончания \\r\\n', () => {
    const out = parseCsv('a,b\r\n1,2\r\n');
    expect(out).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('срезает BOM в начале', () => {
    const out = parseCsv('﻿a,b\n1,2');
    expect(out).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('сохраняет запятую внутри кавычек', () => {
    const out = parseCsv('q,opt\n"вопрос, с запятой","ответ"\n');
    expect(out).toEqual([['q', 'opt'], ['вопрос, с запятой', 'ответ']]);
  });

  it('обрабатывает удвоенные кавычки внутри поля', () => {
    const out = parseCsv('q\n"торт ""Прага"""\n');
    expect(out).toEqual([['q'], ['торт "Прага"']]);
  });

  it('пропускает полностью пустые строки', () => {
    const out = parseCsv('a,b\n1,2\n\n3,4\n');
    expect(out).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('возвращает пустой массив для пустого ввода', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });

  it('обрабатывает перенос строки внутри кавычек', () => {
    const out = parseCsv('q\n"строка 1\nстрока 2"\n');
    expect(out).toEqual([['q'], ['строка 1\nстрока 2']]);
  });

  it('последняя строка без завершающего \\n', () => {
    const out = parseCsv('a,b\n1,2');
    expect(out).toEqual([['a', 'b'], ['1', '2']]);
  });
});
