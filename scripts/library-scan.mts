import { candidateSources, scanLibrary } from '../src/server/library.ts';
const t = performance.now();
const src = candidateSources();
const ix = await scanLibrary(src);
console.log(`varredura em ${((performance.now() - t) / 1000).toFixed(1)} s`);
src.forEach((s, i) => console.log(`- ${s.label}: ${ix.files.filter((f) => f.s === i).length} samples, ${ix.instruments.filter((x) => x.s === i).length} instrumentos  (${s.root})`));
const cats: Record<string, number> = {};
for (const f of ix.files) cats[f.c] = (cats[f.c] ?? 0) + 1;
console.log('categorias:', cats, '| instrumentos:', ix.instruments.length, ix.instruments.slice(0, 8).map((i) => i.name).join(', '), '…');
