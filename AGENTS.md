# Instrucoes Gerais Do Workspace

Este workspace contem varios projetos relacionados. Sempre interprete os diretorios abaixo desta forma, independentemente do contexto atual da conversa:

- `/SemearParoquial/SemearCore`: projeto core
- `/SemearParoquial/SemearJovens`: projeto EJC
- `/SemearParoquial/SemearAdmin`: projeto admin
- `/SemearParoquial/SemearCatequese`: projeto de catequese
- `/SemearParoquial/SemearLogin`: projeto de login responsavel por acessar os modulos

Regras de interpretacao:

- Quando o usuario mencionar "core", considere `SemearCore`
- Quando o usuario mencionar "ejc", considere `SemearJovens`
- Quando o usuario mencionar "admin", considere `SemearAdmin`
- Quando o usuario mencionar "catequese", considere `SemearCatequese`
- Quando o usuario mencionar "login", considere `SemearLogin`
- Se houver ambiguidade, use esse mapeamento como padrao antes de assumir qualquer outra pasta

Padrao geral para frontend:

- Em todos os projetos deste workspace, qualquer tarefa de frontend deve seguir a abordagem mobile-first como padrao
- Comece layouts, estilos e componentes pela experiencia em telas menores e depois expanda para tablet e desktop
- Ao implementar responsividade, trate mobile como base e use breakpoints progressivos para telas maiores
