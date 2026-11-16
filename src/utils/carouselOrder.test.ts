import { describe, it, expect } from 'vitest';
import { slideOrderKey, sortCarouselItems, groupAndSortDriveItems } from './postHelpers.ts';
import type { DriveImageItem } from '../types/index.ts';

const nomes = (items: { nome: string }[]) => items.map((i) => i.nome);

describe('slideOrderKey', () => {
  it('capa vem sempre primeiro, com ou sem número', () => {
    expect(slideOrderKey('Capa.png')).toBe(0);
    expect(slideOrderKey('01_Capa.png')).toBe(0);
    expect(slideOrderKey('capa_google.jpg')).toBe(0);
    expect(slideOrderKey('Capa Ato.png')).toBe(0);
  });

  it('usa o número do início do nome', () => {
    expect(slideOrderKey('02_Interna.png')).toBe(2);
    expect(slideOrderKey('03-interna.png')).toBe(3);
    expect(slideOrderKey('10 fechamento.png')).toBe(10);
  });

  it('sem número nem capa vai para o fim', () => {
    expect(slideOrderKey('fechamento.png')).toBe(999);
  });

  it('arquivo reprovado usa o marcador -sNN, mesmo com "capa" no nome original', () => {
    expect(slideOrderKey('REP-fb_abc123_xyz-s01__01_capa.png')).toBe(1);
    expect(slideOrderKey('REP-fb_abc123_xyz-s03__03_interna.png')).toBe(3);
  });

  it('não confunde "capa" dentro de outra palavra', () => {
    expect(slideOrderKey('escapada_02.png')).toBe(999);
  });
});

describe('sortCarouselItems', () => {
  it('ordena capa primeiro, depois os números, ignorando a ordem de chegada', () => {
    const items = [
      { nome: '03_Interna.png' },
      { nome: 'Capa.png' },
      { nome: '04_Fechamento.png' },
      { nome: '02_Interna.png' },
    ];
    expect(nomes(sortCarouselItems(items))).toEqual([
      'Capa.png',
      '02_Interna.png',
      '03_Interna.png',
      '04_Fechamento.png',
    ]);
  });

  it('ignora o campo ordem gravado (pode estar errado)', () => {
    const items = [
      { nome: '01_Capa.png', ordem: 4 },
      { nome: '02_Interna.png', ordem: 1 },
    ];
    expect(nomes(sortCarouselItems(items))).toEqual(['01_Capa.png', '02_Interna.png']);
  });

  it('não altera o array original', () => {
    const items = [{ nome: '02.png' }, { nome: '01.png' }];
    sortCarouselItems(items);
    expect(nomes(items)).toEqual(['02.png', '01.png']);
  });
});

describe('groupAndSortDriveItems (carrossel)', () => {
  it('monta o carrossel com a capa na primeira posição e ordem 1..n', () => {
    const base = {
      categoria: '02 Carrossel',
      loteNome: 'Lote Teste',
      dataCriacao: '2026-11-16T00:00:00.000Z',
      driveFolderName: 'Ato',
      pastaClienteNome: 'Ato',
      tenantId: 't1',
      status: 'PENDENTE',
    } as unknown as Partial<DriveImageItem>;
    const itens = [
      { ...base, driveFileId: 'f3', nome: '03_Interna.png' },
      { ...base, driveFileId: 'f1', nome: 'Capa.png' },
      { ...base, driveFileId: 'f2', nome: '02_Interna.png' },
    ] as DriveImageItem[];

    const grupos = groupAndSortDriveItems(itens);
    expect(grupos).toHaveLength(1);
    const slides = grupos[0].items;
    expect(nomes(slides)).toEqual(['Capa.png', '02_Interna.png', '03_Interna.png']);
    expect(slides.map((s) => s.ordem)).toEqual([1, 2, 3]);
  });
});
