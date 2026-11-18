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

const PORT = Number(process.env.BATUQUE_PORT ?? 7717);
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
      'Use batch para muitas edições de uma vez (é atômico e vira um único passo de undo).',
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

tool(
  'list_sounds',
  'Catálogo: presets de instrumento, tipos de instrumento e efeitos com seus parâmetros (faixas e padrões).',
  { kind: z.enum(['presets', 'samples', 'instruments', 'effects']).optional(), name: z.string().optional().describe('detalhar um tipo específico') },
  async ({ kind, name }) => {
    const r = await api('GET', '/api/registry');
    const summarize = (o: Record<string, any>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, name ? v : { label: v.label, description: v.description, params: v.params.map((p: any) => `${p.key}${p.kind === 'num' ? ` ${p.min}..${p.max}${p.unit ? ' ' + p.unit : ''}` : p.kind === 'enum' ? ` [${p.options.join('|')}]` : ` (${p.kind})`}`).join(', ') }]));
    if (name) {
      const v = r.instruments[name] ?? r.effects[name] ?? r.presets[name];
      if (!v) throw new Error(`Nada chamado ${name}`);
      return v;
    }
    if (kind === 'samples') return { bateria: r.localSamples.map((x: any) => x.name), instrumentos: r.localInstruments.map((x: any) => `${x.name} (${x.category})`) };
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

tool('save_project', 'Salva o projeto (.batuque). Sem path usa o arquivo atual ou ~/MusicLabs/Projetos/<nome>.batuque.', { path: z.string().optional() }, (a) => api('POST', '/api/save', a));

tool(
  'open_project',
  'Abre um .batuque ou importa um .flp do FL Studio (canais, patterns, notas, playlist, mixer; plugins do FL viram instrumentos nativos equivalentes). Se o relatório vier com locked=true, o .flp foi salvo por um FL não registrado: o FL embaralha tempo e outros valores nesses arquivos (trava de licença) e eles ficam no padrão; pergunte o BPM ao usuário. Não tente decodificar esses valores.',
  { path: z.string() },
  (a) => api('POST', '/api/open', a),
);

tool('list_projects', 'Lista projetos salvos em ~/MusicLabs/Projetos.', {}, () => api('GET', '/api/projects'));

tool('undo', 'Desfaz a última edição.', {}, () => api('POST', '/api/undo'));
tool('redo', 'Refaz.', {}, () => api('POST', '/api/redo'));

// ------------------------------------------------------------ canais

const instrumentType = z.enum(['synth', 'prisma', 'sampler', 'drum', 'pluck', 'fm']);

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
  'Altera um canal: nome, volume (dB), pan, pitch (semitons), mute, insert do mixer, preset, tipo ou parâmetros do instrumento.',
  {
    channel: ref,
    name: z.string().optional(),
    volumeDb: z.number().optional(),
    pan: z.number().optional(),
    pitch: z.number().optional(),
    mute: z.boolean().optional(),
    insert: z.union([z.number(), z.string()]).optional(),
    preset: z.string().optional(),
    type: instrumentType.optional(),
    params: z.record(z.string(), z.any()).optional(),
  },
  (a) => act('updateChannel', a, `Canal ${a.channel} ajustado`),
);

tool('remove_channel', 'Remove um canal e suas notas.', { channel: ref }, (a) => act('removeChannel', a, `Canal ${a.channel} removido`));

// ------------------------------------------------------------ patterns e notas

tool('add_pattern', 'Cria um pattern. lengthBars fixa o comprimento (senão é automático).', { name: z.string().optional(), lengthBars: z.number().optional() }, (a) =>
  act('addPattern', a, `Pattern criado: ${a.name ?? ''}`),
);

tool(
  'edit_pattern',
  'Renomeia, muda comprimento, duplica ou remove um pattern.',
  { pattern: ref, name: z.string().optional(), lengthBars: z.number().optional(), duplicate: z.boolean().optional(), remove: z.boolean().optional() },
  async ({ pattern, name, lengthBars, duplicate, remove }) => {
    if (remove) return act('removePattern', { pattern }, `Pattern ${pattern} removido`);
    if (duplicate) return act('duplicatePattern', { pattern, name }, `Pattern ${pattern} duplicado`);
    return act('updatePattern', { pattern, name, lengthBars }, `Pattern ${pattern} editado`);
  },
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
  'Transforma notas de um pattern/canal: transpor, quantizar (grade em beats, força 0..1), humanizar timing (beats) e velocity, escalar velocity/duração.',
  {
    pattern: ref,
    channel: ref.optional(),
    transpose: z.number().optional(),
    quantize: z.number().optional(),
    strength: z.number().optional(),
    humanizeTiming: z.number().optional(),
    humanizeVelocity: z.number().optional(),
    velocityScale: z.number().optional(),
    lengthScale: z.number().optional(),
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

tool('update_track', 'Renomeia ou muta uma track da playlist.', { track: z.number(), name: z.string().optional(), mute: z.boolean().optional() }, (a) => act('updateTrack', a, `Track ${a.track} ajustada`));

// ------------------------------------------------------------ mixer

tool(
  'mixer_insert',
  'Ajusta um insert do mixer (0 = master): nome, volume dB, pan, mute, solo e saída (roteia para outro insert, ex. um bus).',
  { insert: z.union([z.number(), z.string()]), name: z.string().optional(), volumeDb: z.number().optional(), pan: z.number().optional(), mute: z.boolean().optional(), solo: z.boolean().optional(), output: z.union([z.number(), z.string()]).optional() },
  (a) => act('updateInsert', a, `Mixer: insert ${a.insert}`),
);

const effectType = z.enum(['eq', 'filter', 'compressor', 'delay', 'reverb', 'chorus', 'distortion', 'bitcrusher', 'stereo', 'limiter']);

tool(
  'add_effect',
  'Adiciona um efeito num insert. mix = dry/wet. Compressor aceita params.sidechain = número do insert que dispara o ducking (ex.: o do kick).',
  { insert: z.union([z.number(), z.string()]), type: effectType, params: z.record(z.string(), z.any()).optional(), mix: z.number().min(0).max(1).optional(), index: z.number().optional() },
  (a) => act('addEffect', a, `Efeito ${a.type} no insert ${a.insert}`),
);

tool(
  'update_effect',
  'Altera um efeito (por id, tipo ou posição no insert): parâmetros, mix, ligado/desligado.',
  { insert: z.union([z.number(), z.string()]), effect: z.union([z.string(), z.number()]), params: z.record(z.string(), z.any()).optional(), mix: z.number().optional(), enabled: z.boolean().optional() },
  (a) => act('updateEffect', a, `Efeito ajustado no insert ${a.insert}`),
);

tool('remove_effect', 'Remove um efeito de um insert.', { insert: z.union([z.number(), z.string()]), effect: z.union([z.string(), z.number()]) }, (a) =>
  act('removeEffect', a, `Efeito removido do insert ${a.insert}`),
);

// ------------------------------------------------------------ lote

tool(
  'batch',
  'Executa várias ações de uma vez, atomicamente (um passo de undo). Nomes: addChannel, updateChannel, removeChannel, addPattern, updatePattern, removePattern, duplicatePattern, addNotes, setSteps, addChords, clearNotes, transformNotes, placePattern, removeClips, updateTrack, updateInsert, addEffect, updateEffect, removeEffect, setProjectProps. Os args são iguais aos das ferramentas correspondentes (addNotes usa {pattern, channel, notes:[{note,start,length,velocity}]}). Canais/patterns criados no mesmo lote podem ser referenciados pelo nome.',
  { actions: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.any()) })), label: z.string().optional() },
  async ({ actions, label }) => (await api('POST', '/api/actions', { actions, origin: 'mcp', label: label ?? `${actions.length} edições` })).results,
);

// ------------------------------------------------------------ áudio

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

await server.connect(new StdioServerTransport());
