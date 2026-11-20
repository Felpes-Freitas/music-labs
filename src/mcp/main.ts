#!/usr/bin/env node
// Servidor MCP do Music Labs (stdio). Fala com o app pelo HTTP local; se o app
// não estiver rodando, sobe o servidor em segundo plano.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCALES, chordNotes, romanChord, scaleNotes } from '../core/theory.js';
import { noteName, PPQ } from '../core/model.js';
import { channelDetail, clipsDetail, mixerDetail, audioRef } from '../core/studio.js';
import { GEN_PRESETS, GRID_STEPS } from '../core/autogen.js';

const PORT = Number(process.env.MUSICLABS_PORT ?? 7717);
const BASE = `http://127.0.0.1:${PORT}`;
/** Raiz do projeto: sobe até achar o package.json (funciona em src/ e em build/). */
function findRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    d = dirname(d);
  }
  return process.cwd();
}
const ROOT = findRoot();

async function ensureServer() {
  try {
    await fetch(`${BASE}/api/status`);
    return;
  } catch {
    /* sobe abaixo */
  }
  const built = join(ROOT, 'build/server.mjs');
  const args = existsSync(built) ? [built] : ['--import', 'tsx', join(ROOT, 'src/server/main.ts')];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await fetch(`${BASE}/api/status`);
      return;
    } catch {
      /* esperando */
    }
  }
  throw new Error('Não consegui iniciar o servidor do Music Labs');
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown) {
  await ensureServer();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Erro: ${(e as Error).message}` }], isError: true });

async function act(name: string, args: Record<string, unknown>, label?: string) {
  const r = await api('POST', '/api/actions', { actions: [{ name, args: strip(args) }], origin: 'mcp', label });
  return r.results[0];
}
function strip(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

const server = new McpServer(
  { name: 'musiclabs', version: '0.1.0' },
  {
    instructions: [
      'Music Labs é uma DAW para Linux no estilo rack de canais + piano roll + playlist + mixer.',
      'Tempo: posições em "beats" (semínimas, 0 = início do pattern) ou "compasso:tempo:step" com base 1 ("2:1:1").',
      'Durações em beats (0.25 = semicolcheia). Notas: "C4" (= MIDI 60) ou número MIDI. Velocity 0..1.',
      'Canais e patterns podem ser referenciados por id ou nome. Tracks da playlist e compassos começam em 1. Insert 0 = master.',
      'Fluxo típico: get_project -> add_channel (presets) -> add_pattern -> set_steps/add_notes/add_chords -> arrange -> mixer -> render/analyze_mix.',
      'Leitura detalhada: get_channel (parâmetros e efeitos), get_mixer, get_clips (playlist com ids, automações com a função), get_notes, list_audios. get_project.ui mostra o que o usuário está vendo (área selecionada, loop, janelas, pattern/canal selecionados).',
      'Edição de arranjo: edit_clips (mover, redimensionar, cortar o começo, duplicar, mutar, apagar), copy_section (repetir trechos), insert_bars/delete_bars (abrir/fechar espaço).',
      'Variações: duplicate_channel (canal igual com efeitos e notas) + copy_notes (notas entre patterns/canais) + update_effect. Automação: add_automation com fn (funções da Central: riser, fades, seno, wobble, gate, bombeamento...) inclusive do BPM (param "bpm"); edit_automation ajusta depois.',
      'Interface: ui (selecionar área, loop, metrônomo, contagem, abrir janelas/automação, agulha), transport (play/stop).',
      'Use batch para muitas edições de uma vez (é atômico e vira um único passo de undo); todas as ações de escrita existem no batch.',
      'Nunca é preciso escrever código para mexer no projeto: se faltar algo no MCP, diga ao usuário.',
      'Toda edição aparece na hora na interface do usuário. Antes de grandes mudanças num projeto existente, descreva o plano ao usuário.',
    ].join('\n'),
  },
);

const ref = z.string().describe('id ou nome');
const noteSchema = z.object({
  note: z.union([z.string(), z.number()]).describe('"C4", "F#3" ou MIDI'),
  start: z.union([z.number(), z.string()]).describe('beats desde o início do pattern, ou "compasso:tempo:step"'),
  length: z.number().optional().describe('beats (padrão 0.25)'),
  velocity: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  slide: z.boolean().optional(),
});

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (a: any) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  }) as any);
}

// ------------------------------------------------------------ leitura

tool('get_project', 'Resumo do projeto aberto: BPM, canais (com insert), patterns (contagem de notas por canal), playlist, mixer e estado da interface.', {}, () => api('GET', '/api/summary'));

tool(
  'get_notes',
  'Lista as notas de um pattern (opcionalmente só de um canal), com nome da nota, início/duração em beats e velocity.',
  { pattern: ref, channel: ref.optional() },
  async ({ pattern, channel }) => {
    const { project } = await api('GET', '/api/project');
    const pat = project.patterns.find((x: any) => x.id === pattern || x.name.toLowerCase() === pattern.toLowerCase());
    if (!pat) throw new Error(`Pattern ${pattern} não encontrado`);
    const out: Record<string, unknown[]> = {};
    for (const [chId, notes] of Object.entries(pat.notes as Record<string, any[]>)) {
      const ch = project.channels.find((c: any) => c.id === chId);
      if (!ch) continue;
      if (channel && ch.id !== channel && ch.name.toLowerCase() !== channel.toLowerCase()) continue;
      out[ch.name] = notes
        .slice()
        .sort((a, b) => a.pos - b.pos || a.key - b.key)
        .map((n) => ({ note: noteName(n.key), start: n.pos / PPQ, length: n.len / PPQ, velocity: Math.round(n.vel * 100) / 100 }));
    }
    return { pattern: pat.name, notes: out };
  },
);

const project = async () => (await api('GET', '/api/project')).project;

tool(
  'get_channel',
  'Tudo de um canal: tipo, todos os parâmetros do instrumento, efeitos do canal (com parâmetros e mix), insert, volume/pan/nota raiz, quantas notas tem em cada pattern e automações ligadas a ele.',
  { channel: ref },
  async ({ channel }) => channelDetail(await project(), channel),
);

tool(
  'get_mixer',
  'Mixer completo: cada insert com volume, pan, mute/solo, rota (output), canais ligados e efeitos com parâmetros. all=true inclui os inserts vazios.',
  { all: z.boolean().optional() },
  async ({ all }) => mixerDetail(await project(), all),
);

const clipFilter = {
  clipIds: z.array(z.string()).optional().describe('ids dos clipes (ver get_project/get_clips)'),
  track: z.number().optional().describe('track (base 1)'),
  fromBar: z.number().optional().describe('clipes que começam a partir deste compasso'),
  toBar: z.number().optional().describe('...até este compasso (inclusive)'),
  pattern: ref.optional(),
  kind: z.enum(['pattern', 'audio', 'auto']).optional(),
  automation: z.string().optional().describe('automação: parte do nome do alvo ("Corte", "BPM")'),
};

tool(
  'get_clips',
  'Clipes da playlist com detalhes (filtros opcionais): pattern e offset, áudio (arquivo, início no arquivo, ganho, insert), automação (alvo, faixa, função da Central em unidades do parâmetro, e os pontos se forem poucos ou points=true).',
  { ...clipFilter, points: z.boolean().optional() },
  async ({ points, ...f }) => clipsDetail(await project(), f, points),
);

tool('list_audios', 'Lista de áudios do projeto (gravações do amp/Afinador/Stitcher, importados e variantes) com arquivo, original e se tem edições.', {}, async () =>
  ((await project()).audios ?? []).map((a: any) => ({ id: a.id, name: a.name, path: a.path, original: a.original !== a.path ? a.original : undefined, variantOf: a.variantOf, editsOn: a.path !== a.original, editsSaved: !!a.edited })),
);

tool(
  'list_sounds',
  'Catálogo: presets de instrumento, tipos de instrumento e efeitos com seus parâmetros (faixas e padrões).',
  { kind: z.enum(['presets', 'samples', 'instruments', 'effects', 'automation']).optional(), name: z.string().optional().describe('detalhar um tipo específico') },
  async ({ kind, name }) => {
    if (kind === 'automation')
      return {
        functions: GEN_PRESETS.map((x) => ({ id: x.id, label: x.label, hint: x.hint, kind: x.gen.kind })),
        params: {
          ramp: 'from, to (unidade do parâmetro), curve -1..1 (>0 começa devagar/exponencial, <0 começa rápido), s (curva em S)',
          lfo: 'wave sine|tri|square|saw|sawdown, min, max, period e periodEnd (tempos; diferentes = acelera/desacelera), breathe 0..2 (oitavas: a frequência contrai/expande), breathePeriod (tempos), depth/depthEnd 0..1, phase 0..1, quantize (ciclos na grade)',
          pump: 'min, max, period (tempos), release 0..1, curve',
          steps: 'from, to, count (degraus), curve',
          random: 'min, max, period (tempos), smooth 0..1, seed',
          comum: `grid em tempos (${GRID_STEPS.map((g) => g.v || 0).join(', ')}; 0 = livre)`,
        },
      };
    const r = await api('GET', '/api/registry');
    const summarize = (o: Record<string, any>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, name ? v : { label: v.label, description: v.description, params: v.params.map((p: any) => `${p.key}${p.kind === 'num' ? ` ${p.min}..${p.max}${p.unit ? ' ' + p.unit : ''}` : p.kind === 'enum' ? ` [${p.options.join('|')}]` : ` (${p.kind})`}`).join(', ') }]));
    if (name) {
      const v = r.instruments[name] ?? r.effects[name] ?? r.presets[name];
      if (!v) throw new Error(`Nada chamado ${name}`);
      return v;
    }
    if (kind === 'samples') return { bateria: r.localSamples.map((x: any) => x.name), instrumentos: r.localInstruments.map((x: any) => `${x.name} (${x.daw ?? x.category} · ${x.group ?? ''})`) };
    if (kind === 'presets') return Object.fromEntries(Object.entries(r.presets).map(([k, v]: any) => [k, `${v.type}: ${v.description}`]));
    if (kind === 'instruments') return summarize(r.instruments);
    if (kind === 'effects') return summarize(r.effects);
    return {
      presets: Object.fromEntries(Object.entries(r.presets).map(([k, v]: any) => [k, `${v.type}: ${v.description}`])),
      instruments: summarize(r.instruments),
      effects: summarize(r.effects),
      localSamples: r.localSamples.map((x: any) => x.name),
      localInstruments: r.localInstruments.map((x: any) => x.name),
      scales: r.scales,
    };
  },
);

tool(
  'search_samples',
  'Procura arquivos de áudio (packs do FL Studio instalados, ~/MusicLabs/Samples, ~/Música, Downloads) por palavras no caminho. Use o path num canal sampler.',
  { query: z.string().describe('ex.: "kick 808", "snare trap", "vocal chop"'), limit: z.number().optional() },
  ({ query, limit }) => api('GET', `/api/search?q=${encodeURIComponent(query)}&limit=${limit ?? 30}`),
);

tool(
  'music_theory',
  'Ajuda de teoria: notas de uma escala, notas de acordes por cifra ("Am7", "F/C") ou por grau ("vi", "IV", "V7") numa tonalidade.',
  {
    key: z.string().optional().describe('tônica, ex. "A"'),
    scale: z.string().optional().describe(`uma de: ${Object.keys(SCALES).join(', ')}`),
    chords: z.array(z.string()).optional(),
    octave: z.number().optional(),
  },
  async ({ key, scale, chords, octave }) => {
    const out: Record<string, unknown> = {};
    if (key && scale) out.scale = scaleNotes(key, scale, 60, 71).map(noteName);
    if (chords)
      out.chords = Object.fromEntries(
        chords.map((c) => [c, (/^[b#]?[ivIV]+/.test(c) ? romanChord(c, key ?? 'C', scale ?? 'major', octave ?? 4) : chordNotes(c, octave ?? 4)).map(noteName)]),
      );
    return out;
  },
);

// ------------------------------------------------------------ projeto

tool(
  'new_project',
  'Cria um projeto novo (descarta o atual da tela; salve antes se precisar). template "kit" (padrão) já vem com Kick, Clap, Hat e Snare; "empty" vem vazio.',
  { name: z.string().optional(), bpm: z.number().optional(), template: z.enum(['kit', 'empty']).optional() },
  (a) => api('POST', '/api/new', a),
);

tool(
  'set_project',
  'Muda BPM, swing (0..1), nome, fórmula de compasso ou a região de loop da playlist ([compassoInicial, compassoFinal] ou null).',
  { bpm: z.number().optional(), swing: z.number().min(0).max(1).optional(), name: z.string().optional(), timeSig: z.tuple([z.number(), z.number()]).optional(), loopBars: z.tuple([z.number(), z.number()]).nullable().optional() },
  (a) => act('setProjectProps', a, 'Projeto atualizado'),
);

tool('save_project', 'Salva o projeto (.mlstudio). Sem path usa o arquivo atual ou ~/MusicLabs/Projetos/<nome>.mlstudio.', { path: z.string().optional() }, (a) => api('POST', '/api/save', a));

tool(
  'open_project',
  'Abre um .mlstudio ou importa um .flp do FL Studio (canais, patterns, notas, playlist, mixer; plugins do FL viram instrumentos nativos equivalentes). Se o relatório vier com locked=true, o .flp foi salvo por um FL não registrado: o FL embaralha tempo e outros valores nesses arquivos (trava de licença) e eles ficam no padrão; pergunte o BPM ao usuário. Não tente decodificar esses valores.',
  { path: z.string() },
  (a) => api('POST', '/api/open', a),
);

tool('list_projects', 'Lista projetos salvos em ~/MusicLabs/Projetos.', {}, () => api('GET', '/api/projects'));

tool('undo', 'Desfaz a última edição.', {}, () => api('POST', '/api/undo'));
tool('redo', 'Refaz.', {}, () => api('POST', '/api/redo'));

// ------------------------------------------------------------ canais

const instrumentType = z.enum(['synth', 'prisma', 'sampler', 'drum', 'pluck', 'fm', 'pads']);

tool(
  'add_channel',
  'Adiciona um canal ao rack. Use preset (ver list_sounds), localSample (som da instalação local do FL: bateria como "Kick", "909 Snare", ou instrumento multi-sample como "Strings Section", "Rhodes", "Close Grand"; ver list_sounds kind "samples") ou type + params. Para outro arquivo ou pasta: type "sampler", params {sample: "/caminho.wav" ou "/pasta/de/samples"}. O modo é escolhido sozinho (bateria one-shot; instrumento segura enquanto a nota dura, com loop e raiz detectada), mas params explícitos (oneshot, loop, root, r...) têm prioridade. insert "auto" cria um insert próprio no mixer.',
  {
    name: z.string().optional(),
    localSample: z.string().optional(),
    preset: z.string().optional(),
    type: instrumentType.optional(),
    params: z.record(z.string(), z.any()).optional(),
    insert: z.union([z.number(), z.literal('auto'), z.literal('master')]).optional(),
    volumeDb: z.number().optional(),
    pan: z.number().min(-1).max(1).optional(),
  },
  (a) => act('addChannel', a, `Canal adicionado: ${a.name ?? a.preset ?? a.type}`),
);

tool(
  'update_channel',
  'Altera um canal: nome, volume (dB), pan, nota raiz (root: a tecla que toca o som na altura original, ex. "D4"; equivale a transpor; em instrumentos multi-sample a troca de sample acompanha), ajuste fino em cents (fine, -100..100; no sampler, pitchMode "stretch" muda o tom sem mudar o andamento e "resample" reamostra), mute, insert do mixer, preset, tipo ou parâmetros do instrumento.',
  {
    channel: ref,
    name: z.string().optional(),
    volumeDb: z.number().optional(),
    pan: z.number().optional(),
    pitch: z.number().optional().describe('transposição em semitons (prefira root)'),
    root: z.union([z.string(), z.number()]).optional(),
    fine: z.number().min(-100).max(100).optional(),
    pitchMode: z.enum(['stretch', 'resample']).optional(),
    mute: z.boolean().optional(),
    insert: z.union([z.number(), z.string()]).optional(),
    preset: z.string().optional(),
    type: instrumentType.optional(),
    params: z.record(z.string(), z.any()).optional(),
  },
  (a) => act('updateChannel', a, `Canal ${a.channel} ajustado`),
);

tool(
  'duplicate_channel',
  'Duplica um canal: instrumento, todos os parâmetros, efeitos do canal, volume, pan e nota raiz. insert: "same" (padrão), "auto" (insert livre com o nome do canal), "master" ou número/nome. copyNotes: true copia as notas em todos os patterns (ou lista de patterns). params/volumeDb mudam a cópia na hora (ex.: cutoff).',
  { channel: ref, name: z.string().optional(), insert: z.union([z.number(), z.string()]).optional(), copyNotes: z.union([z.boolean(), z.array(z.string())]).optional(), params: z.record(z.string(), z.any()).optional(), volumeDb: z.number().optional() },
  (a) => act('duplicateChannel', a, `Canal ${a.channel} duplicado`),
);

tool(
  'replace_instrument',
  'Troca o instrumento de um canal mantendo as notas (em todos os patterns), efeitos, insert, volume, pan e automações — ex.: trocar o Clap nativo pelo clap do FL. Use preset, type (+ params), ou localSample (som da instalação local, ex. "Clap", "Grand"). Sample de bateria: a nota raiz é ajustada para a nota que o canal toca.',
  { channel: ref, preset: z.string().optional(), type: instrumentType.optional(), params: z.record(z.string(), z.any()).optional(), localSample: z.string().optional(), name: z.string().optional() },
  (a) => act('replaceInstrument', a, `Instrumento de ${a.channel} trocado`),
);

tool(
  'fill_steps',
  'Preenche os steps de um canal num pattern a cada N steps (1 = semicolcheias, 2 = colcheias, 4 = cada tempo, 8 = a cada 2 tempos, 16 = cada compasso), começando em offset (ex.: every 4 offset 2 = contratempo). Usa a nota que o canal já toca. Substitui as notas do canal nesse pattern.',
  { pattern: ref, channel: ref, every: z.number().min(1), offset: z.number().optional(), note: z.union([z.string(), z.number()]).optional(), velocity: z.number().min(0).max(1).optional() },
  (a) => act('fillSteps', a, `Steps preenchidos em ${a.channel}`),
);

tool(
  'set_pad',
  'Soundpad (canal type "pads", 16 pads 4×4): define o som de um pad — pad 1..16 (1 = embaixo à esquerda = C2, pad n = C2+n-1) — por localSample (som da instalação, ex. "Clap", "Grand"), sample (arquivo/pasta), type (+ params) ou preset; name, gain (dB), tune (semitons); clear esvazia. kit ("basico", "break") troca todos os pads. Para tocar, escreva notas C2..D#3 no canal (set_steps com note, add_notes).',
  {
    channel: ref,
    pad: z.number().min(1).max(16).optional(),
    localSample: z.string().optional(),
    sample: z.string().optional(),
    type: instrumentType.optional(),
    preset: z.string().optional(),
    params: z.record(z.string(), z.any()).optional(),
    name: z.string().optional(),
    gain: z.number().optional(),
    tune: z.number().optional(),
    clear: z.boolean().optional(),
    kit: z.string().optional(),
  },
  (a) => act('setPad', a, a.kit ? `Kit ${a.kit} em ${a.channel}` : `Pad ${a.pad} de ${a.channel}`),
);

tool('remove_channel', 'Remove um canal e suas notas.', { channel: ref }, (a) => act('removeChannel', a, `Canal ${a.channel} removido`));

// ------------------------------------------------------------ patterns e notas

tool('add_pattern', 'Cria um pattern. lengthBars fixa o comprimento (senão é automático).', { name: z.string().optional(), lengthBars: z.number().optional() }, (a) =>
  act('addPattern', a, `Pattern criado: ${a.name ?? ''}`),
);

tool(
  'edit_pattern',
  'Renomeia, muda comprimento ou cor, duplica (todas as notas, todos os canais) ou remove um pattern.',
  { pattern: ref, name: z.string().optional(), lengthBars: z.number().optional(), color: z.string().optional(), duplicate: z.boolean().optional(), remove: z.boolean().optional() },
  async ({ pattern, name, lengthBars, color, duplicate, remove }) => {
    if (remove) return act('removePattern', { pattern }, `Pattern ${pattern} removido`);
    if (duplicate) return act('duplicatePattern', { pattern, name }, `Pattern ${pattern} duplicado`);
    return act('updatePattern', { pattern, name, lengthBars, color }, `Pattern ${pattern} editado`);
  },
);

tool(
  'copy_notes',
  'Copia notas de um pattern/canal para outro pattern/canal (ex.: o Pattern 1 do Prisma para um pattern novo "Verso" no canal "Prisma Verso"). toPattern que não existe é criado com o mesmo tamanho. Opcional: trecho (fromBeat..toBeat), destino (atBeat), transpose, replace (apaga antes as notas do canal de destino).',
  { fromPattern: ref, fromChannel: ref.optional(), toPattern: z.string().describe('id/nome; criado se não existir'), toChannel: ref.optional(), fromBeat: z.number().optional(), toBeat: z.number().optional(), atBeat: z.number().optional(), transpose: z.number().optional(), replace: z.boolean().optional() },
  (a) => act('copyNotes', a, `Notas copiadas para ${a.toPattern}`),
);

tool(
  'set_steps',
  'Programa o step sequencer de um canal num pattern, estilo rack: "x---x---x---x---" (16 steps = 1 compasso). x = nota, X = acento, o = fraca, - = vazio. Substitui as notas do canal nesse pattern.',
  { pattern: ref, channel: ref, steps: z.string(), note: z.union([z.string(), z.number()]).optional().describe('padrão C4'), velocity: z.number().optional() },
  (a) => act('setSteps', a, `Steps em ${a.channel}`),
);

tool(
  'add_notes',
  'Escreve notas no piano roll de um canal. replace=true apaga as notas anteriores do canal nesse pattern.',
  { pattern: ref, channel: ref, notes: z.array(noteSchema), replace: z.boolean().optional() },
  (a) => act('addNotes', a, `${a.notes.length} notas em ${a.channel}`),
);

tool(
  'add_chords',
  'Escreve uma progressão de acordes (cifras "Am7", "F/C" ou graus "vi", "IV" com key/scale). Opções: ritmo em steps por acorde ("x--x--x-", "_" sustenta), arpejo, voice leading automático e baixo num segundo canal.',
  {
    pattern: ref,
    channel: ref,
    chords: z.array(z.string()),
    key: z.string().optional(),
    scale: z.string().optional(),
    beatsPerChord: z.number().optional(),
    octave: z.number().optional(),
    rhythm: z.string().optional(),
    arp: z.enum(['up', 'down', 'updown']).optional(),
    arpRate: z.number().optional(),
    velocity: z.number().optional(),
    voiceLeading: z.boolean().optional(),
    bassChannel: ref.optional(),
    bassOctave: z.number().optional(),
    startBeat: z.number().optional(),
    replace: z.boolean().optional(),
  },
  (a) => act('addChords', a, `Acordes em ${a.channel}: ${a.chords.join(' ')}`),
);

tool('clear_notes', 'Apaga notas de um pattern (tudo, um canal, ou um trecho em beats).', { pattern: ref, channel: ref.optional(), fromBeat: z.number().optional(), toBeat: z.number().optional() }, (a) =>
  act('clearNotes', a, `Notas apagadas em ${a.pattern}`),
);

tool(
  'transform_notes',
  'Transforma notas de um pattern/canal (filtros: trecho fromBeat..toBeat e faixa lowNote..highNote). Por nota: transpose, quantize (grade em beats) + strength 0..1, humanizeTiming (beats), humanizeVelocity, velocityScale/setVelocity, lengthScale/setLength (beats), shiftBeats. No conjunto: reverse (espelha no tempo), legato (cada nota até a próxima), strum (beats entre as notas de um acorde; negativo = de cima para baixo), chop (picota em pedaços de N beats), addOctave (±1/±2: dobra na oitava).',
  {
    pattern: ref,
    channel: ref.optional(),
    fromBeat: z.number().optional(),
    toBeat: z.number().optional(),
    lowNote: z.union([z.string(), z.number()]).optional(),
    highNote: z.union([z.string(), z.number()]).optional(),
    transpose: z.number().optional(),
    quantize: z.number().optional(),
    strength: z.number().optional(),
    humanizeTiming: z.number().optional(),
    humanizeVelocity: z.number().optional(),
    velocityScale: z.number().optional(),
    setVelocity: z.number().min(0).max(1).optional(),
    lengthScale: z.number().optional(),
    setLength: z.number().optional(),
    shiftBeats: z.number().optional(),
    reverse: z.boolean().optional(),
    legato: z.boolean().optional(),
    strum: z.number().optional(),
    chop: z.number().optional(),
    addOctave: z.number().optional(),
  },
  (a) => act('transformNotes', a, `Notas transformadas em ${a.pattern}`),
);

// ------------------------------------------------------------ playlist

tool(
  'arrange',
  'Monta a playlist: coloca patterns em tracks/compassos (bars = duração do clip; o pattern repete dentro do clip; repeat = cópias seguidas) e/ou remove clips.',
  {
    place: z.array(z.object({ pattern: ref, track: z.number().optional(), bar: z.number(), bars: z.number().optional(), repeat: z.number().optional() })).optional(),
    remove: z.object({ track: z.number().optional(), fromBar: z.number().optional(), toBar: z.number().optional(), pattern: ref.optional(), clipIds: z.array(z.string()).optional() }).optional(),
  },
  async ({ place, remove }) => {
    const actions: { name: string; args: unknown }[] = [];
    if (remove) actions.push({ name: 'removeClips', args: strip(remove) });
    for (const p of place ?? []) actions.push({ name: 'placePattern', args: strip(p) });
    const r = await api('POST', '/api/actions', { actions, origin: 'mcp', label: 'Playlist atualizada' });
    return r.results;
  },
);

tool(
  'add_audio_clip',
  'Coloca um arquivo de áudio (vocal, loop, gravação) na playlist como clipe, tocando no tempo da música. Sem bars/lengthSec usa a duração do arquivo. insert = insert do mixer para onde o áudio vai.',
  { sample: z.string().describe('caminho do arquivo'), bar: z.number().optional(), beat: z.number().optional(), track: z.number().optional(), bars: z.number().optional(), lengthSec: z.number().optional(), startSec: z.number().optional(), gain: z.number().optional(), insert: z.union([z.number(), z.string()]).optional() },
  (a) => act('addAudioClip', a, 'Clipe de áudio na playlist'),
);

const fnSchema = z
  .object({
    preset: z.string().optional().describe(`função pronta: ${GEN_PRESETS.map((x) => x.id).join(', ')}`),
    kind: z.enum(['ramp', 'lfo', 'pump', 'steps', 'random']).optional(),
    wave: z.enum(['sine', 'tri', 'square', 'saw', 'sawdown']).optional(),
    from: z.number().optional().describe('rampa/escada: valor inicial (unidade do parâmetro)'),
    to: z.number().optional().describe('rampa/escada: valor final'),
    min: z.number().optional().describe('ondas: mínimo (unidade do parâmetro)'),
    max: z.number().optional().describe('ondas: máximo'),
    curve: z.number().min(-1).max(1).optional(),
    s: z.boolean().optional(),
    period: z.number().optional().describe('tempos (0.25 = semicolcheia)'),
    periodEnd: z.number().optional().describe('período no fim (acelera/desacelera)'),
    breathe: z.number().min(0).max(2).optional(),
    breathePeriod: z.number().optional(),
    depth: z.number().min(0).max(1).optional(),
    depthEnd: z.number().min(0).max(1).optional(),
    phase: z.number().min(0).max(1).optional(),
    release: z.number().min(0).max(1).optional(),
    count: z.number().optional(),
    smooth: z.number().min(0).max(1).optional(),
    seed: z.number().optional(),
    grid: z.number().optional().describe('grade em tempos (0 = livre)'),
    quantize: z.boolean().optional().describe('LFO: ciclos na grade'),
  })
  .describe('função da Central de Automações (ver list_sounds kind "automation")');

tool(
  'add_automation',
  'Cria um clipe de automação na playlist (só toca no modo song). Alvo: channel + param ("volume", "pan" ou parâmetro do instrumento, ex. "cutoff"), insert + param, channel/insert + effect + param do efeito, ou param "bpm" sozinho (andamento). Forma: fn (funções da Central: riser, fades, seno, wobble, gate, bombeamento, escada, aleatório — recalculam ao redimensionar e abrem na Central) ou points [{beat, value}] na unidade do parâmetro; sem nada, uma linha no valor atual. bars = tamanho (padrão 4).',
  {
    channel: ref.optional(),
    insert: z.union([z.number(), z.string()]).optional(),
    effect: z.union([z.string(), z.number()]).optional(),
    param: z.string(),
    bar: z.number().optional(),
    bars: z.number().optional(),
    track: z.number().optional(),
    fn: fnSchema.optional(),
    points: z.array(z.object({ beat: z.number(), value: z.number() })).optional(),
  },
  (a) => act('automate', a, `Automação: ${a.param}`),
);

tool(
  'edit_automation',
  'Ajusta um clipe de automação existente (id em get_clips): fn muda a função (mescla com a atual; preset troca a forma), points troca por pontos (vira personalizada), custom:false volta à função. Para mover/redimensionar/duplicar use edit_clips.',
  { clip: z.string(), fn: fnSchema.optional(), points: z.array(z.object({ beat: z.number(), value: z.number() })).optional(), custom: z.boolean().optional() },
  (a) => act('editAutomation', a, 'Automação ajustada'),
);

tool(
  'edit_clips',
  'Edita clipes da playlist (patterns, áudios, automações), escolhidos por clipIds ou filtro (track, fromBar/toBar, pattern, kind, automation). Mover: moveBars/moveTracks (relativo) ou toBar/toTrack (o primeiro do grupo vai para lá). lengthBars: novo tamanho. trimStartBars: corta (>0) ou estende (<0) o começo sem deslocar o conteúdo. mute, gainDb e insert (áudio). duplicate: {times, toBar?, toTrack?} cópias logo depois do grupo (ou a partir de toBar). remove: apaga.',
  {
    ...clipFilter,
    moveBars: z.number().optional(),
    moveTracks: z.number().optional(),
    toBar: z.number().optional(),
    toTrack: z.number().optional(),
    lengthBars: z.number().optional(),
    trimStartBars: z.number().optional(),
    mute: z.boolean().optional(),
    gainDb: z.number().optional(),
    insert: z.union([z.number(), z.string()]).optional(),
    duplicate: z.object({ times: z.number().optional(), toBar: z.number().optional(), toTrack: z.number().optional() }).optional(),
    remove: z.boolean().optional(),
  },
  (a) => act('editClips', a, 'Clipes editados'),
);

tool(
  'copy_section',
  'Copia um trecho da música (compassos fromBar..toBar, todas as tracks ou só as listadas em tracks) para atBar — patterns, áudios e automações (com a função). insert=true abre espaço (o que vem depois anda). times = cópias seguidas. Ex.: repetir a intro, copiar o refrão para o fim.',
  { fromBar: z.number(), toBar: z.number(), atBar: z.number(), insert: z.boolean().optional(), times: z.number().optional(), tracks: z.array(z.number()).optional() },
  (a) => act('copySection', a, `Trecho ${a.fromBar}-${a.toBar} copiado para ${a.atBar}`),
);

tool('insert_bars', 'Abre espaço na música: tudo que começa em atBar ou depois anda `bars` compassos para a direita.', { atBar: z.number(), bars: z.number() }, (a) =>
  act('insertBars', a, `${a.bars} compassos inseridos no ${a.atBar}`),
);

tool('delete_bars', 'Apaga os compassos fromBar..toBar (inclusive) de todas as tracks e puxa o resto para a esquerda (clipes que atravessam são cortados).', { fromBar: z.number(), toBar: z.number() }, (a) =>
  act('deleteBars', a, `Compassos ${a.fromBar}-${a.toBar} apagados`),
);

tool('update_track', 'Renomeia, muta ou muda a cor de uma track da playlist.', { track: z.number(), name: z.string().optional(), mute: z.boolean().optional(), color: z.string().optional() }, (a) => act('updateTrack', a, `Track ${a.track} ajustada`));

// ------------------------------------------------------------ mixer

tool(
  'mixer_insert',
  'Ajusta um insert do mixer (0 = master): nome, volume dB, pan, mute, solo e saída (roteia para outro insert, ex. um bus).',
  { insert: z.union([z.number(), z.string()]), name: z.string().optional(), volumeDb: z.number().optional(), pan: z.number().optional(), mute: z.boolean().optional(), solo: z.boolean().optional(), output: z.union([z.number(), z.string()]).optional() },
  (a) => act('updateInsert', a, `Mixer: insert ${a.insert}`),
);

tool('reset_insert', 'Volta um insert do mixer ao padrão (nome "Insert N", volume, pan, sem efeitos, saída no master). O mixer tem posições fixas: é assim que se "remove" um insert. Canais ligados a ele continuam ligados.', { insert: z.union([z.number(), z.string()]) }, (a) =>
  act('resetInsert', a, `Insert ${a.insert} resetado`),
);

tool(
  'copy_effects',
  'Copia a cadeia de efeitos de um canal/insert para outro canal/insert (com os mesmos parâmetros). replace apaga os efeitos do destino antes. Canal aceita até 4 efeitos.',
  { fromChannel: ref.optional(), fromInsert: z.union([z.number(), z.string()]).optional(), toChannel: ref.optional(), toInsert: z.union([z.number(), z.string()]).optional(), replace: z.boolean().optional() },
  (a) => act('copyEffects', a, 'Efeitos copiados'),
);

const effectType = z.enum(['phaser', 'eq', 'filter', 'compressor', 'delay', 'reverb', 'chorus', 'distortion', 'bitcrusher', 'stereo', 'limiter']);

const target = {
  insert: z.union([z.number(), z.string()]).optional().describe('insert do mixer (0 = master)'),
  channel: ref.optional().describe('ou: canal do rack (até 4 efeitos próprios, antes do mixer)'),
};
const where = (a: { insert?: unknown; channel?: string }) => {
  if (a.channel) return { kind: 'channel' as const, label: `canal ${a.channel}` };
  if (a.insert === undefined) throw new Error('Informe insert ou channel');
  return { kind: 'insert' as const, label: `insert ${a.insert}` };
};

tool(
  'add_effect',
  'Adiciona um efeito num insert do mixer ou direto num canal (channel: até 4 efeitos por canal). mix = dry/wet. Compressor no mixer aceita params.sidechain = número do insert que dispara o ducking (ex.: o do kick).',
  { ...target, type: effectType, params: z.record(z.string(), z.any()).optional(), mix: z.number().min(0).max(1).optional(), index: z.number().optional() },
  (a) => {
    const w = where(a);
    return w.kind === 'channel' ? act('addChannelEffect', { ...a, insert: undefined }, `Efeito ${a.type} no ${w.label}`) : act('addEffect', { ...a, channel: undefined }, `Efeito ${a.type} no ${w.label}`);
  },
);

tool(
  'update_effect',
  'Altera um efeito (por id, tipo ou posição) de um insert ou de um canal: parâmetros, mix, ligado/desligado (no canal, também pode trocar o tipo).',
  { ...target, effect: z.union([z.string(), z.number()]), type: effectType.optional(), params: z.record(z.string(), z.any()).optional(), mix: z.number().optional(), enabled: z.boolean().optional() },
  (a) => {
    const w = where(a);
    return w.kind === 'channel' ? act('updateChannelEffect', { ...a, insert: undefined }, `Efeito ajustado no ${w.label}`) : act('updateEffect', { ...a, channel: undefined, type: undefined }, `Efeito ajustado no ${w.label}`);
  },
);

tool('remove_effect', 'Remove um efeito de um insert ou de um canal.', { ...target, effect: z.union([z.string(), z.number()]) }, (a) => {
  const w = where(a);
  return w.kind === 'channel' ? act('removeChannelEffect', { ...a, insert: undefined }, `Efeito removido do ${w.label}`) : act('removeEffect', { ...a, channel: undefined }, `Efeito removido do ${w.label}`);
});

// ------------------------------------------------------------ lote

tool(
  'batch',
  'Executa várias ações de uma vez, atomicamente (um passo de undo). Nomes: addChannel, updateChannel, removeChannel, duplicateChannel, replaceInstrument, setPad, addPattern, updatePattern, removePattern, duplicatePattern, addNotes, setSteps, fillSteps, addChords, clearNotes, transformNotes, copyNotes, placePattern, removeClips, editClips, copySection, insertBars, deleteBars, updateTrack, updateInsert, resetInsert, addEffect, updateEffect, removeEffect, addChannelEffect, updateChannelEffect, removeChannelEffect, copyEffects, addAudioClip, automate (= add_automation), editAutomation, addAudio, renameAudio, removeAudio, toggleAudioEdits, setProjectProps, applyTempo (= set_tempo). Os args são iguais aos das ferramentas correspondentes (addNotes usa {pattern, channel, notes:[{note,start,length,velocity}]}). Canais/patterns criados no mesmo lote podem ser referenciados pelo nome.',
  { actions: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.any()) })), label: z.string().optional() },
  async ({ actions, label }) => (await api('POST', '/api/actions', { actions, origin: 'mcp', label: label ?? `${actions.length} edições` })).results,
);

// ------------------------------------------------------------ áudio

tool(
  'audio_pool',
  'Lista de áudios do projeto (a que fica ao lado dos patterns): add (arquivo → lista), rename, remove (só tira da lista), place (coloca na playlist em bar/track; sem bars usa o tamanho do arquivo), edits (liga/desliga as edições do Afinador: on true/false; o original nunca se perde).',
  {
    action: z.enum(['add', 'rename', 'remove', 'place', 'edits']),
    audio: z.string().optional().describe('id, nome ou caminho (rename/remove/place/edits)'),
    path: z.string().optional().describe('add: caminho do arquivo'),
    name: z.string().optional(),
    bar: z.number().optional(),
    beat: z.number().optional(),
    track: z.number().optional(),
    bars: z.number().optional(),
    startSec: z.number().optional(),
    lengthSec: z.number().optional(),
    on: z.boolean().optional(),
  },
  async (a) => {
    if (a.action === 'add') return act('addAudio', { path: a.path, name: a.name }, 'Áudio na lista');
    if (a.action === 'rename') return act('renameAudio', { audio: a.audio, name: a.name }, 'Áudio renomeado');
    if (a.action === 'remove') return act('removeAudio', { audio: a.audio }, 'Áudio tirado da lista');
    if (a.action === 'edits') return act('toggleAudioEdits', { audio: a.audio, on: a.on }, 'Edições do áudio');
    const it = audioRef(await project(), a.audio ?? '');
    return act('addAudioClip', { sample: it.path, bar: a.bar ?? 1, beat: a.beat, track: a.track, bars: a.bars, startSec: a.startSec, lengthSec: a.lengthSec }, `${it.name} na playlist`);
  },
);

const windowId = z.enum(['rack', 'piano', 'playlist', 'mixer', 'channel', 'amp', 'tune', 'stitch', 'autos']);
tool(
  'ui',
  'Controla a interface aberta (como o usuário faria): select [compassoInicial, compassoFinal] marca a área (play e loop usam ela; null tira), loop/metronome/countIn liga ou desliga, follow (a tela segue a agulha), mode pattern/song, seekBar (agulha), pattern/channel (seleciona; o piano roll mostra), open/close janelas (rack, piano, playlist, mixer, channel, amp, tune = Afinador, stitch = Stitcher, autos = Central de Automações), automation (abre um clipe de automação na Central), message (aviso na tela). O estado atual aparece em get_project.ui.',
  {
    select: z.tuple([z.number(), z.number()]).nullable().optional(),
    loop: z.boolean().optional(),
    metronome: z.boolean().optional(),
    countIn: z.boolean().optional(),
    follow: z.boolean().optional(),
    mode: z.enum(['pattern', 'song']).optional(),
    seekBar: z.number().optional(),
    pattern: ref.optional(),
    channel: ref.optional(),
    open: z.union([windowId, z.array(windowId)]).optional(),
    close: z.union([windowId, z.array(windowId)]).optional(),
    automation: z.string().optional().describe('id do clipe de automação'),
    message: z.string().optional(),
  },
  (a) => api('POST', '/api/ui', a),
);

tool(
  'transport',
  'Controla a reprodução na interface aberta: play/stop, modo pattern ou song, pattern e compasso inicial. Requer o app aberto no navegador.',
  { action: z.enum(['play', 'stop']), mode: z.enum(['pattern', 'song']).optional(), pattern: ref.optional(), bar: z.number().optional() },
  (a) => api('POST', '/api/transport', a),
);

tool(
  'preview_notes',
  'Toca notas soltas num canal na interface (para mostrar uma ideia ao usuário sem gravar no projeto).',
  { channel: ref, notes: z.array(noteSchema) },
  (a) => api('POST', '/api/preview', a),
);

tool(
  'render',
  'Renderiza para WAV (song inteira, trecho de compassos ou um pattern) e devolve o caminho, análise de loudness/picos/frequências e nível de cada insert.',
  { mode: z.enum(['song', 'pattern']).optional(), pattern: ref.optional(), fromBar: z.number().optional(), toBar: z.number().optional(), out: z.string().optional(), bits: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional() },
  (a) => api('POST', '/api/render', a),
);

tool(
  'analyze_mix',
  'Renderiza sem salvar e devolve diagnóstico de mix: LUFS integrado, pico, crest factor, correlação estéreo, balanço por bandas e pico/RMS por insert, com observações.',
  { mode: z.enum(['song', 'pattern']).optional(), pattern: ref.optional(), fromBar: z.number().optional(), toBar: z.number().optional() },
  (a) => api('POST', '/api/render', { ...a, save: false }),
);

tool(
  'detect_bpm',
  'Detecta o BPM de um áudio: um clipe da playlist (clip = id do get_clips; analisa só o trecho que o clipe toca), um item da lista de áudios (audio = id ou nome) ou um arquivo (path). Devolve bpm, confiança (0..1), firstBeat (s no arquivo) e alternativas (metade/dobro). apply: true muda o BPM do projeto para o detectado, mantendo a duração dos clipes de áudio; com clip, ainda move esse clipe para o primeiro tempo cair num começo de compasso (align: false não move).',
  {
    clip: z.string().optional(),
    audio: z.string().optional(),
    path: z.string().optional(),
    apply: z.boolean().optional(),
    align: z.boolean().optional(),
    min: z.number().optional().describe('BPM mínimo procurado (padrão 60)'),
    max: z.number().optional().describe('BPM máximo procurado (padrão 200)'),
  },
  (a) => api('POST', '/api/tempo', a),
);

tool(
  'set_tempo',
  'Muda o BPM do projeto mantendo a duração em segundos dos clipes de áudio (eles não ficam cortados nem com sobra). Com clip + firstBeat (de detect_bpm), alinha esse clipe à grade. Para só trocar o número sem mexer nos áudios, use set_project.',
  { bpm: z.number(), clip: z.string().optional(), firstBeat: z.number().optional(), align: z.boolean().optional() },
  (a) => api('POST', '/api/actions', { actions: [{ name: 'applyTempo', args: a }], label: `BPM: ${a.bpm}` }),
);

await server.connect(new StdioServerTransport());
