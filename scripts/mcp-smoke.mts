// Teste ponta a ponta do servidor MCP: monta um beat só com ferramentas MCP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/main.ts'], env: { ...process.env } as any });
const c = new Client({ name: 'smoke', version: '1' });
await c.connect(t);
const tools = await c.listTools();
console.log('ferramentas:', tools.tools.length, tools.tools.map((x) => x.name).join(', '));
const call = async (name: string, args: any = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  const txt = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${txt}`);
  return txt;
};
await call('new_project', { name: 'Batida MCP', bpm: 126 });
console.log(await call('batch', { label: 'Beat house', actions: [
  { name: 'addChannel', args: { preset: 'Kick' } },
  { name: 'addChannel', args: { preset: 'Clap' } },
  { name: 'addChannel', args: { preset: 'Hat' } },
  { name: 'addChannel', args: { preset: 'Open Hat' } },
  { name: 'addChannel', args: { preset: 'Acid Bass', name: 'Baixo' } },
  { name: 'addChannel', args: { preset: 'Warm Pad', name: 'Pad' } },
  { name: 'addChannel', args: { preset: 'Pluck Lead', name: 'Lead' } },
  { name: 'updatePattern', args: { pattern: 'Pattern 1', name: 'Drums' } },
  { name: 'setSteps', args: { pattern: 'Drums', channel: 'Kick', steps: 'x---x---x---x---' } },
  { name: 'setSteps', args: { pattern: 'Drums', channel: 'Clap', steps: '----x-------x---' } },
  { name: 'setSteps', args: { pattern: 'Drums', channel: 'Hat', steps: 'x-x-x-x-x-x-x-xo' } },
  { name: 'setSteps', args: { pattern: 'Drums', channel: 'Open Hat', steps: '--x---x---x---x-' } },
  { name: 'addPattern', args: { name: 'Harmonia' } },
  { name: 'addChords', args: { pattern: 'Harmonia', channel: 'Pad', chords: ['Am9', 'Fmaj7', 'C', 'G6'], octave: 4 } },
  { name: 'addNotes', args: { pattern: 'Harmonia', channel: 'Baixo', notes: [
    { note: 'A1', start: 0, length: 0.5 }, { note: 'A2', start: 0.75, length: 0.25 }, { note: 'A1', start: 1.5, length: 0.5 }, { note: 'G1', start: 3.5, length: 0.25, slide: true },
    { note: 'F1', start: 4, length: 0.5 }, { note: 'F2', start: 4.75, length: 0.25 }, { note: 'F1', start: 5.5, length: 0.5 },
    { note: 'C2', start: 8, length: 0.5 }, { note: 'C3', start: 8.75, length: 0.25 }, { note: 'C2', start: 9.5, length: 0.5 },
    { note: 'G1', start: 12, length: 0.5 }, { note: 'G2', start: 12.75, length: 0.25 }, { note: 'B1', start: 14, length: 0.5 } ] } },
  { name: 'addPattern', args: { name: 'Melodia' } },
  { name: 'addNotes', args: { pattern: 'Melodia', channel: 'Lead', notes: [
    { note: 'E5', start: 0, length: 0.5 }, { note: 'C5', start: 0.75, length: 0.25 }, { note: 'A4', start: 1.5, length: 0.5 }, { note: 'C5', start: 2.5, length: 0.5 },
    { note: 'F5', start: 4, length: 0.5 }, { note: 'E5', start: 4.75, length: 0.25 }, { note: 'C5', start: 5.5, length: 1 },
    { note: 'G5', start: 8, length: 0.5 }, { note: 'E5', start: 8.75, length: 0.25 }, { note: 'C5', start: 9.5, length: 0.5 }, { note: 'D5', start: 12, length: 1.5 } ] } },
  { name: 'placePattern', args: { pattern: 'Drums', track: 1, bar: 1, bars: 16 } },
  { name: 'placePattern', args: { pattern: 'Harmonia', track: 2, bar: 5, bars: 12 } },
  { name: 'placePattern', args: { pattern: 'Melodia', track: 3, bar: 9, bars: 8 } },
  { name: 'updateTrack', args: { track: 1, name: 'Bateria' } },
  { name: 'updateTrack', args: { track: 2, name: 'Harmonia' } },
  { name: 'updateTrack', args: { track: 3, name: 'Melodia' } },
] }));
const sum = JSON.parse(await call('get_project'));
const ins = (n: string) => sum.channels.find((c: any) => c.name === n).insert;
await call('add_effect', { insert: ins('Pad'), type: 'compressor', params: { sidechain: ins('Kick'), threshold: -32, ratio: 8, release: 180 } });
await call('add_effect', { insert: ins('Pad'), type: 'reverb', mix: 0.35, params: { size: 0.85 } });
await call('add_effect', { insert: ins('Lead'), type: 'delay', mix: 0.3 });
await call('add_effect', { insert: ins('Baixo'), type: 'distortion', params: { drive: 9 } });
await call('add_effect', { insert: 0, type: 'limiter', params: { gain: 3 } });
console.log(await call('get_notes', { pattern: 'Harmonia', channel: 'Pad' }));
const an = JSON.parse(await call('analyze_mix', {}));
console.log(JSON.stringify(an.analysis), JSON.stringify(an.inserts));
console.log(await call('save_project', {}));
await c.close();
