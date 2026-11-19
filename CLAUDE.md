# Music Labs — guia para o Claude

DAW open source (GPL-3.0) com fluxo de trabalho familiar a quem usa FL Studio (rack de
canais, piano roll, playlist, mixer), visual próprio e um servidor **MCP** para o Claude
produzir junto. Código em `~/batuque` (o nome antigo da pasta ficou; o produto é
**Music Labs**). Repositório público: `github.com/Felpes-Freitas/music-labs`.

Sempre responder ao usuário em **português do Brasil**. Comentários de código, textos da
interface, mensagens de commit e documentação também em português.

---

## 1. Regras e preferências do usuário (importantes)

- **Nada de copiar o FL Studio**: experiência parecida, visual e nomes próprios. O nome
  não pode conter "FL". Engenharia reversa só para interoperabilidade (importar `.flp`,
  ler samples da instalação do usuário no Wine). Nomes de marcas de terceiros também não:
  o editor tipo "Melodyne" se chama **Afinador**; o comping é o **Stitcher** (nome dado
  pelo usuário).
- **Interface nativa do app, nunca diálogos do navegador**: nada de `alert`/`confirm`/
  `prompt`. Use `askText`, `askConfirm`, `showInfo` (`src/web/ui/Dialog.tsx`), menus
  próprios (`MenuTree`, `ContextMenu`, `Popover` em `widgets.tsx`). O seletor de arquivos
  do sistema (input file) é aceitável.
- **Responsivo em 1366×768** (tela do notebook do usuário). Conferir com screenshot.
- **Electron é o jeito padrão de usar** (`npm run app`); a versão web (porta 7717) segue
  funcionando.
- **Áudio liga sozinho** (sem clique), tela de carregamento enquanto os samples carregam.
- **Teclado do computador sempre toca o instrumento selecionado**, não importa onde se
  clicou (exceto campos de texto e diálogos).
- **Botão do meio do mouse reseta knobs**; duplo clique também.
- **Playlist começa maximizada e no fundo**; **Tab** alterna as janelas abertas.
- **Alt + arrastar move janelas** (opção em Configurações → Aparência). Por isso, em
  ferramentas, use **Ctrl** (não Alt) como modificador de arraste.
- **Nada destrutivo**: todo áudio editado guarda o original; edições podem ser
  desativadas/reativadas.
- **Sons**: menos é mais (whooshes e entrada de logo sim; "pops" em palavras/cortes não) —
  vale para vídeos/demos.
- O usuário fala por áudio transcrito: textos podem vir com erros de transcrição
  ("hack de canais" = rack de canais, "olugins" = plugins etc.). Interprete pelo contexto.
- Quando ele pede algo grande, ele quer **implementado, testado e commitado**; tirar
  dúvida só se realmente bloquear. Ao terminar, resumir o que mudou e como usar.
- Ele testa na própria máquina (Zorin OS / GNOME / Wayland, notebook Lenovo). Ser
  honesto sobre o que foi testado só em navegador headless vs. de verdade.

---

## 2. Como rodar, construir e testar

Node **22** via nvm (o Node do sistema é 18 e não serve):

```bash
export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test test/*.test.ts (testes de DSP/engine/núcleo)
npm run build            # vite (web) + esbuild (build/server.mjs, build/mcp.mjs)
npm run app              # Electron (servidor embutido)
npm start                # só o servidor: http://127.0.0.1:7717
```

**Servidor principal** (o que o usuário usa no navegador/Electron): porta **7717**.
Depois de mudanças, reconstruir e reiniciar:

```bash
fuser -k 7717/tcp; sleep 1; (nohup $HOME/.nvm/versions/node/v22.23.4/bin/node build/server.mjs > /tmp/musiclabs.log 2>&1 &)
```

A interface se **recarrega sozinha** quando o servidor passa a ter um build novo
(`/api/build` × script da página; nunca no meio de gravação/reprodução), então o usuário
não fica com código velho depois de um reinício do servidor. index.html vai sem cache.

Nunca usar `pkill -f ...` (casa com o próprio comando e mata o shell). Use `fuser -k PORTA/tcp`.

**Servidor isolado para testes** (não mexe nos dados do usuário):

```bash
BATUQUE_PORT=7799 BATUQUE_HOME=/tmp/mlt/home BATUQUE_STATE_DIR=/tmp/mlt/state node build/server.mjs
curl -s -XPOST localhost:7799/api/new -H 'content-type: application/json' -d '{"template":"kit"}'   # ou "empty"
```

**Testes de interface**: scripts Playwright temporários em `scripts/_algo.mts` (dentro
de `scripts/` para os imports resolverem), rodados com `npx tsx` e apagados depois.
Use `playwright-core` com o Chrome do sistema:

```ts
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'] });
```

- Microfone falso: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`
  e `permissions: ['microphone']`; com `--use-file-for-fake-audio-capture=/caminho.wav`
  o "microfone" toca um arquivo (bom para testar detecção de takes e afinação).
- Preferências podem ser injetadas antes de carregar:
  `ctx.addInitScript(() => localStorage.setItem('musiclabs.ui', JSON.stringify({...})))`.
- Esperar `.loading` sumir antes de interagir. O rack abre por cima da playlist: feche
  com `.win-rack .win-close` se atrapalhar.
- Projeto atual via `GET /api/project` (json `{ project }`); ações via `POST /api/actions`
  com `{ actions: [{ name, args }] }` (nomes = funções de `src/core/actions.ts`).
- Screenshot para o usuário: deviceScaleFactor 2; para conferência própria, 1.

**CI e release**: `.github/workflows/ci.yml` (typecheck/test/build) e `release.yml`
(tag `v*` → electron-builder gera AppImage/deb, NSIS, DMG arm64/x64 e publica). Para lançar:
`npm version minor && git push --follow-tags` (confirmar com o usuário antes).

**Git**: commits em português, direto na `main`, e `git push` ao final de cada entrega
(o usuário quer o GitHub sempre atualizado). E-mail de commit é o noreply do GitHub.

---

## 3. Arquitetura

```
src/core/    núcleo em TypeScript puro (roda no AudioWorklet, no Node e nos testes)
src/server/  servidor HTTP + WebSocket (Node): projeto, histórico, arquivos, render, biblioteca
src/web/     interface Preact 11 + Vite; áudio em AudioWorklet
src/mcp/     servidor MCP (stdio) que fala com o servidor HTTP
desktop/     Electron (main.cjs sobe o servidor dentro do processo; janela sem borda)
test/        testes node:test (tsx)
scripts/     ferramentas de diagnóstico e testes de UI (os _*.mts são temporários)
```

### Fluxo de dados
- O **servidor** guarda o projeto, aplica **ops** e mantém o histórico (desfazer/refazer).
  A interface manda ops por WebSocket; o MCP chama `/api/actions`. Toda edição aparece ao
  vivo na interface (com aviso "Claude · …" quando vem do MCP).
- **Ops** (`src/core/ops.ts`): `set(path, value)`, `ins(path, value, index?)`, `rem(path)`.
  Caminhos endereçam itens de listas **pelo id** (ex.: `['clips', clipId, 'pos']`,
  `['audios', id, 'path']`). `insert` cria a lista se não existir (projetos antigos).
- **Ações** (`src/core/actions.ts`): funções `(project, args) → { ops, result }` de alto
  nível (addChannel, addPattern, addNotes, placePattern, addAudioClip, addAutomation,
  addEffect, freeTrack…). Usadas pela UI (`act(A.fn, args)`) e pelo MCP.
- Na UI: `edit(ops)` (vai para o servidor e histórico), `previewEdit(ops)` (local, durante
  arrastos; confirmar com `edit` depois), `act(fn, args)`, `emit()` (redesenha),
  `useApp()` (estado global `state` em `src/web/state.ts`).

### Modelo (`src/core/model.ts`)
- `Project`: bpm, timeSig, swing, channels, patterns, tracks, clips, mixer (0 = master),
  loop (legado), **audios** (lista de áudios do projeto), **stitch** (sessão do Stitcher),
  meta. PPQ = 96; STEP = 24 (semicolcheia).
- `Pattern.notes` é por canal: `{ [channelId]: Note[] }` (Note: key, pos, len, vel…).
- `Clip.kind`: `'pattern'` (padrão), `'audio'` (sample, startSec, gain, insert) ou `'auto'`
  (target `AutoTarget {path,min,max,log,label}` + points `{t,v 0..1}`).
- `AudioItem`: `{ id, name, path (versão atual), original (nunca apagado), variantOf?,
  edited? (versão editada guardada quando as edições estão desativadas) }`.
- `StitchSession`: ids, key, tune, segments (t0, t1, take, target, manual?, piece?).

### Engine (`src/core/engine.ts`)
- Roda no AudioWorklet (`src/web/worklet.ts`) e no Node (render offline). Blocos de 128.
- Modo pattern/song; `collect()` gera eventos de notas; clipes de áudio são mixados no
  insert; automação: valores por bloco (`this.auto`), aplicados com cache de assinatura.
- **Transporte (fora do projeto)**: `setTransport({ region, loopOn, metronome })`;
  `play(mode, pattern, tick, countInBeats)` — contagem toca só o metrônomo; `loops` conta as
  voltas (a gravação usa). Status inclui `countIn` e `loops`.
- `panic()` corta notas e recria os efeitos (mata caudas de reverb/delay): o **stop
  duplo** (parar com tudo parado) chama isso.
- Instrumentos em `instruments.ts`/`prisma.ts`; efeitos em `effects.ts` (registro de
  parâmetros em `registry.ts`: `INSTRUMENTS`, `EFFECTS`, `PRESETS`, `GUITAR_FX`).

### Áudio na interface (`src/web/audio.ts`)
- `AudioContext` principal com o nó `batuque` (engine). Mensagens: project/ops/play/stop/
  seek/transport/liveOn/liveOff/panic/watch.
- `onLive` avisa cada nota ao vivo (gravação de notas escuta isso); `statusAt` permite
  estimar a posição entre status.
- **Gravação na playlist** (`startRecording`/`stopRecording`): grava em "takes"
  (gravação inteligente com `TakeDetector`), mapeia amostras → ticks por pares
  (frames, tick) — funciona com loop. Usada hoje só pelo **amp**.
- **Captura avulsa** (`startCapture`/`stopCapture`/`liveCapture`): sem tocar a música,
  sem ir à playlist — usada pelo Afinador e pelo Stitcher.
- **Amp**: contexto de áudio **separado** (`mon`, latencyHint 0) com o nó `ml-amp` para o
  retorno de baixa latência; a gravação guarda o sinal **cru** e os efeitos são
  reaplicados em alta qualidade (`renderChain`, sobreamostragem 4x em amp/overdrive/fuzz).
- `playBuffer` para prévias das ferramentas.
- **Latência**: o PipeWire do sistema usa blocos de 1024 (≈21 ms). O Electron define
  `PULSE_LATENCY_MSEC=8` (desktop/main.cjs) para o app pedir blocos pequenos; Configurações
  → Áudio tem "Blocos" (força `clock.force-quantum` via `pw-metadata` pelo servidor,
  `/api/latency`; volta a 0 quando o servidor fecha) e **Calibrar atraso da gravação**
  (`audio.calibrateLatency`: cliques + gravador com horário `ml-recorder-t`; resultado em
  `rec.latencyMs`, usado em `recLatencyFrames()` para alinhar os takes). Notas do teclado
  descontam a latência de saída (`midirec.now`).
- **Retorno nativo do amp** (`src/server/monitor.ts`, `/api/monitor`): o servidor roda
  `pw-record` → cadeia de efeitos (mesmo `core/effects`) → `pw-play`, com `node.group`
  comum (mesmo relógio) e um bloco de reserva na saída. O bloco (amostras) é escolhido
  no amp ("Bloco", padrão 128; 64 estala nesta máquina). O retorno do navegador fica mudo
  quando o nativo está ligado (só serve para o visualizador). A entrada do PipeWire é
  achada pelo nome igual ao da entrada escolhida no amp.
- **Regra do loop gravando**: só volta se o loop estiver ligado **e** houver área
  selecionada; em qualquer outro caso a engine fica em `endless` (não volta nem para no
  fim da música) até parar. A posição dos takes é dobrada para dentro da área do loop
  (`tickAt`), mesmo antes de o status da volta chegar.
- **Gravação aditiva no loop**: cada volta fecha um take (`markRec` corta no ponto exato da
  volta) e `placeLiveTake` (state.ts) já coloca o take na playlist como clipe com sample
  `live:…` (áudio enviado direto à engine, efeitos do amp em qualidade de retorno), numa
  track livre a partir da base (nunca em cima de outro clipe) — toca na próxima volta. Ao
  parar, `finishRecording` troca cada prévia pelo arquivo em alta qualidade no mesmo lugar.
  Notas: `midiOnStatus` transforma cada volta em pattern assim que o loop recomeça.
- **Contagem 3-2-1** (opção `countIn`) vale para o REC geral, o amp (engine `countIn` +
  `countInSec` no startRecording) e as ferramentas (`countInIfOn` + `startCapture({arm})`).

### Servidor (`src/server/`)
- `main.ts`: rotas `/api/*` (project, actions, ops, undo/redo, new/save/open, projects,
  roots/browse/library/search, source/zone/sample/peaks, recording, **import**, render,
  transport, preview, registry, status) + WebSocket.
- `store.ts`: pastas — `~/MusicLabs/{Projetos,Renders,Samples,Gravações,Importados}`;
  estado em `~/.local/share/batuque` (Linux). Env: `BATUQUE_PORT`, `BATUQUE_HOME`,
  `BATUQUE_STATE_DIR`, `BATUQUE_FL_DIR`, `BATUQUE_WINE_C`, `BATUQUE_FFMPEG`.
- `library.ts`: na primeira execução varre pastas de samples de DAWs (Linux/Windows/Mac
  e prefixos Wine/Bottles/Lutris). `sampleset.ts`: instrumentos multi-sample (smpl,
  YIN, correção Theil-Sen). `samples.ts`: decodificação (ffmpeg-static; Ogg-in-WAV do FL).
- `render.ts`: render offline com a mesma engine. `flp.ts` (core): import de `.flp`.

### MCP (`src/mcp/main.ts`)
Ferramentas: get_project, get_notes, list_sounds, search_samples, music_theory,
new/set/open/save_project, list_projects, undo, redo, add/update/remove_channel,
add_pattern, edit_pattern, set_steps, add_notes, add_chords, clear_notes,
transform_notes, arrange, add_audio_clip, add_automation, mixer_insert, add/update/
remove_effect, update_track, batch, transport, preview_notes, render, analyze_mix.
Registrado no Claude Code como `musiclabs` (`node build/mcp.mjs`).

---

## 4. Interface (src/web/ui)

Janelas (`Win` em `widgets.tsx`; ids em `WindowId` de `state.ts`): playlist, rack, piano,
mixer, channel, browser (lateral, recolhível), **amp** (F10), **tune** = Afinador (F11),
**stitch** = Stitcher (F12). Atalhos: Espaço tocar/parar (com Afinador/Stitcher em foco,
toca o áudio deles), L pattern/song, F5–F9, Tab, Ctrl+Z/Y/S, Ctrl+, configurações,
Z…M/Q…P teclado musical, -/= oitava.

- **Barra de título** sem nome do app (menus Arquivo, Editar, Adicionar, Patterns, Exibir,
  Aparência, Opções, Ferramentas, Ajuda). O nome "MUSIC LABS" só aparece na tela de
  carregamento (logo animada que enche com o progresso).
- **Aparência / Configurações** (`Settings.tsx`, `theme.ts`): temas Grafite, OLED, Adobe;
  cor de destaque com seletor HSV próprio; Alt+arrastar; entrada de áudio e canais
  (estéreo / só entrada 1 / 2); atalhos. Cores via variáveis CSS; **canvas usam `ui('#hex')`
  e `accent()`** para seguir o tema (repintam com `onTheme`).
- **Playlist** (`Playlist.tsx`): clipes de pattern/áudio (forma de onda)/automação (pontos
  editáveis); **área selecionada** (arrastar na régua ou clicar num clipe; faixa
  destacada; play começa nela); botão direito na área → `SelectionMenu.tsx` (Preencher
  com pattern repetido/cortado, Inserir instrumento — Music Labs, presets, biblioteca/FL,
  ferramentas —, apagar). Arrastar um clipe de áudio para o Stitcher/Afinador envia para lá.
- **Lista ao lado da playlist** (`Picker.tsx`): Patterns + **Áudios** (lista do projeto),
  largura ajustável arrastando a borda.
- **Transporte** (`Toolbar.tsx`): PAT/SONG, play, stop, **REC geral** (grava notas ao vivo
  e automações de knobs — `midirec.ts`; com loop cada volta vira um pattern novo em
  outra track), toggles **loop / metrônomo / contagem (321)**, BPM, posição, master, swing.
- **Knobs** (`Knob` em `widgets.tsx`): `auto={{path,label}}` habilita "Criar clipe de
  automação" (botão direito) e a gravação de automação; durante o REC o knob mexido fica
  vermelho com "● AUTO"; knob com automação na música ganha um ponto.
- **Rack**: menu "+ Canal" usa `Popover` (abre em cima/embaixo do botão, rola se não couber).
- **Amp** (`Amp.tsx`): entrada e canal no título, visualizador (dB, linha do limiar),
  pedais reordenáveis (gate, wah, compressor, overdrive, fuzz, amp clean/crunch/lead,
  gabinete, EQ, tremolo, chorus, phaser, delay, reverb), presets, gravação inteligente
  (`TakeDetector` em `core/onset.ts`: aprende o ruído, exige som sustentado, limiar de
  volume, e usa uma 2ª captura com cancelamento de eco só para detectar).
- **Afinador** (`Tune.tsx`): grava dentro da janela (onda ao vivo), abre arquivos ou áudios
  da lista; notas como blocos (`core/pitchtrack.ts` YIN + segmentação; `core/psola.ts`
  muda altura sem mudar duração); grade do tom (Ctrl: qualquer semitom, Shift: livre);
  tom detectado/escolhível (`core/key.ts`, `KeyPicker.tsx`); **Criar variante** (áudio
  novo) ou aplicar no próprio áudio (original guardado; desativar/reativar edições);
  Enviar para a playlist (variante vai logo abaixo do original).
- **Stitcher** (`Stitch.tsx`, `core/stitch.ts`, `core/align.ts`): vários takes da mesma
  parte → resultado que usa, por nota, o take mais perto da **nota pretendida** (tom +
  consenso). Resultado em cima (cores = origem; clique toca; divisas arrastáveis; botão
  direito: usar outro áudio, dividir, juntar, **abrir o pedaço no Afinador** — volta
  aplicado, sem reafinar), melodia editável, lista de áudios com cores, gravação ao vivo
  na lista, Adicionar (computador / projeto). **Sessão salva no projeto** (`project.stitch`)
  e restaurada ao abrir; desfazer também vale.
- **Lista de áudios** (`src/web/pool.ts`): addToPool, commitEdit (variante ou no próprio),
  toggleEdits, sendToPlaylist, startToolRecording/finishToolRecording (corta silêncio),
  importToPool. `clipaudio.ts`: loadAudio (cache), uploadFiles, makeRoomBelow, placeAudios.

### Convenções de código da interface
- **Preact 11 não põe "px" automático** em estilos numéricos: use strings (`'12px'`).
- `useCanvas(draw, deps, overlay)`: canvas em duas camadas (conteúdo em cache + overlay
  barato para cursores). Medir com clientWidth/Height (bordas fazem crescer).
- Dicas na barra: atributo `data-hint`.
- Preferências locais: `getPref/setPref/usePref` (`src/web/prefs.ts`, localStorage
  `musiclabs.ui`), não ficam no projeto (tema, amp, opções de transporte, larguras).
- Textos em português com acentuação correta.
- **Selects** usam o select personalizável do Chromium (`appearance: base-select`,
  `::picker(select)` no fim do style.css): a lista segue o tema e o item sob o mouse fica na
  cor de destaque. Não reverter para a lista nativa (ficava branca e ilegível).

---

## 5. Ambiente da máquina do usuário

- Zorin OS (GNOME, Wayland), PipeWire, notebook Lenovo com Realtek **ALC236**
  (subsystem 17aa:382c). Gerenciador de janelas arrasta janelas com **Super** (Alt fica
  livre para o app).
- FL Studio 2025 instalado no Wine (`~/.wine/drive_c/Program Files/Image-Line/…`); o
  VST2 `FL Studio VSTi (Multi).dll` existe em `Common Files/VST2`.
- Sem `sudo` para o Claude (pedir ao usuário quando precisar).
- **Pendência de hardware**: o microfone do headset (Fallen Quartz, plugue P2 de 4 polos,
  cabo HyperX) **não é detectado** pelo driver (`Mic Jack: off`; teste de batidinha
  confirmou que só o microfone interno chega). Sugestões dadas ao usuário: testar
  `options snd-hda-intel model=aspire-headset-mic` em `/etc/modprobe.d/headset-mic.conf`
  + reboot (desfazer apagando o arquivo), ou usar uma placa de som USB. O volume de
  captura do sistema foi subido para 70% durante os testes.

---

## 6. Pendências e ideias (ver também ROADMAP.md)

- Ponte de plugins VST/LV2/CLAP via Carla + yabridge (em espera).
- Plugins nativos + marketplace via repositórios GitHub, com API limpa; converter os
  instrumentos/efeitos atuais em plugins (ideia anotada no ROADMAP).
- Gravador simples de áudio (grava qualquer entrada) — pedido para "depois".
- Stitcher: adicionar/tirar um áudio refaz a costura e perde as edições manuais
  (desfazer recupera); possível melhoria: preservar escolhas nos trechos inalterados.
- Editor de zonas para samplers multi-sample (ROADMAP).
- Release: está em v0.1.0; muita coisa nova desde então (perguntar antes de lançar).
