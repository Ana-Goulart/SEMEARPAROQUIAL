# Instrucoes Do Projeto EJC

Padrao de botoes:

- Todo `btn` deve ter icone e texto
- O icone deve ser consistente com a acao em todas as telas do projeto
- Para a mesma acao, use sempre o mesmo icone
- Exemplo: a acao "Novo" deve usar sempre o icone `+` acompanhado do texto
- Exemplo: acoes de exportacao, importacao, edicao, exclusao e filtro tambem devem manter sempre o mesmo icone correspondente em todo o projeto

Padrao mobile-first para botoes:

- Em implementacoes mobile-first, no layout base de telas pequenas, os botoes devem exibir apenas o icone
- O texto do botao deve aparecer nas versoes para telas maiores, seguindo a expansao progressiva da interface
- Ao adaptar componentes existentes, trate mobile como base e desktop como complemento visual

Padrao para menus:

- Todos os menus do projeto EJC devem usar icones visuais junto ao texto
- Nao use emoji em menus
- Prefira icones consistentes da biblioteca visual ja usada pelo projeto
- O mesmo item de menu deve manter o mesmo icone em todas as telas onde aparecer
- A cor dos icones dos menus deve seguir a paleta oficial do sistema
- Evite cores aleatorias nos icones de menu; use as variaveis e tons ja definidos no tema do projeto

Padrao para grids e tabelas:

- Todos os grids e tabelas do projeto EJC devem seguir abordagem mobile-first
- Ao definir estrutura responsiva, considere primeiro telas pequenas e depois expanda para `sm`, `md`, `lg` e tamanhos maiores
- Em telas menores, exiba apenas as colunas principais e oculte as colunas menos prioritarias
- As colunas menos prioritarias devem continuar acessiveis por meio de um botao para expandir a linha
- A linha expandida deve mostrar todas as informacoes relevantes que ficaram ocultas no modo compacto
- O botao de expandir deve ser claro, consistente entre telas e usar icone apropriado sem depender de emoji
- Ao projetar prioridade de colunas, privilegie leitura rapida, identificacao do registro e acoes principais
