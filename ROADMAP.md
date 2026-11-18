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

- Hospedar plugins VST/LV2/CLAP (ponte via Carla/yabridge).
- Automação (clips de automação na playlist).
- Clips de áudio na playlist e gravação.
