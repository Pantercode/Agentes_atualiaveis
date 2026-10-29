/**
 * Agente de performance de jogadores da NBA (dataset Kaggle wyattowalsh/basketball).
 *
 * Planilha: abas "jogadores" e "estatisticas" (geradas por preparar_dados.py).
 * IA: Google Gemini. Chave em Propriedades do script > GEMINI_API_KEY (ou no arquivo chave.gs).
 */

// Tentativas em ordem: se o modelo estiver sobrecarregado (503) ou sem cota (429), espera um pouco
// e segue para a próxima. O 3.5 Flash aparece duas vezes porque o 503 dele costuma ser momentâneo;
// depois vêm os "lite", mais rápidos. (O gemini-3.8-flash ficou fora: travava >90 s sob demanda.)
const MODELOS_GEMINI = ['gemini-3.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
const API_GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/';
const FOTO_PADRAO = 'https://cdn.nba.com/headshots/nba/latest/1040x760/fallback.png';
const MAX_RODADAS_FERRAMENTAS = 8;

// ---------------------------------------------------------------------------
// Web app
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Agente NBA - Performance dos Jogadores')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Menu na planilha para abrir o painel lateral também. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Agente NBA')
    .addItem('Abrir painel', 'abrirPainel')
    .addItem('Importar CSVs do Drive', 'importarDados')
    .addToUi();
}

/**
 * Grava jogadores e estatisticas nas abas da planilha. Usa jogadores.csv / estatisticas.csv do
 * Google Drive se existirem; senão, os dados embutidos no projeto (dados_*.html).
 * A coluna "temporada" é gravada como texto para o Sheets não convertê-la em data.
 */
function importarDados() {
  const ss = planilha_();
  ['jogadores', 'estatisticas'].forEach(nome => {
    const arquivos = DriveApp.getFilesByName(nome + '.csv');
    const texto = arquivos.hasNext()
      ? arquivos.next().getBlob().getDataAsString('UTF-8')
      : HtmlService.createHtmlOutputFromFile('dados_' + nome).getContent();
    const linhas = Utilities.parseCsv(texto.trim());
    // Colunas só com números viram número; as demais ficam como TEXTO, senão o Sheets
    // converte "6-9" (altura) e "2005-06" (temporada) em datas.
    const numerica = linhas[0].map((_, c) => linhas.slice(1).every(l => l[c] === '' || !isNaN(l[c])));
    const valores = linhas.map((l, r) => l.map((v, c) => (r > 0 && numerica[c] && v !== '' ? Number(v) : v)));
    const aba = ss.getSheetByName(nome) || ss.insertSheet(nome);
    aba.clear();
    numerica.forEach((num, c) => { if (!num) aba.getRange(1, c + 1, valores.length, 1).setNumberFormat('@'); });
    aba.getRange(1, 1, valores.length, valores[0].length).setValues(valores);
  });
  PropertiesService.getScriptProperties().setProperty('FORMATO_DADOS', FORMATO_DADOS);
  ['Sheet1', 'Página1'].forEach(n => { const a = ss.getSheetByName(n); if (a && ss.getSheets().length > 1) ss.deleteSheet(a); });
  PropertiesService.getScriptProperties().setProperty('VERSAO_DADOS', String(Date.now()));
  Logger.log('Dados importados em: ' + ss.getUrl());
  if (SpreadsheetApp.getActiveSpreadsheet()) ss.toast('Dados importados!', 'Agente NBA');
}

function abrirPainel() {
  const html = HtmlService.createHtmlOutputFromFile('Index').setTitle('Agente NBA');
  SpreadsheetApp.getUi().showSidebar(html);
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

/**
 * Planilha de dados: a definida em SPREADSHEET_ID, a planilha onde o script está (se for vinculado)
 * ou, em projeto independente, uma planilha "Agente NBA - dados" criada na primeira execução.
 */
function planilha_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ativa = SpreadsheetApp.getActiveSpreadsheet();
  if (ativa) return ativa;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const criada = props.getProperty('SPREADSHEET_ID'); // outra execução pode ter criado enquanto esperávamos
    if (criada) return SpreadsheetApp.openById(criada);
    const nova = SpreadsheetApp.create('Agente NBA - dados');
    props.setProperty('SPREADSHEET_ID', nova.getId());
    return nova;
  } finally {
    lock.releaseLock();
  }
}

// Muda quando o jeito de gravar a planilha muda: força uma reimportação automática
const FORMATO_DADOS = '3'; // 3: colunas wiki_pt/wiki_en (biografia)

// Cache em memória: vale durante uma execução (ex.: várias ferramentas numa pergunta ao agente)
const MEMO_ = {};

/** Lê uma aba como lista de objetos {coluna: valor}. */
function lerAba_(nome) {
  if (MEMO_[nome]) return MEMO_[nome];
  const props = PropertiesService.getScriptProperties();
  let aba = planilha_().getSheetByName(nome);
  if (!aba || props.getProperty('FORMATO_DADOS') !== FORMATO_DADOS) {
    // Primeiro acesso (ou planilha num formato antigo): importa automaticamente, uma vez, com lock
    const lock = LockService.getScriptLock();
    lock.waitLock(120000);
    try {
      if (!planilha_().getSheetByName(nome) || props.getProperty('FORMATO_DADOS') !== FORMATO_DADOS) importarDados();
    } finally {
      lock.releaseLock();
    }
    aba = planilha_().getSheetByName(nome);
  }
  const [cab, ...linhas] = aba.getDataRange().getValues();
  return (MEMO_[nome] = linhas.map(l => Object.fromEntries(cab.map((c, i) => [c, l[i]]))));
}

function jogadores_() {
  return lerAba_('jogadores').map(j => Object.assign(j, { foto: j.foto || FOTO_PADRAO }));
}

/**
 * Cache entre execuções (CacheService, 6 h). A chave inclui a versão dos dados,
 * que muda a cada importação, então nunca serve resultado desatualizado.
 */
function cacheado_(chave, calcular) {
  const props = PropertiesService.getScriptProperties();
  const k = (props.getProperty('VERSAO_DADOS') || '0') + ':' + chave;
  const cache = CacheService.getScriptCache();
  const salvo = cache.get(k);
  if (salvo) return JSON.parse(salvo);
  // Ida e volta em JSON: garante que nenhuma Date chegue ao google.script.run (que devolveria null)
  const json = JSON.stringify(calcular());
  if (json.length < 95000) cache.put(k, json, 21600); // limite do CacheService: 100 KB por chave
  return JSON.parse(json);
}

function normalizar_(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const STATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta'];

/** Soma linhas de estatística e calcula médias por jogo e percentuais. */
function resumo_(linhas) {
  const t = { jogos: 0 };
  STATS.forEach(s => (t[s] = 0));
  linhas.forEach(l => {
    t.jogos += Number(l.jogos);
    STATS.forEach(s => (t[s] += Number(l[s])));
  });
  const pj = v => (t.jogos ? Math.round((v / t.jogos) * 10) / 10 : 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    jogos: t.jogos,
    ppg: pj(t.pts), rpg: pj(t.reb), apg: pj(t.ast), spg: pj(t.stl), bpg: pj(t.blk), tpg: pj(t.tov),
    fg_pct: pct(t.fgm, t.fga), fg3_pct: pct(t.fg3m, t.fg3a), ft_pct: pct(t.ftm, t.fta),
    totais: t,
  };
}

// ---------------------------------------------------------------------------
// Funções chamadas pela interface (google.script.run) e pelo agente
// ---------------------------------------------------------------------------

/**
 * Busca jogadores pelo nome (sem acentos/maiúsculas), já ordenados por pontos na carreira.
 * @param {string} filtro 'todos' | 'ativos' | 'top75'
 */
function buscarJogadores(termo, limite, filtro) {
  const q = normalizar_(termo || '');
  const anoMax = Math.max(...jogadores_().map(j => Number(j.ate) || 0));
  return jogadores_()
    .filter(j => !q || normalizar_(j.nome).includes(q))
    .filter(j => filtro === 'ativos' ? Number(j.ate) >= anoMax : filtro === 'top75' ? j.top75 === 'Y' : true)
    .sort((a, b) => (Number(b.ppg) || 0) - (Number(a.ppg) || 0))
    .slice(0, limite || 24)
    .map(j => ({ id: j.person_id, nome: j.nome, posicao: j.posicao, time: j.time, sigla: j.sigla_time, de: j.de, ate: j.ate,
                 foto: j.foto, ppg: j.ppg, rpg: j.rpg, apg: j.apg, top75: j.top75 }));
}

/** Performance completa de um jogador: perfil, carreira e cada temporada. */
function performanceJogador(personId, fase) {
  fase = fase || 'Regular';
  const id = Number(personId);
  return cacheado_('perf:' + id + ':' + fase, () => {
    const perfil = jogadores_().find(j => Number(j.person_id) === id);
    if (!perfil) throw new Error('Jogador ' + personId + ' não encontrado.');
    const linhas = lerAba_('estatisticas').filter(l => Number(l.person_id) === id && l.fase === fase);
    const temporadas = linhas
      .map(l => Object.assign({ temporada: String(l.temporada) }, resumo_([l])))
      .sort((a, b) => (a.temporada < b.temporada ? -1 : 1));
    temporadas.forEach(t => delete t.totais);
    return { perfil: perfil, fase: fase, carreira: resumo_(linhas), temporadas: temporadas };
  });
}

/**
 * Biografia do jogador: introdução do artigo da Wikipédia. Usa o artigo em português; se não
 * existir, o inglês traduzido pelo LanguageApp. O título exato vem do Wikidata (biografias.py),
 * pelo id da NBA, então não há confusão entre homônimos.
 * @return {{paragrafos: string[], fonte: string, url: string, traduzida: boolean}}
 */
function biografiaJogador(personId) {
  const id = Number(personId);
  return cacheado_('bio:' + id, () => {
    const j = jogadores_().find(x => Number(x.person_id) === id);
    if (!j) throw new Error('Jogador ' + personId + ' não encontrado.');
    const fontes = [['pt', j.wiki_pt], ['en', j.wiki_en]].filter(f => f[1]);
    for (const [lang, titulo] of fontes) {
      const texto = introWikipedia_(lang, String(titulo));
      if (!texto) continue;
      const traduzida = lang !== 'pt';
      let paragrafos = limitarParagrafos_(texto, 2200);
      if (traduzida) paragrafos = LanguageApp.translate(paragrafos.join('\n\n'), 'en', 'pt').split(/\n+/).filter(s => s.trim());
      return {
        paragrafos: paragrafos,
        fonte: traduzida ? 'Wikipédia em inglês (tradução automática)' : 'Wikipédia',
        url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(String(titulo).replace(/ /g, '_')),
        traduzida: traduzida,
      };
    }
    return { paragrafos: [], fonte: '', url: '', traduzida: false };
  });
}

function introWikipedia_(lang, titulo) {
  const url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1' +
              '&redirects=1&format=json&titles=' + encodeURIComponent(titulo);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Api-User-Agent': 'AgenteNBA/1.0 (Google Apps Script)' } });
  if (resp.getResponseCode() !== 200) return '';
  const paginas = (JSON.parse(resp.getContentText()).query || {}).pages || {};
  const pagina = Object.values(paginas)[0] || {};
  return (pagina.extract || '').trim();
}

/** Mantém parágrafos inteiros até o limite de caracteres (a introdução de astros é longa). */
function limitarParagrafos_(texto, limite) {
  const saida = [];
  let total = 0;
  for (const p of texto.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
    if (saida.length && total + p.length > limite) break;
    saida.push(p);
    total += p.length;
  }
  return saida;
}

// Tentativas mínimas por temporada (carreira: x5) para entrar em rankings de aproveitamento
const TENTATIVAS_MIN = { fg_pct: ['fga', 300], fg3_pct: ['fg3a', 82], ft_pct: ['fta', 125] };

/** Ranking de jogadores por uma estatística média (ppg, rpg, apg...) numa temporada ou na carreira. */
function rankingJogadores(estatistica, temporada, limite, minimoJogos) {
  estatistica = estatistica || 'ppg';
  temporada = String(temporada || '').replace(/[–/]/g, '-');
  minimoJogos = minimoJogos || (temporada ? 40 : 200);
  limite = limite || 10;
  return cacheado_(['rank', estatistica, temporada, limite, minimoJogos].join(':'), () => {
    const porJogador = {};
    lerAba_('estatisticas')
      .filter(l => l.fase === 'Regular' && (!temporada || String(l.temporada) === temporada))
      .forEach(l => (porJogador[l.person_id] = porJogador[l.person_id] || []).push(l));
    const mapa = Object.fromEntries(jogadores_().map(j => [j.person_id, j]));
    return Object.entries(porJogador)
      .map(([id, ls]) => ({ id: Number(id), r: resumo_(ls) }))
      .filter(x => x.r.jogos >= minimoJogos && mapa[x.id] && x.r[estatistica] != null)
      // Percentuais exigem volume mínimo de tentativas (critério semelhante ao da NBA)
      .filter(x => !TENTATIVAS_MIN[estatistica] ||
        x.r.totais[TENTATIVAS_MIN[estatistica][0]] >= TENTATIVAS_MIN[estatistica][1] * (temporada ? 1 : 5))
      .sort((a, b) => b.r[estatistica] - a.r[estatistica])
      .slice(0, limite)
      .map((x, i) => ({
        posicao: i + 1, id: x.id, nome: mapa[x.id].nome, foto: mapa[x.id].foto, sigla: mapa[x.id].sigla_time,
        jogos: x.r.jogos, valor: x.r[estatistica], ppg: x.r.ppg, rpg: x.r.rpg, apg: x.r.apg,
      }));
  });
}

// ---------------------------------------------------------------------------
// Agente (Google Gemini via API HTTP, com chamada de funções)
// ---------------------------------------------------------------------------

const SISTEMA = [
  'Você é um analista de basquete da NBA. Responda em português do Brasil.',
  'Use as ferramentas para consultar os dados reais antes de afirmar qualquer número;',
  'não invente estatísticas. Os dados vêm do play-by-play do dataset Kaggle',
  '"wyattowalsh/basketball": temporadas 1996-97 a 2022-23, sem a 2012-13, e alguns jogos',
  'faltam em cada temporada. Por isso, baseie-se nas médias por jogo (confiáveis) e avise',
  'que totais e número de jogos podem ficar abaixo dos oficiais.',
  'Ao analisar um jogador, destaque médias de pontos, rebotes, assistências, aproveitamento',
  'e a evolução entre temporadas (melhor temporada, picos e quedas). Seja direto e use',
  'listas ou tabelas curtas em markdown. A interface mostra a foto de cada jogador que você',
  'consultar, então não precisa descrever a aparência. Para trajetória, origem, prêmios e títulos,',
  'use biografia_jogador e cite que a fonte é a Wikipédia.',
].join(' ');

const FERRAMENTAS = [{
  functionDeclarations: [
    {
      name: 'buscar_jogadores',
      description: 'Procura jogadores pelo nome (parcial). Retorna id, nome, posição, time e anos de carreira. Use para descobrir o id antes de consultar a performance.',
      parameters: {
        type: 'object',
        properties: { termo: { type: 'string', description: 'Parte do nome, ex.: "lebron" ou "curry".' } },
        required: ['termo'],
      },
    },
    {
      name: 'performance_jogador',
      description: 'Retorna perfil, médias da carreira e médias de cada temporada (ppg, rpg, apg, spg, bpg, tpg, fg_pct, fg3_pct, ft_pct) de um jogador.',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'integer', description: 'Id do jogador (de buscar_jogadores).' },
          fase: { type: 'string', enum: ['Regular', 'Playoffs'], description: 'Temporada regular ou playoffs.' },
        },
        required: ['person_id', 'fase'],
      },
    },
    {
      name: 'biografia_jogador',
      description: 'Biografia do jogador (introdução do artigo da Wikipédia): origem, trajetória, prêmios e títulos. Use para contexto além dos números.',
      parameters: {
        type: 'object',
        properties: { person_id: { type: 'integer', description: 'Id do jogador (de buscar_jogadores).' } },
        required: ['person_id'],
      },
    },
    {
      name: 'ranking_jogadores',
      description: 'Ranking dos líderes de uma estatística média por jogo, numa temporada específica ou somando a carreira (temporada vazia).',
      parameters: {
        type: 'object',
        properties: {
          estatistica: { type: 'string', enum: ['ppg', 'rpg', 'apg', 'spg', 'bpg', 'fg_pct', 'fg3_pct', 'ft_pct'] },
          temporada: { type: 'string', description: 'Formato "2015-16", ou "" para carreira.' },
          limite: { type: 'integer', description: 'Quantidade de jogadores (1-25).' },
        },
        required: ['estatistica', 'temporada', 'limite'],
      },
    },
  ],
}];

/** Executa a função pedida pelo modelo e devolve um objeto (o Gemini exige objeto na resposta). */
function executarFerramenta_(nome, entrada, vistos) {
  if (nome === 'buscar_jogadores') {
    return { jogadores: buscarJogadores(entrada.termo, 10) };
  }
  if (nome === 'performance_jogador') {
    const r = performanceJogador(entrada.person_id, entrada.fase);
    const p = r.perfil;
    vistos[p.person_id] = { id: p.person_id, nome: p.nome, foto: p.foto, time: p.time, sigla: p.sigla_time, posicao: p.posicao,
                            ppg: r.carreira.ppg, rpg: r.carreira.rpg, apg: r.carreira.apg };
    return r;
  }
  if (nome === 'biografia_jogador') {
    return biografiaJogador(entrada.person_id);
  }
  if (nome === 'ranking_jogadores') {
    const lista = rankingJogadores(entrada.estatistica, entrada.temporada, Math.min(entrada.limite || 10, 25));
    lista.slice(0, 5).forEach(x => (vistos[x.id] = vistos[x.id] ||
      { id: x.id, nome: x.nome, foto: x.foto, sigla: x.sigla, ppg: x.ppg, rpg: x.rpg, apg: x.apg }));
    return { ranking: lista };
  }
  throw new Error('Ferramenta desconhecida: ' + nome);
}

function chaveGemini_() {
  const chave = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') ||
    (typeof GEMINI_API_KEY_PADRAO !== 'undefined' ? GEMINI_API_KEY_PADRAO : '');
  if (!chave) throw new Error('Defina GEMINI_API_KEY nas Propriedades do script.');
  return chave;
}

function chamarGemini_(conteudos) {
  const corpo = JSON.stringify({
    systemInstruction: { parts: [{ text: SISTEMA }] },
    contents: conteudos,
    tools: FERRAMENTAS,
    generationConfig: { maxOutputTokens: 8192 },
  });
  let ultimoErro = '';
  for (let t = 0; t < MODELOS_GEMINI.length; t++) {
    const modelo = MODELOS_GEMINI[t];
    if (t > 0) Utilities.sleep(1500);
    const resp = UrlFetchApp.fetch(API_GEMINI + modelo + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': chaveGemini_() },
      muteHttpExceptions: true,
      payload: corpo,
    });
    const codigo = resp.getResponseCode();
    const json = JSON.parse(resp.getContentText() || '{}');
    if (codigo === 200) return json;
    ultimoErro = '(' + codigo + ') ' + (json.error ? json.error.message : resp.getContentText());
    // Sobrecarga, cota ou modelo indisponível: tenta o próximo. Outros erros (ex.: chave inválida): para.
    if (![404, 429, 500, 503].includes(codigo)) break;
  }
  throw new Error('Erro da API do Gemini ' + ultimoErro);
}

/**
 * Envia a pergunta ao agente e executa as funções pedidas pelo Gemini até a resposta final.
 * @param {string} pergunta
 * @param {Array} historico conteúdos anteriores (devolvidos por esta função)
 * @return {{texto: string, jogadores: Array, historico: Array}}
 */
function perguntarAgente(pergunta, historico) {
  const conteudos = (historico || []).concat([{ role: 'user', parts: [{ text: pergunta }] }]);
  const vistos = {};

  for (let i = 0; i < MAX_RODADAS_FERRAMENTAS; i++) {
    const r = chamarGemini_(conteudos);
    const cand = (r.candidates || [])[0];
    if (!cand || !cand.content) {
      const motivo = (r.promptFeedback && r.promptFeedback.blockReason) || (cand && cand.finishReason) || 'sem resposta';
      return { texto: 'O modelo não respondeu (' + motivo + '). Tente reformular.', jogadores: [], historico: historico || [] };
    }
    // O conteúdo do modelo volta inteiro (inclui thoughtSignature, exigida pelos modelos Gemini 3)
    conteudos.push(cand.content);
    const partes = cand.content.parts || [];
    const chamadas = partes.filter(p => p.functionCall);

    if (!chamadas.length) {
      const texto = partes.filter(p => p.text && !p.thought).map(p => p.text).join('');
      return { texto: texto || '(resposta vazia)', jogadores: Object.values(vistos), historico: conteudos };
    }

    conteudos.push({
      role: 'user',
      parts: chamadas.map(p => {
        let resposta;
        try {
          resposta = executarFerramenta_(p.functionCall.name, p.functionCall.args || {}, vistos);
        } catch (e) {
          resposta = { erro: String(e.message || e) };
        }
        const fr = { name: p.functionCall.name, response: resposta };
        if (p.functionCall.id) fr.id = p.functionCall.id;
        return { functionResponse: fr };
      }),
    });
  }
  return { texto: 'Limite de consultas atingido; tente uma pergunta mais específica.', jogadores: Object.values(vistos), historico: conteudos };
}

