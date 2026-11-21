# Roadmap e ideias anotadas

## Anotado em 18/11/2026

- **Troca de sample em instrumentos multi-sample (zonas).** Hoje cada tecla usa o
  sample gravado mais próximo e a divisão entre dois samples fica no meio do
  caminho entre as notas raiz deles; dentro da zona, o sample é reamostrado
  (pitch shifting tradicional). A ideia é poder escolher onde um sample para de
  ser esticado e o próximo assume:
  - pontos de divisão arrastáveis num teclado (editor de zonas);
  - limite de transposição por sample (ex.: no máximo ±2 semitons);
  - crossfade opcional entre zonas vizinhas para esconder a troca;
  - edição das camadas de velocity.
  Antes de implementar, estudar com calma como samplers profissionais tratam isso.

## Anotado em 19/11/2026

- **Editor de áudio ("sampler" de clipe).** Duplo clique num clipe de áudio da playlist
  abre o áudio numa janela própria, como o duplo clique num pattern abre o pattern e numa
  automação abre a Central. Ideia: coisa simples, não um editor completo — forma de onda,
  trecho (início/fim, fades), **mudar o tom** da gravação (semitons/cents, mantendo ou
  não o andamento), volume/normalizar, inverter, e uns **efeitos básicos** (EQ, filtro,
  reverb, delay, saturação) aplicados de forma não destrutiva: o original fica guardado
  e as edições podem ser desligadas (mesmo esquema da lista de áudios / Melodify).
  Enquanto não existe, o duplo clique no áudio abre o Melodify. (Hoje "sampler" no app é
  um tipo de canal de instrumento que toca um sample pelas notas — outra coisa.)

## Anotado em 20/11/2026

- **Áudios acompanham o BPM (time-stretch sem mudar o tom).** Ao mudar o BPM do projeto,
  os clipes de áudio devem tocar mais rápido ou mais devagar na mesma proporção, **sem
  mudar o tom**. Visualmente nada muda: o clipe continua do mesmo tamanho na playlist
  (mesmos compassos) e só a agulha anda mais rápido ou mais devagar. A experiência é a
  de um áudio "preso à grade" (como o clipe com stretch ligado no FL Studio).
  Hoje é o contrário: o clipe toca na velocidade original e o BPM novo só muda o
  tamanho dele em ticks (`applyTempo` em `core/studio.ts` mantém a duração em segundos;
  `Engine.mixClip` lê o arquivo em tempo real). Pontos a decidir quando for feito:
  - como esticar: em tempo real na engine (usa `PitchShifter`/`psola.ts` ou um
    time-stretch por fase, ex. WSOLA/phase vocoder) ou pré-renderizar o clipe esticado
    em segundo plano (mesmo esquema do reamp: toca o original enquanto refaz);
  - guardar a razão no clipe (BPM de origem do áudio, ex. o detectado pelo botão BPM do
    Melodify) para esticar sempre a partir do arquivo original e não acumular perda;
  - opção por clipe para ligar/desligar o stretch (um áudio de efeito ou um sample
    de percussão talvez deva continuar tocando na velocidade original);
  - o botão BPM do Melodify e o MCP (`detect_bpm`/`set_tempo`) passam a só alinhar à grade
    e definir o BPM de origem do áudio, em vez de redimensionar os clipes;
  - automação de BPM: o stretch teria de seguir a curva ao longo do clipe.

- **Botões de janela na barra de título como ícones puros.** Os botões que ligam a
  playlist, o rack, o piano roll, o mixer, o amp, o Melodify, o Stitcher e o navegador
  (ao lado do "MCP") passam a ser só ícones, sem caixa de fundo. Quando a janela está
  aberta/selecionada, a **cor do ícone** (foreground) vira a cor de destaque, e não o
  fundo do botão; fechada, o ícone fica na cor normal (branco/cinza). Hoje
  (`TitleBar` em Toolbar.tsx, classe `.wbtn.on`) o estado "ligado" pinta o fundo.
- **Menu da barra de título recolhido (ideia, a avaliar).** Deixar só "Arquivo" no canto
  superior esquerdo, com uma setinha indicando que expande; ao passar o mouse em cima,
  abre a lista com Arquivo, Editar, Adicionar, Patterns, Exibir, Aparência, Opções,
  Ferramentas e Ajuda. Objetivo: ocupar menos espaço em cima e deixar o design mais
  limpo. A decidir: o que abre no hover e o que abre no clique (para não abrir sem querer
  quando o mouse só passa por ali), e como fica o atalho por teclado dos menus.

## Pendências maiores

- Hospedar plugins VST/LV2/CLAP (ponte via Carla/yabridge). Em espera: decidir
  depois como tratar plugins e compatibilidade com código de máquina em geral.
  Notas para quando voltar ao assunto:
  - os plugins nativos do FL (Sytrus, Harmor, Gross Beat, Fruity…) usam o formato
    interno do FL e não abrem fora dele;
  - caminho possível: carregar o `FL Studio VSTi` / `FL Studio VSTi (Multi)`
    (VST2 que acompanha o FL, em `Common Files/VST2` no Wine) pelo Carla +
    yabridge, com saídas separadas indo para inserts do Music Labs;
  - alguns plugins da Image-Line existem como VST avulso (instalador próprio);
  - dependências no Linux: `carla`, `pipewire-jack` e yabridge;
  - limitações esperadas: estabilidade/latência do Wine, só Linux no começo,
    exportação offline sem os plugins.

## Plugins nativos e marketplace (ideia, a planejar)

Objetivo: tornar o Music Labs extensível por plugins próprios, simples de criar,
e tratar as ferramentas atuais como os primeiros plugins.

- **Plugins são repositórios open source no GitHub.** Instalar um plugin = clonar
  ou baixar um release de um repositório. Um "marketplace" dentro do app lista,
  busca, instala, atualiza e remove plugins (catálogo pode ser um índice público
  de repositórios, ou busca por tópico no GitHub, ex.: `music-labs-plugin`).
- **API de plugins limpa, abstraída e robusta**, para que seja fácil escrever um
  plugin do zero. Pontos a definir:
  - manifesto (nome, versão, tipo, versão mínima da API, permissões);
  - tipos: instrumento, efeito, ferramenta/janela (ex.: um gerador de padrões),
    analisador, importador/exportador;
  - DSP: interface de processamento por bloco (`noteOn/noteOff/render`,
    `process`), parâmetros declarados (já existe `ParamDef` em
    `src/core/registry.ts`) com automação, presets e estado salvos de graça;
  - interface: o plugin declara parâmetros e ganha UI automática (knobs, como o
    `ParamGrid`), ou fornece UI própria com componentes do app (knob, gráfico,
    teclado, canvas);
  - acesso ao projeto pela mesma camada de ações/ops (desfazer, sincronia, MCP
    funcionam sem esforço extra);
  - ferramentas expostas automaticamente no MCP, para o Claude usar o plugin;
  - versionamento estável da API e isolamento (o plugin não derruba o app;
    avaliar rodar em worker/sandbox e pedir permissões explícitas).
- **Converter tudo o que existe em plugins nativos**: Sampler, Prisma, Synth,
  Drum Synth, Pluck, FM e os efeitos passam a usar exatamente a mesma API pública
  (sem atalhos internos), cada um no seu repositório/pasta.
- **Copiar e modificar**: qualquer plugin pode ser usado como base ("fork" pelo
  próprio app) para criar outro; ex.: partir do Sampler para fazer algo novo,
  em vez de começar do zero. Ter um modelo mínimo (template) também.
- Documentação e exemplos curtos para cada tipo de plugin.
