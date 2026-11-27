# Music Labs — guia para o Claude

DAW open source (GPL-3.0) com fluxo de trabalho familiar a quem usa FL Studio (rack de
canais, piano roll, playlist, mixer), visual próprio e um servidor **MCP** para o Claude
produzir junto. Código em `~/music-labs`. Repositório público: `github.com/Felpes-Freitas/music-labs`.

Sempre responder ao usuário em **português do Brasil**. Comentários de código, textos da
interface, mensagens de commit e documentação também em português.

---

## 1. Regras e preferências do usuário (importantes)

- **Nada de copiar o FL Studio**: experiência parecida, visual e nomes próprios. O nome
  não pode conter "FL". Engenharia reversa só para interoperabilidade (importar `.flp`,
  ler samples da instalação do usuário no Wine). Nomes de marcas de terceiros também não:
  o editor tipo "Melodyne" se chama **Melodify** (antes "Afinador"; a janela continua com o id `tune`); o comping é o **Stitcher** (nome dado
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
MUSICLABS_PORT=7799 MUSICLABS_HOME=/tmp/mlt/home MUSICLABS_STATE_DIR=/tmp/mlt/state node build/server.mjs
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

### Áudios como canais (`src/core/audiochan.ts`)

- Canal `type: 'audio'` (`params.sample`; `AudioChannelInstrument` não toca notas). Os
  clipes de áudio têm `channel` e tocam por ele na engine (`audioClipsIn` + `mixClip`, antes
  dos efeitos/volume/pan/insert do canal). Clipe sem canal (só antes da migração) vai
  direto para `clip.insert`.
- `completeOps(p)` devolve o que falta depois de qualquer edição: canal de áudio para item
  da lista (`AudioItem.channel`) ou clipe sem canal (mesmo arquivo = mesmo canal; insert
  livre com o nome do áudio; `clip.insert` antigo vira o insert do canal), o pattern-grupo
  (`Pattern.channels = [canal]`) e as tracks até a maior usada. Roda em `edit()` (web),
  `Store.apply` (manda o que completou a todos com origin "server") e `Store.load`.
- `removeChannel` de um canal de áudio leva junto os clipes e o item da lista.
- Rack: filtro "só este pattern" (`channelInPattern` = tem notas ou está em
  `pattern.channels`; canais sem pattern nenhum aparecem sempre); `moveChannelToPattern`
  (studio.ts; MCP `send_to_pattern`).
- Tracks infinitas: projeto novo sem tracks; a playlist desenha linhas virtuais
  (`trackInfo`/`trackOps` em Playlist.tsx criam até a track usada); `updateTrack` cria.
- `ChannelMix.tsx` (volume, pan, mute, insert, efeitos) aparece no canal de áudio
  (`AudioChannelWin` em ChannelSettings.tsx), na engrenagem do Melodify e do Stitcher.

### Reamp e memória (`src/core/reamp.ts`, `src/web/reamp.ts`)

- Gravação do amp salva o **bruto** (`AudioItem.raw`) e a versão processada (`path`); todos
  os takes de uma gravação vão para **um** canal de áudio (`newAudioChannel` em
  finishRecording) com `amp = { chain, outGainDb, sig }`. Prévias "live:" não ganham canal
  (`completeOps` as ignora; tocam direto no insert até virar arquivo). Canais de prévia
  órfãos de versões antigas são removidos por `completeOps` (use `completeAll`, que repete).
- `ampLive(p, ch)`: toca o bruto pelos pedais em tempo real (engine: `st.amp`, automação
  em `['channels', id, 'amp', 'chain', fxId, 'params', key]` = `ampParamPath`) quando
  `amp.sig !== ampSig(amp)` (cadeia mudou, versão processada velha) ou há automação num
  pedal; senão a versão processada (custo zero). Sem o bruto carregado, a processada.
- `web/reamp.ts`: observa o projeto e refaz em segundo plano (renderChain HQ, sobe o WAV,
  troca `path` do item, `sample` dos clipes e grava `sig`). `openAmpReamp(ch)` abre o amp
  no `ReampView` (Amp.tsx; `Chain` recebe a cadeia e `update`); duplo clique numa gravação
  do amp abre ali.
- Memória: `audio.ts` descarrega da engine (`unsample` → `Engine.dropSamples`) o que o
  projeto não usa mais, 4 s depois da última mudança (não durante gravação); o cache de
  áudio decodificado das ferramentas (`clipaudio.loadAudio`) guarda só os 8 últimos.

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
- `AudioContext` principal com o nó `musiclabs` (engine). Mensagens: project/ops/play/stop/
  seek/transport/liveOn/liveOff/panic/watch.
- `onLive` avisa cada nota ao vivo (gravação de notas escuta isso); `statusAt` permite
  estimar a posição entre status.
- **Gravação na playlist** (`startRecording`/`stopRecording`): grava em "takes"
  (gravação inteligente com `TakeDetector`), mapeia amostras → ticks por pares
  (frames, tick) — funciona com loop. Usada hoje só pelo **amp**.
- **Captura avulsa** (`startCapture`/`stopCapture`/`liveCapture`): sem tocar a música,
  sem ir à playlist — usada pelo Melodify e pelo Stitcher.
- **Amp**: contexto de áudio **separado** (`mon`, latencyHint 0) com o nó `ml-amp` para o
  retorno de baixa latência; a gravação guarda o sinal **cru** e os efeitos são
  reaplicados em alta qualidade (`renderChain`, sobreamostragem 4x em amp/overdrive/fuzz).
- `playBuffer` para prévias das ferramentas.
- **Latência**: o PipeWire do sistema usa blocos de 1024 (≈21 ms). A saída principal pede
  `audioBuffer()` amostras (`latencyHint`; Configurações → Saída → "Bloco do app", padrão
  512; vale ao reabrir). **Não** usar `PULSE_LATENCY_MSEC`: ele forçava 128 em todos os
  streams do app e a placa inteira picotava em projetos maiores. O amp fecha o contexto
  `mon` ao fechar (não só pausa). Configurações
  → Áudio tem "Blocos" (força `clock.force-quantum` via `pw-metadata` pelo servidor,
  `/api/latency`; volta a 0 quando o servidor fecha) e **Calibrar atraso da gravação**
  (`audio.calibrateLatency`: cliques + gravador com horário `ml-recorder-t`; resultado em
  `rec.latencyMs`, usado em `recLatencyFrames()` para alinhar os takes). Notas do teclado
  descontam a latência de saída (`midirec.now`).
- **Afinador de guitarra** (botão "Afinar" no amp, `GuitarTuner` em Amp.tsx): lê a entrada
  crua (`audio.ampTap()`), mostra nota/cents/corda; enquanto aberto, o retorno toca sem
  efeitos (`liveChain()` vazia).
- **Retorno nativo do amp** (`src/server/monitor.ts`, `/api/monitor`): o servidor roda
  `pw-record` → cadeia de efeitos (mesmo `core/effects`) → `pw-play`, com `node.group`
  comum (mesmo relógio) e um bloco de reserva na saída. O bloco (amostras) é escolhido
  no amp ("Bloco": 128/256/512/1024, potências de 2 — o PipeWire arredonda para baixo; menos de 128 engasga a placa inteira). O retorno do navegador fica mudo
  quando o nativo está ligado (só serve para o visualizador). A entrada do PipeWire é
  achada pelo nome igual ao da entrada escolhida no amp.
- **Regra do loop gravando**: só volta se o loop estiver ligado **e** houver área
  selecionada; em qualquer outro caso a engine fica em `endless` (não volta nem para no
  fim da música) até parar. A posição dos takes é dobrada para dentro da área do loop
  (`tickAt`), mesmo antes de o status da volta chegar. Take cujo ataque (`onset`) veio
  depois da volta começa no início do loop (`lastWrap`), sem deixar "toco" de pré-ataque
  no fim da área nem ser posicionado na volta anterior.
- **Número do play** (`playId`): `audio.play` manda um id; a engine devolve no status. A
  gravação (`markRec`) e o REC de notas (`midirec.ts`) ignoram status de outro play —
  gravar com a música já tocando em loop trazia `loops` alto e posições antigas e
  quebrava a detecção das voltas (takes escorriam para fora do loop). Na hora do play o
  relógio da gravação é ancorado (`r.base`, `map[0]`), porque a captura abre antes (a
  detecção leva um getUserMedia). A captura de detecção (eco cancelado) é convertida para
  o relógio da principal (`detBase`). Teste e2e: microfone falso com frases, tocar em
  loop, abrir o amp no meio e gravar — todos os takes começam no início da área.
- **Gravação aditiva no loop**: cada volta fecha um take (`markRec` corta no ponto exato da
  volta) e `placeLiveTake` (state.ts) já coloca o take na playlist como clipe com sample
  `live:…` (áudio enviado direto à engine, efeitos do amp em qualidade de retorno), numa
  track livre a partir da base (nunca em cima de outro clipe) — toca na próxima volta. Ao
  parar, `finishRecording` troca cada prévia pelo arquivo em alta qualidade no mesmo lugar;
  take cuja prévia foi apagada durante a gravação é descartado (não volta). Em loop, a
  cauda dos efeitos é cortada no fim da área (`recLoop`).
- **Rede de segurança do loop** (`core/loopfold.ts`, `foldTake`): na prévia e na versão
  final, take que passa do fim da área é cortado ali e o excesso continua no início dela
  (vários pedaços se for maior que o loop; take que começou fora é trazido para dentro).
  Os pedaços são clipes do mesmo arquivo com `startSec` diferentes, cada um numa track
  livre. Toco < 150 ms no começo (pré-ataque) e sobra < 60 ms no fim (variação de tempo)
  são descartados. `liveTakes` guarda os ids dos pedaços de cada take.
  Notas (`midirec.ts`): entram no **pattern selecionado** ao apertar REC (`intoPattern`),
  no clipe dele que está no começo do trecho (respeita offset e repetições) ou num clipe
  novo dele ali; o pattern cresce se a gravação passar do fim. Sem pattern, cria um e as
  próximas passadas vão para ele. Em loop, cada volta se soma ao mesmo pattern quando o
  loop recomeça (`midiOnStatus`). `now()` estima a posição pelo relógio enquanto a engine
  não responde ao play novo (`audio.playAt/playFrom/playCountIn`) e, na contagem, nota até
  meio tempo antes do "1" vale como o "1" (`countInTicks` no status).
- **Contagem de 4 tempos** (opção `countIn`, ícone "321") vale para o REC geral, o amp (engine `countIn` +
  `countInSec` no startRecording) e as ferramentas (`countInIfOn` + `startCapture({arm})`).

### Servidor (`src/server/`)
- `main.ts`: rotas `/api/*` (project, actions, ops, undo/redo, new/save/open, projects,
  roots/browse/library/search, source/zone/sample/peaks, recording, **import**, render,
  transport, preview, registry, status) + WebSocket.
- `store.ts`: pastas — `~/MusicLabs/{Projetos,Renders,Samples,Gravações,Importados}`;
  estado em `~/.local/share/musiclabs` (Linux). Projetos são `.mlstudio` (`PROJECT_EXT`/
  `PROJECT_FORMAT` em model.ts; `isProjectData` aceita arquivos de versões antigas pela estrutura). Env: `MUSICLABS_PORT`, `MUSICLABS_HOME`,
  `MUSICLABS_STATE_DIR`, `MUSICLABS_FL_DIR`, `MUSICLABS_WINE_C`, `MUSICLABS_FFMPEG`.
- `library.ts`: na primeira execução varre pastas de samples de DAWs (Linux/Windows/Mac
  e prefixos Wine/Bottles/Lutris). `sampleset.ts`: instrumentos multi-sample (smpl,
  YIN, correção Theil-Sen). `samples.ts`: decodificação (ffmpeg-static; Ogg-in-WAV do FL).
- `render.ts`: render offline com a mesma engine. `flp.ts` (core): import de `.flp`.

### MCP (`src/mcp/main.ts`)
Registrado no Claude Code como `musiclabs` (`node build/mcp.mjs`). **Regra: tudo o que o
usuário faz na interface tem que ser possível pelo MCP, sem escrever código** — se faltar,
acrescentar a ação em `core/` e a ferramenta aqui (não contornar com curl/scripts).
- Leitura: get_project (inclui tracks, áudios e `ui` = o que o usuário vê: área, loop,
  metrônomo, contagem, janelas, pattern/canal selecionados, automação aberta, BPM do
  momento), get_channel (todos os parâmetros e efeitos), get_mixer, get_clips (playlist
  detalhada; automação com a função em unidades do parâmetro), get_notes, list_audios,
  list_sounds (kind "automation" = funções da Central), search_samples, music_theory.
- Projeto: new/set/open/save_project, list_projects, undo, redo.
- Canais: add/update/remove_channel, **duplicate_channel** (parâmetros + efeitos + notas,
  insert same/auto/master/n).
- Notas: add_pattern, edit_pattern (nome, tamanho, cor, duplicar, remover), set_steps,
  add_notes, add_chords, clear_notes, **copy_notes** (entre patterns/canais; cria o
  destino), transform_notes (+ filtros de trecho/faixa, setVelocity/setLength, shiftBeats,
  reverse, legato, strum, chop, addOctave).
- Playlist: arrange, **edit_clips** (mover, tamanho, cortar começo, mudo, ganho/insert de
  áudio, duplicar, apagar — por ids ou filtro), **copy_section**, **insert_bars**,
  **delete_bars**, add_audio_clip, update_track (nome, mudo, cor).
- Automação: add_automation (ação `automate`: `fn` com as funções da Central em unidades
  do parâmetro, `points`, ou param "bpm"), **edit_automation**.
- Mixer: mixer_insert, **reset_insert** (o mixer tem posições fixas: "remover" = resetar),
  add/update/remove_effect (insert ou canal), **copy_effects**.
- Áudios do projeto: **audio_pool** (add, rename, remove, place, edits on/off).
- Patterns: **send_to_pattern** (move as notas do canal; sem `to`, pattern novo).
- Andamento: **detect_bpm** (clipe, item da lista ou arquivo; `apply` muda o BPM e alinha
  o clipe à grade) e **set_tempo** (muda o BPM mantendo a duração dos áudios; = `applyTempo`).
- Interface: **ui** (`POST /api/ui` → `remoteUi` em state.ts: select, loop, metronome,
  countIn, follow, mode, seekBar, pattern, channel, open/close janelas, automation,
  message), transport, preview_notes. render, analyze_mix.
- Ações novas ficam em `src/core/studio.ts` e estão no `ACTIONS` do servidor (valem no
  `batch`). Testes: `test/studio.test.ts` (inclui o pedido "intro 2x + verso" só com ações).
- Depois de mudar o MCP: `npm run build` e reconectar o MCP (`/mcp` no Claude Code) e
  reiniciar o servidor/app (as ações rodam no servidor).

---

## 4. Interface (src/web/ui)

Janelas (`Win` em `widgets.tsx`; ids em `WindowId` de `state.ts`): playlist, rack, piano,
mixer, channel, browser (lateral, recolhível), **amp** (F10), **tune** = Melodify (F11),
**stitch** = Stitcher (F12). Atalhos: Espaço tocar/parar (com Melodify/Stitcher em foco,
toca o áudio deles), L pattern/song, F5–F9, Tab, Ctrl+Z/Y/S, Ctrl+, configurações,
Z…/ e Q…] teclado musical (`pianokeys.ts`, inclui , . ; / e [ = ]; o L segue sendo PAT/SONG), PageDown/PageUp oitava. As notas usam a **posição física** (`KeyboardEvent.code` → nome da tecla no teclado americano, `musicKey`), escolhida em Configurações → Teclado e atalhos: US, ABNT2 (+ `IntlBackslash`/`IntlRo`) ou pelos caracteres (`e.key`, o antigo).

- **Barra de título** sem nome do app (menus Arquivo, Editar, Adicionar, Patterns, Exibir,
  Aparência, Opções, Ferramentas, Ajuda). O nome "MUSIC LABS" só aparece na tela de
  carregamento (logo animada que enche com o progresso).
- **Aparência / Configurações** (`Settings.tsx`, `theme.ts`): temas Grafite, OLED, Adobe;
  cor de destaque com seletor HSV próprio; Alt+arrastar; entrada de áudio e canais
  (estéreo / só entrada 1 / 2); atalhos. Cores via variáveis CSS; **canvas usam `ui('#hex')`
  e `accent()`** para seguir o tema (repintam com `onTheme`).
- **Playlist** (`Playlist.tsx`): clipes de pattern/áudio (forma de onda)/automação (pontos
  editáveis). **Área selecionada** (faixa destacada; play e loop usam ela): arrastar na
  régua ou **Alt+clique num clipe** (só isso; pintar ou clicar não seleciona área; com o
  "Alt+arrastar janelas" ligado, a playlist fica de fora). **Clipes selecionados**
  (`picked`, contorno claro): clique seleciona um, Ctrl alterna, Shift soma, Ctrl+A tudo;
  arrastar um move o grupo; puxar a borda de um redimensiona o grupo (`trimStart` na
  esquerda; automação não tem começo móvel); Ctrl+C/Ctrl+X/Ctrl+V (cola onde o mouse está,
  ou logo depois do original), Ctrl+B duplica à frente; Ctrl+Shift+arrastar duplica;
  Delete apaga; Esc limpa (atalhos
  valem se o último clique foi na playlist — `playlistFocused()`; ela fica no fundo, nunca é
  a janela da frente, e o piano roll ignora o teclado nesse caso).
  **Duplo clique** (evento `dblclick` do canvas; o `detail` do pointerdown não traz a
  contagem no Chrome): pattern → seleciona e abre o rack; automação → Central; áudio →
  o canal do áudio (AudioChannelWin: onda, Melodify, Stitcher, volume/pan/efeitos/insert); nome da track → renomear.
  Bordas: direita e **esquerda** redimensionam (esquerda anda o começo e mantém o conteúdo:
  `startSec` no áudio, `offset` no pattern). **Snap** (`core/snap.ts`, ímã "auto/tempo/
  compasso", pref `pl.snap`): auto segue o zoom como no FL (compasso … 1/16 de tempo,
  células ≥ 10 px) e a grade desenhada acompanha. **Pincel** (`state.brush`, como no FL):
  clicar num clipe de pattern escolhe o pattern; clicar num clipe de áudio (ou num áudio
  da lista) faz dele o pincel (mesmo trecho do arquivo). **Clique esquerdo no vazio
  pinta**: arrastando, cada espaço livre por onde o mouse passa ganha uma cópia encostada
  (para os dois lados, pulando o que já existe); vira um passo só de desfazer. Botão direito **num clipe** sempre apaga (mesmo dentro da
  área); **num lugar vazio da área** abre `SelectionMenu.tsx` (Preencher com pattern
  repetido/cortado, Inserir instrumento — Music Labs, presets, biblioteca/FL, ferramentas —,
  apagar), agindo na track clicada. Amp/Melodify/Stitcher abertos por ali guardam
  `state.selTrack`: a gravação do amp e o "Enviar para a playlist" caem nessa track (ou na
  livre logo abaixo) no começo da área; `selTrack` some quando a área muda. Com área
  selecionada, arrastar apagando (botão direito ou borracha) só apaga dentro dela. Arrastar um clipe de áudio para o Stitcher/Melodify envia para lá.
- **Lista ao lado da playlist** (`Picker.tsx`): Patterns + **Áudios** (lista do projeto; gravações do amp/microfone entram como "Guitarra N"/"Gravação N" via `addRecordingToPool`),
  largura ajustável arrastando a borda.
- **Transporte** (`Toolbar.tsx`): PAT/SONG, play, stop, **REC geral** (grava notas ao vivo
  e automações de knobs — `midirec.ts`; com loop cada volta vira um pattern novo em
  outra track), toggles **loop / metrônomo / contagem (321)**, BPM, posição, master, swing.
- **Central de Automações** (`AutoCenter.tsx`, `web/autos.ts`, `core/autogen.ts`): botão
  direito num knob com `auto` ou no BPM → "Criar automação…" (`createAutomation`: clipe na
  área selecionada ou 4 compassos na agulha, track livre) e abre a Central nele; duplo
  clique num clipe de automação abre o existente (`state.autoClip`).
  O clipe guarda `gen` (função) e `points` (o que a engine toca). Funções: rampa (riser,
  exponencial, fade in/out, curva S), LFO (seno/triângulo/quadrada/serra; período no
  início e no fim = acelera; "respiração" contrai/expande a frequência; intensidade início/
  fim; fase), bombeamento, escada, aleatório. Períodos em tempos. **Grade** (`gen.grid`,
  controle deslizante: livre, 4 tempos … 1/16, com tercinas; linhas no gráfico): os knobs
  de período têm snap magnético (`snapToGrid`: trava a ±7% de um valor da grade —
  múltiplos dela ou divisões exatas de uma célula, `gridPeriod` —, livre no resto).
  **Ciclos na grade** (`gen.quantize`, LFO): cada ciclo tem um período da grade e começa
  numa linha dela (acelerar/respirar em passos rítmicos). `renderGen` amostra e `simplify` tira pontos
  redundantes (reta = 2 pontos; seno mantém o período e ganha ciclos ao crescer). LFO
  não amostra+simplifica: anda ciclo a ciclo e põe só os pontos necessários (seno 24 por
  ciclo, triângulo nos vértices, quadrada/serra nos saltos — `emit`); simplificar sempre
  com o tempo exato e só depois arredondar ticks (`toTicks`), senão o serrilhado do
  arredondamento impede a simplificação. `regen`
  ao redimensionar; `trimAutoStart` corta/estende o começo. Editar ponto (na Central ou
  na playlist) marca `gen.custom` (valem os pontos; "Voltar à função" desfaz); fatiar
  também. **BPM automatizável**: alvo `['bpm']` (40–240); `Engine.bpmAt` usa o clipe ativo
  em song mode, status traz `bpm` (o LCD mostra em roxo). Áudios seguem os ticks e
  aceleram junto (como fita), com a conversão de tempo no BPM do projeto.
- **Mudanças para a engine** (`audio.applyOps`): a primeira vai na hora e as seguintes
  são juntadas por ~20 ms (lote de `set` igual ao anterior: só o último vale); `post`
  esvazia o que está pendente antes de qualquer outra mensagem. No worklet,
  `applyOps(..., owned=true)` não clona de novo (já veio por postMessage) — clonar listas
  grandes de pontos na thread de áudio travava o som (84 ms → 0,3 ms por edição).
- **Knobs** (`Knob` em `widgets.tsx`): `auto={{path,label}}` habilita "Criar automação…"
  (botão direito, abre a Central) e a gravação de automação; durante o REC o knob mexido fica
  vermelho com "● AUTO"; knob com automação na música ganha um ponto.
- **Botão direito num canal do rack** (`channelMenu` em ChannelRack.tsx, `MenuTree`):
  **Preencher** ▸ cada 1/2/3/4/8/16 steps, contratempo, tempos 2 e 4, limpar (`fillSteps`,
  usa a nota que o canal já toca); **Substituir instrumento** ▸ mesmo menu do "+ Canal"
  (`replaceInstrument`: troca tipo/preset/params mantendo id, notas, efeitos, insert,
  volume, pan e automações; sample de um tiro → raiz = nota mais tocada do canal);
  **Clonar** = `duplicateChannel` com efeitos e notas. MCP: replace_instrument, fill_steps.
- **Soundpad** (tipo `pads`; `core/pads.ts`, `PadsInstrument` em instruments.ts,
  `PadsPanel.tsx`): 16 pads 4×4, cada um um mini-instrumento (sampler com arquivo/pasta,
  ou nativo/preset) em `params.pads` (texto JSON, `parsePads`/`stringifyPads`). Pad i toca
  na nota C2+i (pad 1 = embaixo à esquerda); o som do pad toca em `note` (padrão C4 =
  altura original) + `tune`, com `gain` em dB. Cores por linha (vermelho, laranja, verde,
  azul — `PAD_ROW_COLORS`). Com o canal selecionado, o teclado vira a grade:
  1234/QWER/ASDF/ZXCV (`PAD_BY_KEY` em main.tsx). Na janela do canal (sem o piano):
  clique toca, botão direito troca o som (instrumentMenu sem o próprio Soundpad), renomeia
  ou limpa, arrastar áudio do navegador para o pad, ganho/afinação do pad selecionado,
  Kits (básico e break sintetizados — funcionam sem samples —, bateria do FL, limpar).
  Pads acendem ao tocar (teclado, clique e música via `audio.watch` + `status.lit`).
  Samples dos pads carregam por `channelSamples` (interface e render). Step/preencher sem
  notas usa C2. MCP: `set_pad` (pad, localSample/sample/type/preset, name, gain, tune,
  clear, kit).
- **Teclado RGB / OpenRGB** (`src/server/rgb.ts`, `src/web/rgb.ts`, Configurações →
  Iluminação RGB): cliente próprio do protocolo SDK do OpenRGB (v3; porta 6742; sem
  dependências). Só dispositivos tipo teclado (5); LED por nome ("Key: Q" → `ledKey` "q").
  Ao conectar guarda modo ativo (bytes da descrição) e cores de cada teclado e entra no
  modo custom; a interface manda a cena (`{type:'rgb', config|scene}` pelo WebSocket:
  piano = brancas `#d8dde4`, pretas na cor de destaque; Soundpad = cores dos pads; fundo
  `#080808`; teclas apertadas clareiam). **Restaurar sempre** (`rgbRelease`: cores
  originais e depois UPDATEMODE com o modo original): ao desligar, quando a última janela
  desconecta, em SIGINT/SIGTERM e no Electron (`before-quit` espera `shutdown()`; o
  relançamento por servidor desatualizado também). Testes: `test/rgb.test.ts` (servidor
  OpenRGB falso no formato da documentação). **OpenRGB de fábrica** (`src/server/openrgb.ts`):
  na 1ª abertura, se há periférico de marca RGB no USB (`rgbHardwareHint`, vendor ids; fora
  do Linux pergunta sempre) e nenhum OpenRGB rodando, a interface pergunta uma vez (pref
  `rgb.offered`) e baixa a versão oficial **1.1** (Linux x64 AppImage → extraído em
  `STATE_DIR/openrgb/squashfs-root/AppRun`; Windows x64 zip) **com SHA-256 fixo no código**
  (arquivo diferente = recusado); grava `openrgb/version` e atualiza sozinho uma instalação
  antiga (`openRgbOutdated`). A 0.9 **não funcionava** no Apex Pro TKL do usuário: aceitava as
  cores mas o teclado não mudava (a 0.9 só tem o protocolo antigo 0x3A; firmware ≥ 1.19.7
  usa init 0x4B + pacotes 0x40, suportado a partir da 1.1, que também tem o modo "Onboard").
  Ao entrar: SetCustomMode + UpdateMode do modo Direct. **Teclado RGB vem desligado por
  padrão** e o **servidor decide** (`STATE_DIR/rgb.json`): só muda com escolha explícita
  (`{type:'rgb', explicit:true}` — botão nas Configurações ou aceitar a oferta); a interface
  que só reconecta manda a config sem `explicit` e não liga nada. **Situação no Apex Pro TKL do
  usuário (firmware KBD 4.15.7, OpenRGB 1.1): não funciona** — as cores só "piscam" ao trocar
  de instrumento e o teclado volta ao perfil próprio. Tentativa de passar por Onboard → Direct
  + reenviar o quadro a cada 0,5 s fez o teclado **piscar sem parar e parar de digitar**
  (mesma interface USB das teclas): foi desfeita e NÃO deve ser repetida. Próximo passo, se
  o usuário quiser: testar no próprio OpenRGB (janela) se ele consegue cor fixa nesse
  teclado; se não conseguir, é limitação do OpenRGB com esse firmware. Ao soltar: se o teclado estava no Direct e tem modo de hardware
  (`hardwareMode`: Onboard…), volta para ele (iluminação do próprio teclado); senão cores e
  modo originais. Se o servidor SDK não responde e há o OpenRGB do app, o
  cliente o inicia (`--server --server-port`, só em localhost) e tenta de novo a cada 1,5–2,5 s
  enquanto ele detecta; `rgbShutdown` restaura o teclado e encerra esse processo (o do
  usuário, se houver, nunca é iniciado/encerrado). Linux sem acesso ao USB: botão instala
  as regras udev oficiais (SHA-256 conferido) via `pkexec`. `MUSICLABS_OPENRGB_URL` troca a
  origem (só testes; `test/openrgb.test.ts`). Nunca rodei o OpenRGB real nesta máquina (o
  sistema de permissões bloqueia baixar/executar o binário aqui); o teclado do usuário é um
  Apex Pro TKL e `/dev/hidraw*` já é acessível sem sudo.
- **Menus encadeados** (`MenuTree`): submenu que não cabe à direita abre à esquerda do
  pai (`altX`), sem cobrir os níveis anteriores.
- **Janelas** (`Win`): redimensionam pelas 4 bordas e 4 cantos (`.win-edge`, dir n/s/e/w…);
  borda esquerda/de cima não passam da área de trabalho; a playlist continua no fundo
  depois de redimensionada.
- **Adicionar instrumento** (`web/addmenu.ts`, `instrumentMenu`): menu encadeado (`MenuTree`)
  usado no "+ Canal" do rack e no "Inserir instrumento" da área da playlist — Music Labs
  (nativos), Presets (por instrumento de base) e um item por programa da biblioteca (FL
  Studio, Ableton...) com famílias (pasta do instrumento: Keyboard, Bass...; nomes genéricos
  como "Instruments" usam a pasta de cima, `familyOf` em sampleset.ts). Cada programa
  mostra **direto** (sem nível intermediário — pedido do usuário): as famílias e depois
  **Bateria / Efeitos / Vocais / Outros** (`sampleCategories`: a primeira pasta, de cima
  para baixo, cujo nome é de bateria/efeito/vocal leva a subárvore inteira, rótulo "A › B").
  Árvore em `/api/sampletree` (`sampleTree()` em library.ts: sem loops, sem músicas demo,
  sem os arquivos dos instrumentos multi-sample). Listas longas rolam (menutree max 80vh;
  itens com `flex-shrink: 0`, senão encolhem). **Prévia só pelo botão direito**
  (`MenuItem.preview`; o usuário não quis botão ▶): segurando o direito e passando pelos
  itens, cada um toca (`rightHeld`); instrumento toca a amostra mais perto do Dó central
  (`/api/source` + `/api/zone`, `audio.previewUrl`). O item aberto fica na cor de destaque.
- **Servidor desatualizado**: `/api/build` traz `serverStale` (o arquivo do servidor mudou
  depois que ele subiu). A interface recarrega sozinha com o build novo, mas o servidor
  embutido no Electron não: então, parado e sem gravar, a interface pede ao app para
  reiniciar (`mlabsWindow.relaunch` → `app:relaunch` em main.cjs, que grava o autosave
  antes com `flushState`). Se o servidor não é do app (aberto pelo MCP), só avisa.
- **Amp** (`Amp.tsx`): entrada e canal no título, visualizador (dB, linha do limiar),
  pedais reordenáveis (capotraste, gate, wah, compressor, overdrive, fuzz, amp clean/crunch/lead,
  gabinete, EQ, tremolo, chorus, phaser, delay, reverb), presets, gravação inteligente
  (`TakeDetector` em `core/onset.ts`: aprende o ruído, exige som sustentado, limiar de
  volume, e usa uma 2ª captura com cancelamento de eco só para detectar).
- **Melodify** (`Tune.tsx`): grava dentro da janela (onda ao vivo), abre arquivos ou áudios
  da lista; notas como blocos (`core/pitchtrack.ts` YIN + segmentação; `core/psola.ts`
  muda altura sem mudar duração); grade do tom (Ctrl: qualquer semitom, Shift: livre);
  tom detectado/escolhível (`core/key.ts`, `KeyPicker.tsx`); **Criar variante** (áudio
  novo) ou aplicar no próprio áudio (original guardado; desativar/reativar edições);
  Enviar para a playlist (variante vai logo abaixo do original). Botão **BPM**: detecta o
  andamento (`core/tempo.ts` `detectBpm`: fluxo espectral → autocorrelação com harmônicos
  e preferência por ~120 → trem de pulsos fino em 0,01 BPM e fase) e oferece usar no
  projeto (`applyTempo` em studio.ts: áudios mantêm a duração em segundos; o clipe que
  abriu a janela vai para a grade com o primeiro tempo no começo do compasso).
- **Capotraste** (efeito `capo`, `core/effects.ts`): muda o tom por janelas sobrepostas
  (dois cabeçotes numa linha de atraso, Hann); semitons, oitava (botões −2…+2 no pedal do
  amp, `CapoOctave`), fino e janela; latência ≈ meia janela. Entra no começo da cadeia.
- **Tap tempo** (`TapButton` em Toolbar.tsx, `tapBpm` em core/tempo.ts): reta pelos
  últimos 12 cliques; pausa de 2 s recomeça; vira um passo de desfazer ao terminar.
- **Stitcher** (`Stitch.tsx`, `core/stitch.ts`, `core/align.ts`): vários takes da mesma
  parte → resultado que usa, por nota, o take mais perto da **nota pretendida** (tom +
  consenso). Resultado em cima (cores = origem; clique toca; divisas arrastáveis; botão
  direito: usar outro áudio, dividir, juntar, **abrir o pedaço no Melodify** — volta
  aplicado, sem reafinar), melodia editável, lista de áudios com cores, gravação ao vivo
  na lista, Adicionar (computador / projeto). **Sessão salva no projeto** (`project.stitch`)
  e restaurada ao abrir; desfazer também vale.
- **Lista de áudios** (`src/web/pool.ts`): addToPool, commitEdit (variante ou no próprio),
  toggleEdits, sendToPlaylist, startToolRecording/finishToolRecording (corta silêncio),
  importToPool. `clipaudio.ts`: loadAudio (cache), uploadFiles, makeRoomBelow, placeAudios.

### Piano roll

- Clique numa nota (ou criar uma) soa **enquanto o botão está apertado** (`hold`/`holdOff`:
  `liveOn` sem gate, `liveOff` ao soltar; o envelope do instrumento decide se acaba antes).
- A engine informa as teclas que soam do canal observado (`audio.watch`, que o piano roll e
  a janela do canal compartilham); a linha e a tecla delas acendem (`litKeys`).
- Botão direito em lugar vazio e Ctrl+D desmarcam as notas; duplicar é Ctrl+B.
- Snap: `Auto (pelo zoom)` = `autoSnapRoll` (core/snap.ts; livre no zoom máximo). Mover uma
  nota crava a **nota clicada** na linha da grade mais próxima (as outras selecionadas andam
  o mesmo tanto), e as setas ←/→ vão para a próxima linha, não "+1 passo" (uma nota gravada
  fora do tempo cai na grade).

### Dicas e barra de cima

- Os botões de janela da barra de título (`.tb-wins .wbtn`) são só ícones: ligado = ícone na cor de destaque.
- Visual: botões ligados (`button.on`, PAT/SONG, steps, solo, mute, rec, play) usam cor
  **chapada** (a de destaque do tema, ou verde/vermelho de estado), sem degradê nem brilho
  em cima — pedido do usuário; não reintroduzir `linear-gradient` nesses estados.

- `data-hint` (ou `setHint` de canvas) alimenta a barra de dicas (`HintBar`) ou, com
  Aparência → **Dicas em balão** (`prefs.tooltips` em theme.ts), o `HintTooltip`
  (Toolbar.tsx, montado em main.tsx): balão acima do mouse depois de 750 ms parado,
  some ao clicar/rolar. Sobre a playlist (`.pl-canvas`, onde o mouse fica quase sempre) a
  dica fica parada no canto inferior direito (`.hint-corner`), sem seguir o mouse. No modo
  balão a barra fica: transporte + master/swing/visualizador no centro (mesma ordem),
  pattern/desfazer/salvar à direita (`.toolbar.tips .tb-side`).
- Arquivo → Abrir (Ctrl+O) e Salvar como usam o explorador de arquivos do sistema no app
  desktop (`mlabsWindow.openDialog/saveDialog` → `dialog:open/save` em main.cjs); no
  navegador, `<input type=file>` → `POST /api/import` (cópia em Importados) → `/api/open`.
- Lista de patterns (Picker.tsx): duplo clique abre o pattern no rack; botão direito:
  abrir, renomear, clonar, excluir. O nome do pattern no título do rack é um campo
  (`.title-edit`, com cara de texto apagado): editar renomeia o pattern.
- Navegador recolhido é lembrado (`browser.open` nas prefs, gravado em `emit()`).

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
- **Bateria baixa derruba a CPU para 400 MHz** (governor powersave, máx. 3,9 GHz): tudo
  fica ~10× mais lento e o áudio picota/morre. Antes de caçar problema de desempenho,
  olhar `/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq` e a bateria.
- **Pendência de hardware**: o microfone do headset (Fallen Quartz, plugue P2 de 4 polos,
  cabo HyperX) **não é detectado** pelo driver (`Mic Jack: off`; teste de batidinha
  confirmou que só o microfone interno chega). Sugestões dadas ao usuário: testar
  `options snd-hda-intel model=aspire-headset-mic` em `/etc/modprobe.d/headset-mic.conf`
  + reboot (desfazer apagando o arquivo), ou usar uma placa de som USB. O volume de
  captura do sistema foi subido para 70% durante os testes.
- **Vazamento do fone na gravação**: guitarra (cabo P10→P2) e fone ficam no mesmo
  conector combo do notebook (`Mic Jack: on`, porta `analog-input-mic`). O terra
  compartilhado do P2 de 4 polos faz o som do fone (metrônomo, música, retorno) vazar
  para a entrada — é diafonia de hardware, não do app. Solução real: interface/placa
  USB (entrada e saída separadas) ou ouvir por outra saída (Bluetooth/HDMI).
- Retorno nativo: `stopMonitor` fecha a entrada, manda SIGTERM e SIGKILL após 400 ms
  (o pw-play ignorava SIGINT e sobravam vários retornos tocando juntos);
  `sweepOrphans` mata, no primeiro início, os `musiclabs-retorno` de servidores antigos.

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
