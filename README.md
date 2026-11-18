# Music Labs

DAW open source para Linux com o fluxo de trabalho de rack de canais, piano roll,
playlist e mixer, e um **servidor MCP** embutido para produzir junto com o Claude.

Roda no navegador (Chrome em modo app) com áudio em AudioWorklet. A mesma engine
roda no Node para render offline e análise de mix.

```bash
npm install
npm run build
bin/musiclabs          # sobe o servidor (porta 7717) e abre a interface
```

Há um atalho no menu de aplicativos ("Music Labs") e o comando `musiclabs` em `~/.local/bin`.

## O que tem

- **Rack de canais** com step sequencer (16+ steps, pintar arrastando, mute/solo,
  volume/pan, insert do mixer) e mini piano roll para canais melódicos.
- **Piano roll**: desenhar, mover, redimensionar, apagar com o botão direito, seleção
  por retângulo (Ctrl+arrastar), duplicar (Ctrl+D), transpor com as setas, faixa de
  velocity, snap (inclusive tercinas), destaque de escala, ghost notes dos outros
  canais, quantizar e humanizar.
- **Playlist**: pintar patterns, mover, duplicar (Shift+arrastar), redimensionar (o
  pattern repete dentro do clip), região de loop, tracks com mute.
- **Mixer**: 16 inserts + master, fader, pan, mute/solo, medidores, roteamento entre
  inserts (buses), até 10 efeitos por insert com dry/wet.
- **Instrumentos nativos**: Prisma (sintetizador aditivo espectral: filtro harmônico
  sem aliasing, pluck, phaser no espectro, unison de 8 vozes, camadas de oitava,
  envelopes arrastáveis, ensemble), Synth subtrativo (2 osc + sub, unison até 7, filtro com
  envelope, LFO, glide/mono), Sampler (arquivos ou instrumentos multi-sample de pastas,
  segura/solta com loop de sustentação, raiz detectada por afinação, grupos de corte), Drum Synth (kick, 808, snare, clap, hats, tom, rim,
  perc, e modo "kit" com mapa GM), Pluck (Karplus-Strong) e FM.
- **Efeitos**: EQ 4 bandas + HPF, filtro com LFO sincronizado, compressor com
  **sidechain**, delay sincronizado (ping-pong), reverb, chorus, saturação, bitcrusher,
  imagem estéreo (mono abaixo de X Hz) e limiter.
- **Importa .flp do FL Studio**: canais, patterns, notas, playlist, nomes do mixer e
  roteamento canal→insert. Samples são resolvidos na instalação do Wine; plugins do FL
  viram o instrumento nativo mais próximo (FPC → kit, baixo → reese, pad → pad...).
- Navegador de samples (packs do FL instalados, ~/Música, Downloads, ~/MusicLabs/Samples)
  com busca, pré-escuta e arrastar para o rack.
- Teclado do computador como piano (Z…M / Q…P, `-` e `=` mudam a oitava), teclado MIDI
  (Web MIDI), undo/redo ilimitado, autosave, exportação WAV 16/24/32-bit.

Atalhos: Espaço tocar/parar · L pattern/song · F5 playlist · F6 rack · F7 piano roll ·
F8 navegador · F9 mixer · Ctrl+S salvar · Ctrl+Z/Y desfazer/refazer.

## MCP

```bash
claude mcp add -s user musiclabs -- node /caminho/para/batuque/build/mcp.mjs
```

O MCP sobe o servidor sozinho se o app não estiver aberto. Toda edição aparece na hora
na interface, com aviso "Claude · …". Ferramentas:

| grupo | ferramentas |
| --- | --- |
| leitura | `get_project`, `get_notes`, `list_sounds`, `search_samples`, `music_theory` |
| projeto | `new_project`, `set_project`, `save_project`, `open_project` (.batuque e .flp), `list_projects`, `undo`, `redo` |
| canais | `add_channel`, `update_channel`, `remove_channel` |
| notas | `add_pattern`, `edit_pattern`, `set_steps`, `add_notes`, `add_chords`, `clear_notes`, `transform_notes` |
| arranjo | `arrange`, `update_track` |
| mixer | `mixer_insert`, `add_effect`, `update_effect`, `remove_effect` |
| lote | `batch` (várias ações atômicas = um undo) |
| áudio | `transport`, `preview_notes`, `render`, `analyze_mix` (LUFS, pico, crest, correlação, bandas, nível por insert) |

## Arquitetura

```
src/core     modelo, ops (edição sincronizada + undo), ações, teoria, DSP,
             instrumentos, efeitos, engine, análise, WAV, importador .flp
src/server   HTTP + WebSocket (127.0.0.1), estado do projeto, samples (ffmpeg), render
src/mcp      servidor MCP (stdio) que fala com o servidor HTTP
src/web      interface Preact + AudioWorklet com a engine
```

## Sobre o FL Studio

O Music Labs é um projeto original. Nenhum código, binário, plugin, arte ou marca da
Image-Line foi copiado ou decompilado. A compatibilidade com `.flp` foi feita a partir
dos arquivos de projeto (dados) gerados por uma instalação legítima e da documentação
pública do formato, apenas para interoperabilidade. Os packs de samples do FL só são
lidos localmente da sua instalação; nada é redistribuído.

## Limitações atuais

- Sem hospedagem de plugins VST/LV2/CLAP (próximo passo: ponte via Carla/yabridge).
- Sem gravação de áudio, clips de áudio na playlist ou automação.
- Plugins do FL no import são aproximados por instrumentos nativos; efeitos do mixer
  do FL não são importados.
