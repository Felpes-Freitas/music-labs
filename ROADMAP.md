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
