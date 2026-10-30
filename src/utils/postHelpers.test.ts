import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSlideNumber,
  groupAndSortDriveItems,
  filterPosts,
  buildInstagramGraphPayload,
  slugifyText,
  generateRejectedFilename,
  getAspectRatioBadge,
} from './postHelpers.ts';
import { DriveImageItem, PostGroup } from '../types/index.ts';

test('extractSlideNumber parses slide sequences accurately', () => {
  assert.equal(extractSlideNumber('ATO_Carrossel_01.png'), 1);
  assert.equal(extractSlideNumber('slide_04.jpg'), 4);
  assert.equal(extractSlideNumber('02_analise_dados.png'), 2);
  assert.equal(extractSlideNumber('carrossel-10-conclusao.png'), 10);
});

test('groupAndSortDriveItems groups carousel items and sorts by numerical order', () => {
  const rawItems: DriveImageItem[] = [
    {
      driveFileId: 'id_3',
      nome: 'ATO_Slide_03_Diagrama.png',
      categoria: 'Carrossel',
      loteNome: 'Lote_Estrategia_2026',
      viewUrl: 'https://drive.mock/3',
      thumbnailUrl: 'https://drive.mock/3_thumb',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
    },
    {
      driveFileId: 'id_1',
      nome: 'ATO_Slide_01_Capa.png',
      categoria: 'Carrossel',
      loteNome: 'Lote_Estrategia_2026',
      viewUrl: 'https://drive.mock/1',
      thumbnailUrl: 'https://drive.mock/1_thumb',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
    },
    {
      driveFileId: 'id_4',
      nome: 'ATO_Slide_04_CTA.png',
      categoria: 'Carrossel',
      loteNome: 'Lote_Estrategia_2026',
      viewUrl: 'https://drive.mock/4',
      thumbnailUrl: 'https://drive.mock/4_thumb',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
    },
    {
      driveFileId: 'id_2',
      nome: 'ATO_Slide_02_Metricas.png',
      categoria: 'Carrossel',
      loteNome: 'Lote_Estrategia_2026',
      viewUrl: 'https://drive.mock/2',
      thumbnailUrl: 'https://drive.mock/2_thumb',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
    },
    {
      driveFileId: 'id_single',
      nome: 'ATO_Post_Unico_Infra.png',
      categoria: 'Post Único',
      loteNome: 'ATO_Post_Unico_Infra',
      viewUrl: 'https://drive.mock/single',
      thumbnailUrl: 'https://drive.mock/single_thumb',
      dataCriacao: '2026-10-23T11:00:00Z',
      status: 'PENDENTE',
    },
    {
      driveFileId: 'id_story',
      nome: 'ATO_Story_Convite.png',
      categoria: 'Story',
      loteNome: 'ATO_Story_Convite',
      viewUrl: 'https://drive.mock/story',
      thumbnailUrl: 'https://drive.mock/story_thumb',
      dataCriacao: '2026-10-23T12:00:00Z',
      status: 'PENDENTE',
    },
  ];

  const groups = groupAndSortDriveItems(rawItems);

  // Total groups: 1 carousel group, 1 single post group, 1 story group = 3
  assert.equal(groups.length, 3);

  const carouselGroup = groups.find((g) => g.categoria === 'Carrossel');
  assert.ok(carouselGroup);
  assert.equal(carouselGroup.items.length, 4);

  // Must be strictly ordered 01, 02, 03, 04
  assert.equal(carouselGroup.items[0].driveFileId, 'id_1');
  assert.equal(carouselGroup.items[1].driveFileId, 'id_2');
  assert.equal(carouselGroup.items[2].driveFileId, 'id_3');
  assert.equal(carouselGroup.items[3].driveFileId, 'id_4');
});

test('filterPosts filters correctly by status and search query', () => {
  const posts: PostGroup[] = [
    {
      id: 'p1',
      nome: 'Post Arquitetura',
      loteNome: 'Lote 1',
      categoria: 'Post Único',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
      items: [],
    },
    {
      id: 'p2',
      nome: 'Post Métricas',
      loteNome: 'Lote 2',
      categoria: 'Carrossel',
      dataCriacao: '2026-10-23T11:00:00Z',
      status: 'AGENDADO',
      items: [],
    },
    {
      id: 'p3',
      nome: 'Story Lançamento',
      loteNome: 'Lote 3',
      categoria: 'Story',
      dataCriacao: '2026-10-23T12:00:00Z',
      status: 'PUBLICADO',
      items: [],
    },
  ];

  assert.equal(filterPosts(posts, 'TODOS').length, 3);
  assert.equal(filterPosts(posts, 'PENDENTES').length, 1);
  assert.equal(filterPosts(posts, 'AGENDADOS').length, 1);
  assert.equal(filterPosts(posts, 'PUBLICADOS').length, 1);

  // Search filter
  const searchResults = filterPosts(posts, 'TODOS', 'Arquitetura');
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].id, 'p1');
});

test('buildInstagramGraphPayload constructs carousel child containers correctly', () => {
  const carouselGroup: PostGroup = {
    id: 'c1',
    nome: 'Carrossel Teste',
    loteNome: 'Lote Teste',
    categoria: 'Carrossel',
    dataCriacao: '2026-10-23T10:00:00Z',
    status: 'PENDENTE',
    items: [
      {
        driveFileId: 'f1',
        nome: 'Slide 1',
        categoria: 'Carrossel',
        loteNome: 'Lote Teste',
        viewUrl: 'https://cdn.ato/1.png',
        thumbnailUrl: 'https://cdn.ato/1_th.png',
        dataCriacao: '2026-10-23T10:00:00Z',
        status: 'PENDENTE',
      },
      {
        driveFileId: 'f2',
        nome: 'Slide 2',
        categoria: 'Carrossel',
        loteNome: 'Lote Teste',
        viewUrl: 'https://cdn.ato/2.png',
        thumbnailUrl: 'https://cdn.ato/2_th.png',
        dataCriacao: '2026-10-23T10:00:00Z',
        status: 'PENDENTE',
      },
    ],
  };

  const payload = buildInstagramGraphPayload(carouselGroup, 'Legenda de teste');
  assert.equal((payload as any).type, 'CAROUSEL');
  assert.equal((payload as any).childContainers.length, 2);
  assert.equal((payload as any).carouselRoot.payload.caption, 'Legenda de teste');
});

test('filterPosts isolates posts by tenantId or driveFolderName in multi-tenant mode', () => {
  const posts: PostGroup[] = [
    {
      id: 'p1',
      nome: 'Post Cliente Alpha 1',
      loteNome: 'Lote Alpha',
      categoria: 'Post Único',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
      tenantId: 'tenant_cliente_alpha',
      driveFolderName: 'ATO Social Midia',
      items: [],
    },
    {
      id: 'p2',
      nome: 'Post ATO Oficial 1',
      loteNome: 'Lote ATO',
      categoria: 'Carrossel',
      dataCriacao: '2026-10-23T11:00:00Z',
      status: 'PENDENTE',
      tenantId: 'tenant_atosocial',
      driveFolderName: 'ATO Corporativo - Midias',
      items: [],
    },
  ];

  // Tenant Cliente Alpha only receives posts from their tenant / folder
  const alphaPosts = filterPosts(posts, 'TODOS', '', 'tenant_cliente_alpha');
  assert.equal(alphaPosts.length, 1);
  assert.equal(alphaPosts[0].id, 'p1');

  // Tenant ATO Social only receives posts from their tenant / folder
  const atoPosts = filterPosts(posts, 'TODOS', '', 'tenant_atosocial');
  assert.equal(atoPosts.length, 1);
  assert.equal(atoPosts[0].id, 'p2');
});

test('slugifyText correctly strips accents and creates clean snake_case', () => {
  assert.equal(slugifyText('Posição da Logo'), 'posicao_da_logo');
  assert.equal(slugifyText('Cores Fortes/Erradas'), 'cores_fortes_erradas');
  assert.equal(slugifyText('Não gostei da logo!'), 'nao_gostei_da_logo');
});

test('generateRejectedFilename creates snake_case without accents matching specification', () => {
  const result = generateRejectedFilename(
    ['Posição da Logo', 'Cores Fortes'],
    'Não gostei da logo',
    '01_capa.png'
  );
  assert.equal(result, 'posicao_da_logo_cores_fortes_nao_gostei_da_logo__01_capa.png');

  // Test with complex accents and symbols
  const result2 = generateRejectedFilename(
    ['Tipografia/Fonte', 'Fuga do Padrão Visual'],
    'Texto ilegível e cores muito claras',
    'Post_Social_Final.jpg'
  );
  assert.equal(
    result2,
    'tipografia_fonte_fuga_do_padrao_visual_texto_ilegivel_e_cores_muito_claras__post_social_final.jpg'
  );
});

test('filterPosts handles REPROVADOS tab and searches in rejection feedback', () => {
  const posts: PostGroup[] = [
    {
      id: 'p1',
      nome: 'Post Aprovado',
      loteNome: 'Lote 1',
      categoria: 'Post Único',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PUBLICADO',
      items: [],
    },
    {
      id: 'p2',
      nome: 'Arte Reprovada 1',
      loteNome: 'Lote 2',
      categoria: 'Post Único',
      dataCriacao: '2026-10-23T11:00:00Z',
      status: 'REPROVADO',
      rejectionFeedback: {
        tags: ['Posição da Logo'],
        motivo: 'A logo está muito perto da margem',
        novoNomeArquivo: 'posicao_da_logo__arte.png',
        dataReprovacao: '2026-10-23T11:30:00Z',
      },
      items: [],
    },
  ];

  const reprovados = filterPosts(posts, 'REPROVADOS');
  assert.equal(reprovados.length, 1);
  assert.equal(reprovados[0].id, 'p2');

  const searchByFeedback = filterPosts(posts, 'REPROVADOS', 'margem');
  assert.equal(searchByFeedback.length, 1);
  assert.equal(searchByFeedback[0].id, 'p2');
});

test('getAspectRatioBadge returns strictly defined 1:1, 4:5, or 9:16 based on dimensions or metadata', () => {
  // Story / 9:16
  assert.equal(getAspectRatioBadge('Story'), '9:16');
  assert.equal(getAspectRatioBadge('03 Story'), '9:16');
  assert.equal(getAspectRatioBadge('Story', 1080, 1920), '9:16');

  // 1:1 square
  assert.equal(getAspectRatioBadge('Post Único', 1080, 1080), '1:1');
  assert.equal(getAspectRatioBadge('Carrossel', 1080, 1080), '1:1');
  assert.equal(getAspectRatioBadge('01 Post unico'), '1:1');

  // 4:5 portrait
  assert.equal(getAspectRatioBadge('Post Único', 1080, 1350), '4:5');
  assert.equal(getAspectRatioBadge('Carrossel', 1080, 1350), '4:5');
  assert.equal(getAspectRatioBadge('Post Único', undefined, undefined, 'Post 4:5 Retrato'), '4:5');
});

test('filterPosts filters by category sub-filter (Post Único, Carrossel, Story)', () => {
  const posts: PostGroup[] = [
    {
      id: 'p1',
      nome: 'Post Unico 1',
      loteNome: 'Lote 1',
      categoria: 'Post Único',
      dataCriacao: '2026-10-23T10:00:00Z',
      status: 'PENDENTE',
      pastaClienteNome: 'Ato',
      items: [],
    },
    {
      id: 'p2',
      nome: 'Carrossel 1',
      loteNome: 'Lote 2',
      categoria: 'Carrossel',
      dataCriacao: '2026-10-23T11:00:00Z',
      status: 'PENDENTE',
      pastaClienteNome: 'Ato',
      items: [],
    },
    {
      id: 'p3',
      nome: 'Story 1',
      loteNome: 'Lote 3',
      categoria: 'Story',
      dataCriacao: '2026-10-23T12:00:00Z',
      status: 'PENDENTE',
      pastaClienteNome: 'Ato',
      items: [],
    },
  ];

  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'TODOS').length, 3);
  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'Post Único').length, 1);
  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'Post Único')[0].id, 'p1');
  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'Carrossel').length, 1);
  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'Carrossel')[0].id, 'p2');
  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'Story').length, 1);
  assert.equal(filterPosts(posts, 'PENDENTES', '', 'Ato', 'Story')[0].id, 'p3');
});


